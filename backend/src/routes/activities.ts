import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db, schema } from "../db/index.js";
import { eq, and, gte, lte, desc, asc, like, isNull, inArray, sql } from "drizzle-orm";
import { fetchActivityLaps } from "../services/strava.js";

const router = Router();

const SORT_COLUMNS = {
  date: schema.activities.startDate,
  name: schema.activities.name,
  type: schema.activities.trainingCategory,
  distance: schema.activities.distance,
  pace: schema.activities.averageSpeed,
  duration: schema.activities.movingTime,
  hr: schema.activities.averageHeartrate,
} as const;

// List activities with filtering and pagination
router.get("/", requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const sortOrder = req.query.order === "asc" ? asc : desc;
  const sortBy = (req.query.sort_by as string) || "date";
  const sortColumn = SORT_COLUMNS[sortBy as keyof typeof SORT_COLUMNS] || SORT_COLUMNS.date;

  const conditions = [eq(schema.activities.userId, userId)];

  if (req.query.sport_type) {
    conditions.push(eq(schema.activities.sportType, req.query.sport_type as string));
  }
  if (req.query.category) {
    if (req.query.category === "__uncategorised__") {
      conditions.push(isNull(schema.activities.trainingCategory));
    } else {
      conditions.push(eq(schema.activities.trainingCategory, req.query.category as string));
    }
  }
  if (req.query.from) {
    conditions.push(gte(schema.activities.startDate, req.query.from as string));
  }
  if (req.query.to) {
    conditions.push(lte(schema.activities.startDate, req.query.to as string));
  }
  if (req.query.search) {
    conditions.push(like(schema.activities.name, `%${req.query.search}%`));
  }

  const [{ total }] = db
    .select({ total: sql<number>`count(*)` })
    .from(schema.activities)
    .where(and(...conditions))
    .all();

  const activityRows = db
    .select()
    .from(schema.activities)
    .where(and(...conditions))
    .orderBy(sortOrder(sortColumn))
    .limit(limit)
    .offset(offset)
    .all();

  const activities = activityRows.map((a) => ({
    ...a,
    rawJson: undefined,
  }));

  res.json({ activities, page, total });
});

// Get single activity
router.get("/:id", requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const activityId = Number(req.params.id);

  const activity = db
    .select()
    .from(schema.activities)
    .where(and(eq(schema.activities.id, activityId), eq(schema.activities.userId, userId)))
    .get();

  if (!activity) {
    res.status(404).json({ error: "Activity not found" });
    return;
  }

  const { rawJson, ...rest } = activity;
  res.json(rest);
});

// Bulk update training category
router.post("/bulk-category", requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const { activityIds, trainingCategory } = req.body as {
    activityIds: number[];
    trainingCategory: string | null;
  };

  if (!activityIds?.length) {
    res.status(400).json({ error: "activityIds required" });
    return;
  }

  db.update(schema.activities)
    .set({ trainingCategory: trainingCategory || null })
    .where(
      and(
        eq(schema.activities.userId, userId),
        inArray(schema.activities.id, activityIds)
      )
    )
    .run();

  res.json({ updated: activityIds.length });
});

// Bulk update training category by filter criteria
router.post("/bulk-category-by-criteria", requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const { trainingCategory, filters } = req.body as {
    trainingCategory: string | null;
    filters: {
      name?: string;
      distanceMin?: number;
      distanceMax?: number;
      speedMin?: number;
      speedMax?: number;
    };
  };

  if (!filters || !trainingCategory) {
    res.status(400).json({ error: "trainingCategory and filters required" });
    return;
  }

  const conditions = [eq(schema.activities.userId, userId)];

  if (filters.name) {
    conditions.push(eq(schema.activities.name, filters.name));
  }
  if (filters.distanceMin != null) {
    conditions.push(gte(schema.activities.distance, filters.distanceMin));
  }
  if (filters.distanceMax != null) {
    conditions.push(lte(schema.activities.distance, filters.distanceMax));
  }
  if (filters.speedMin != null) {
    conditions.push(gte(schema.activities.averageSpeed, filters.speedMin));
  }
  if (filters.speedMax != null) {
    conditions.push(lte(schema.activities.averageSpeed, filters.speedMax));
  }

  const matching = db
    .select({ id: schema.activities.id })
    .from(schema.activities)
    .where(and(...conditions))
    .all();

  if (matching.length === 0) {
    res.json({ updated: 0, message: "No activities matched the criteria" });
    return;
  }

  db.update(schema.activities)
    .set({ trainingCategory: trainingCategory || null })
    .where(
      and(
        eq(schema.activities.userId, userId),
        inArray(schema.activities.id, matching.map((m) => m.id))
      )
    )
    .run();

  res.json({ updated: matching.length });
});

// Update activity fields (name, training category)
router.patch("/:id", requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const activityId = Number(req.params.id);
  const { trainingCategory, name } = req.body as { trainingCategory?: string | null; name?: string };

  const activity = db
    .select({ id: schema.activities.id })
    .from(schema.activities)
    .where(and(eq(schema.activities.id, activityId), eq(schema.activities.userId, userId)))
    .get();

  if (!activity) {
    res.status(404).json({ error: "Activity not found" });
    return;
  }

  const updates: Record<string, any> = {};
  if (trainingCategory !== undefined) updates.trainingCategory = trainingCategory || null;
  if (name !== undefined && name.trim()) updates.name = name.trim();

  if (Object.keys(updates).length > 0) {
    db.update(schema.activities)
      .set(updates)
      .where(eq(schema.activities.id, activityId))
      .run();
  }

  res.json({ ok: true, ...updates });
});

// Get laps for an activity (synced from Strava on first access, then served from DB)
router.get("/:id/laps", requireAuth, async (req, res) => {
  const userId = (req as any).userId as number;
  const activityId = Number(req.params.id);

  const activity = db
    .select({ id: schema.activities.id })
    .from(schema.activities)
    .where(and(eq(schema.activities.id, activityId), eq(schema.activities.userId, userId)))
    .get();

  if (!activity) {
    res.status(404).json({ error: "Activity not found" });
    return;
  }

  let laps = db
    .select()
    .from(schema.laps)
    .where(eq(schema.laps.activityId, activityId))
    .orderBy(asc(schema.laps.lapIndex))
    .all();

  if (laps.length === 0) {
    try {
      const stravaLaps = await fetchActivityLaps(userId, activityId);
      for (const sl of stravaLaps) {
        db.insert(schema.laps)
          .values({
            id: sl.id,
            activityId,
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
      laps = db
        .select()
        .from(schema.laps)
        .where(eq(schema.laps.activityId, activityId))
        .orderBy(asc(schema.laps.lapIndex))
        .all();
    } catch (e: any) {
      res.status(502).json({ error: e.message });
      return;
    }
  }

  res.json(laps);
});

// Rename a lap
router.patch("/:id/laps/:lapId", requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const activityId = Number(req.params.id);
  const lapId = Number(req.params.lapId);
  const { customName } = req.body as { customName: string | null };

  const activity = db
    .select({ id: schema.activities.id })
    .from(schema.activities)
    .where(and(eq(schema.activities.id, activityId), eq(schema.activities.userId, userId)))
    .get();

  if (!activity) {
    res.status(404).json({ error: "Activity not found" });
    return;
  }

  db.update(schema.laps)
    .set({ customName: customName || null })
    .where(and(eq(schema.laps.id, lapId), eq(schema.laps.activityId, activityId)))
    .run();

  const updated = db
    .select()
    .from(schema.laps)
    .where(eq(schema.laps.id, lapId))
    .get();

  res.json(updated);
});

export default router;
