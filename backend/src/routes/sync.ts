import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  fetchActivities,
  fetchActivityDetail,
  fetchActivityLaps,
  upsertActivities,
} from "../services/strava.js";
import { db, schema } from "../db/index.js";
import { eq, desc, count, and, inArray } from "drizzle-orm";

// Default session types to bulk-sync laps for. Lap data is most meaningful
// for these (structured workouts + races where the athlete cares about the
// per-rep / per-km splits). Easy and long can be added by passing
// ?types=easy,long or ?types=all on the request.
const DEFAULT_LAP_SYNC_TYPES = ["interval", "threshold", "race"];

const router = Router();

// Sync activities from Strava
router.post("/", requireAuth, async (req, res) => {
  const userId = (req as any).userId as number;

  try {
    // Incremental: only fetch activities newer than the latest one we have
    const latest = db
      .select({ startDate: schema.activities.startDate })
      .from(schema.activities)
      .where(eq(schema.activities.userId, userId))
      .orderBy(desc(schema.activities.startDate))
      .limit(1)
      .get();

    const after = latest?.startDate
      ? Math.floor(new Date(latest.startDate).getTime() / 1000)
      : undefined;

    let page = 1;
    let totalSynced = 0;
    while (true) {
      const activities = await fetchActivities(userId, page, 100, after);
      if (activities.length === 0) break;
      totalSynced += upsertActivities(userId, activities);
      if (activities.length < 100) break;
      page++;
    }

    res.json({ synced: totalSynced });
  } catch (err) {
    console.error("Sync error:", err);
    res.status(500).json({ error: "sync_failed" });
  }
});

// POST /sync/laps — bulk sync laps for structured sessions.
// Query params:
//   ?types=interval,threshold,race  — comma-separated session types to sync
//                                     (default: interval, threshold, race)
//   ?types=all                      — sync laps for every session type
router.post("/laps", requireAuth, async (req, res) => {
  const userId = (req as any).userId as number;

  const typesParam = (req.query.types as string | undefined)?.trim();
  const types =
    !typesParam
      ? DEFAULT_LAP_SYNC_TYPES
      : typesParam === "all"
        ? null // null = no sessionType filter
        : typesParam
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

  const conditions = [
    eq(schema.activities.userId, userId),
    eq(schema.activities.lapsSynced, 0),
  ];
  if (types) {
    conditions.push(inArray(schema.activities.sessionType, types));
  }

  const needsLaps = db
    .select({ id: schema.activities.id })
    .from(schema.activities)
    .where(and(...conditions))
    .all();

  let synced = 0;
  let failed = 0;

  for (const act of needsLaps) {
    try {
      const stravaLaps = await fetchActivityLaps(userId, act.id);
      for (const sl of stravaLaps) {
        db.insert(schema.laps)
          .values({
            id: sl.id,
            activityId: act.id,
            lapIndex: sl.lap_index,
            name: sl.name,
            distance: sl.distance,
            movingTime: sl.moving_time,
            elapsedTime: sl.elapsed_time,
            averageSpeed: sl.average_speed,
            averageHeartrate: sl.average_heartrate ?? null,
            maxHeartrate: sl.max_heartrate ?? null,
            averageCadence: sl.average_cadence ?? null,
            totalElevationGain: sl.total_elevation_gain,
          })
          .onConflictDoNothing()
          .run();
      }
      db.update(schema.activities)
        .set({ lapsSynced: 1 })
        .where(eq(schema.activities.id, act.id))
        .run();

      console.log(`Syncing laps for activity ${act.id} (${synced + 1}/${needsLaps.length})`);

      synced++;
    } catch (err) {
      console.error(`Failed to sync laps for activity ${act.id}:`, err);
      failed++;
    }
  }

  res.json({ synced, failed, total: needsLaps.length });
});

