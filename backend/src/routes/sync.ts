import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { fetchActivities, fetchActivityLaps, upsertActivities } from "../services/strava.js";
import { db, schema } from "../db/index.js";
import { eq, desc, count, and } from "drizzle-orm";

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

// POST /sync/laps — bulk sync laps for interval sessions
router.post("/laps", requireAuth, async (req, res) => {
  const userId = (req as any).userId as number;

  const needsLaps = db
    .select({ id: schema.activities.id })
    .from(schema.activities)
    .where(
      and(
        eq(schema.activities.userId, userId),
        eq(schema.activities.lapsSynced, 0),
        eq(schema.activities.sessionType, "interval")
      )
    )
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
