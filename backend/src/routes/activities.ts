import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db, schema } from "../db/index.js";
import { eq, and, or, gte, lte, desc, asc, like, isNull, inArray, sql } from "drizzle-orm";
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
  const categoryCond = buildCategoryCondition(req.query.category);
  if (categoryCond) conditions.push(categoryCond);
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

  // Pull laps for just the current page so the merged Activities table can
  // render the rep-summary column without a second round-trip per row.
  const pageIds = activityRows.map((a) => a.id);
  const lapRows = pageIds.length
    ? db
        .select()
        .from(schema.laps)
        .where(inArray(schema.laps.activityId, pageIds))
        .orderBy(asc(schema.laps.lapIndex))
        .all()
    : [];
  const lapsByActivity: Record<number, typeof lapRows> = {};
  for (const lap of lapRows) {
    (lapsByActivity[lap.activityId] ||= []).push(lap);
  }

  const activities = activityRows.map((a) => ({
    ...a,
    rawJson: undefined,
    repStructure: parseRepStructure(a.repStructure),
    laps: lapsByActivity[a.id] ?? [],
  }));

  res.json({ activities, page, total });
});

// Defensive JSON parse — if the column ever holds malformed data we return
// null rather than 500ing the whole list endpoint.
function parseRepStructure(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Accept ?category=A&category=B (or a single string). "__uncategorised__"
// entries expand to IS NULL and can be mixed with real categories.
function buildCategoryCondition(raw: unknown) {
  if (raw == null) return null;
  const values = Array.isArray(raw)
    ? (raw as string[])
    : [raw as string];
  if (values.length === 0) return null;
  const named = values.filter((v) => v && v !== "__uncategorised__");
  const uncat = values.includes("__uncategorised__");
  const clauses = [] as any[];
  if (named.length === 1) clauses.push(eq(schema.activities.trainingCategory, named[0]));
  else if (named.length > 1) clauses.push(inArray(schema.activities.trainingCategory, named));
  if (uncat) clauses.push(isNull(schema.activities.trainingCategory));
  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : or(...clauses);
}

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

  const { rawJson, repStructure, ...rest } = activity;
  res.json({
    ...rest,
    repStructure: parseRepStructure(repStructure),
  });
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

// Bulk update rep structure for a specific list of activities
router.post("/bulk-structure", requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const { activityIds, repStructure } = req.body as {
    activityIds: number[];
    repStructure: {
      mode: "time" | "distance";
      reps: number;
      repSize: number;
      recSec: number;
    } | null;
  };

  if (!activityIds?.length) {
    res.status(400).json({ error: "activityIds required" });
    return;
  }

  db.update(schema.activities)
    .set({ repStructure: repStructure ? JSON.stringify(repStructure) : null })
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

// Update activity fields (name, training category, rep structure)
router.patch("/:id", requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const activityId = Number(req.params.id);
  const { trainingCategory, name, repStructure } = req.body as {
    trainingCategory?: string | null;
    name?: string;
    // RepStructure object or null to clear
    repStructure?: {
      mode: "time" | "distance";
      reps: number;
      repSize: number;
      recSec: number;
    } | null;
  };

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
  if (repStructure !== undefined) {
    updates.repStructure = repStructure ? JSON.stringify(repStructure) : null;
  }

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