// POST /sync/laps/by-id  body: { activityIds: number[] }
// On-demand sync of laps for a specific list of activities. Used by the
// Compare modal to auto-pull lap data for sessions that haven't been bulk-
// synced yet, so the user doesn't have to wait for or even know about the
// bulk sync. Returns the freshly-fetched laps grouped by activityId so the
// caller can hydrate its in-memory state without a second roundtrip.
router.post("/laps/by-id", requireAuth, async (req, res) => {
  const userId = (req as any).userId as number;
  const { activityIds } = req.body as { activityIds?: number[] };

  if (!Array.isArray(activityIds) || activityIds.length === 0) {
    res.status(400).json({ error: "activityIds must be a non-empty array" });
    return;
  }

  // Look up sessionType per requested activity so we can decide between
  // user-laps (intervals) and per-km splits_metric (everything else). Also
  // doubles as ownership check — anything not owned by this user won't be
  // in the result.
  const owned = db
    .select({
      id: schema.activities.id,
      sessionType: schema.activities.sessionType,
      trainingCategory: schema.activities.trainingCategory,
    })
    .from(schema.activities)
    .where(
      and(
        eq(schema.activities.userId, userId),
        inArray(schema.activities.id, activityIds)
      )
    )
    .all();
  const ownedById = new Map(owned.map((a) => [a.id, a]));

  // Intervals pull user-pressed laps (rep boundaries matter for 400m / mile
  // repeats). Thresholds and everything else pull per-km splits_metric — the
  // km-by-km view is consistent across sessions and the Compare modal's
  // block detection derives rep boundaries from pace dips inside the splits.
  //
  // Use trainingCategory as the source of truth when set; fall back to
  // sessionType only for untagged activities. Before this guard, a session
  // tagged "Threshold" with a stale sessionType='interval' on the row (from
  // the old classifier) was still routed to the user-laps branch.
  const isStructuredReps = (meta: {
    sessionType: string | null;
    trainingCategory: string | null;
  }): boolean =>
    meta.trainingCategory
      ? meta.trainingCategory === "Intervals"
      : meta.sessionType === "interval";

  const lapsByActivity: Record<number, any[]> = {};
  let synced = 0;
  let failed = 0;
  const errors: { activityId: number; error: string }[] = [];

  for (const id of activityIds) {
    const meta = ownedById.get(id);
    if (!meta) {
      errors.push({ activityId: id, error: "not_owned" });
      failed++;
      continue;
    }
    try {
      if (isStructuredReps(meta)) {
        // Intervals & thresholds: user-pressed laps mark the rep boundaries
        // (classic 3×12min threshold, mile repeats, 400m reps, etc.). Pull
        // from the /laps endpoint.
        //
        // Clear any stale per-km split rows from an earlier sync — the
        // threshold branch used to default to splits_metric before the merge.
        // We only delete lapType='split' rows so user-laps with custom names
        // survive re-syncs.
        db.delete(schema.laps)
          .where(
            and(
              eq(schema.laps.activityId, id),
              eq(schema.laps.lapType, "split")
            )
          )
          .run();

        const stravaLaps = await fetchActivityLaps(userId, id);
        for (const sl of stravaLaps) {
          db.insert(schema.laps)
            .values({
              id: sl.id,
              activityId: id,
              lapIndex: sl.lap_index,
              name: sl.name,
              distance: sl.distance,
              movingTime: sl.moving_time,
              elapsedTime: sl.elapsed_time,
              averageSpeed: sl.average_speed,
              averageHeartrate: sl.average_heartrate ?? null,
              maxHeartrate: sl.max_heartrate ?? null,
              averageCadence: sl.average_cadence ?? null,
              totalElevationGain: sl.total_elevation_gain,
            })
            .onConflictDoNothing()
            .run();
        }
        db.update(schema.activities)
          .set({ lapsSynced: 1 })
          .where(eq(schema.activities.id, id))
          .run();

        const rows = db
          .select({
            activityId: schema.laps.activityId,
            lapIndex: schema.laps.lapIndex,
            name: schema.laps.name,
            customName: schema.laps.customName,
            distance: schema.laps.distance,
            movingTime: schema.laps.movingTime,
            averageSpeed: schema.laps.averageSpeed,
            averageHeartrate: schema.laps.averageHeartrate,
            maxHeartrate: schema.laps.maxHeartrate,
            averageCadence: schema.laps.averageCadence,
            lapType: schema.laps.lapType,
          })
          .from(schema.laps)
          .where(eq(schema.laps.activityId, id))
          .all();
        lapsByActivity[id] = rows;
      } else {
        // Non-interval (threshold, easy, long, race): use Strava's per-km
        // auto-splits from the activity DETAIL endpoint. These are present
        // even when the athlete didn't press the lap button — exactly what
        // we need for per-km comparison of continuous runs.
        const detail = await fetchActivityDetail(userId, id);
        const splits = detail.splits_metric ?? [];

        // Marking these as lapType='split' so we can tell them apart from
        // user-pressed laps later if we ever want both. Synthesizing the lap
        // primary key from activityId + split index so re-sync is idempotent.
        // Wipe any existing rows for this activity first so we don't end up
        // mixing the old single user-lap with fresh splits.
        db.delete(schema.laps)
          .where(eq(schema.laps.activityId, id))
          .run();

        for (const sp of splits) {
          db.insert(schema.laps)
            .values({
              id: id * 1000 + sp.split,
              activityId: id,
              lapIndex: sp.split,
              name: `Km ${sp.split}`,
              distance: sp.distance,
              movingTime: sp.moving_time,
              elapsedTime: sp.elapsed_time,
              averageSpeed: sp.average_speed,
              averageHeartrate: sp.average_heartrate ?? null,
              maxHeartrate: null,
              averageCadence: null,
              totalElevationGain: 0,
              lapType: "split",
            })
            .onConflictDoNothing()
            .run();
        }
        db.update(schema.activities)
          .set({ lapsSynced: 1 })
          .where(eq(schema.activities.id, id))
          .run();

        const rows = db
          .select({
            activityId: schema.laps.activityId,
            lapIndex: schema.laps.lapIndex,
            name: schema.laps.name,
            customName: schema.laps.customName,
            distance: schema.laps.distance,
            movingTime: schema.laps.movingTime,
            averageSpeed: schema.laps.averageSpeed,
            averageHeartrate: schema.laps.averageHeartrate,
            maxHeartrate: schema.laps.maxHeartrate,
            averageCadence: schema.laps.averageCadence,
            lapType: schema.laps.lapType,
          })
          .from(schema.laps)
          .where(eq(schema.laps.activityId, id))
          .all();
        lapsByActivity[id] = rows;
      }
      synced++;
    } catch (err: any) {
      console.error(`On-demand lap sync failed for activity ${id}:`, err);
      errors.push({
        activityId: id,
        error: err?.message ?? "fetch_failed",
      });
      failed++;
    }
  }

  res.json({ synced, failed, errors, lapsByActivity });
});

// Sync status
router.get("/status", requireAuth, (req, res) => {
  const userId = (req as any).userId as number;

  const latest = db
    .select({ syncedAt: schema.activities.syncedAt })
    .from(schema.activities)
    .where(eq(schema.activities.userId, userId))
    .orderBy(desc(schema.activities.syncedAt))
    .limit(1)
    .get();

  const [total] = db
    .select({ count: count() })
    .from(schema.activities)
    .where(eq(schema.activities.userId, userId))
    .all();

  res.json({
    lastSync: latest?.syncedAt ?? null,
    activityCount: total.count,
  });
});

export default router;
