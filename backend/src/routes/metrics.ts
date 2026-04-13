import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db, schema } from "../db/index.js";
import { eq, and, gte, lte, inArray, sql } from "drizzle-orm";

const router = Router();

// Aggregated metrics over time
router.get("/summary", requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const { from, to, group_by, category } = req.query as {
    from?: string;
    to?: string;
    group_by?: string;
    category?: string;
  };

  const groupBy = group_by === "month" ? "month" : "week";

  const conditions = [eq(schema.activities.userId, userId)];
  if (from) conditions.push(gte(schema.activities.startDate, from));
  if (to) conditions.push(lte(schema.activities.startDate, to));
  if (category) conditions.push(eq(schema.activities.trainingCategory, category));

  const groupExpr =
    groupBy === "month"
      ? sql<string>`strftime('%Y-%m', ${schema.activities.startDate})`
      : sql<string>`strftime('%Y-W%W', ${schema.activities.startDate})`;

  const periods = db
    .select({
      period: groupExpr.as("period"),
      count: sql<number>`count(*)`.as("count"),
      totalDistance: sql<number>`sum(${schema.activities.distance})`.as("total_distance"),
      totalMovingTime: sql<number>`sum(${schema.activities.movingTime})`.as("total_moving_time"),
      avgDistance: sql<number>`avg(${schema.activities.distance})`.as("avg_distance"),
      avgSpeed: sql<number>`avg(${schema.activities.averageSpeed})`.as("avg_speed"),
      avgHeartrate: sql<number>`avg(${schema.activities.averageHeartrate})`.as("avg_heartrate"),
      avgElevation: sql<number>`avg(${schema.activities.totalElevationGain})`.as("avg_elevation"),
    })
    .from(schema.activities)
    .where(and(...conditions))
    .groupBy(groupExpr)
    .orderBy(groupExpr)
    .all();

  res.json({ periods });
});

// Compare specific activities side by side
router.get("/compare", requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const idsParam = req.query.ids as string;

  if (!idsParam) {
    res.status(400).json({ error: "ids query parameter required" });
    return;
  }

  const ids = idsParam.split(",").map(Number).filter(Boolean);
  if (ids.length < 2) {
    res.status(400).json({ error: "At least 2 activity IDs required" });
    return;
  }

  const activities = db
    .select({
      id: schema.activities.id,
      name: schema.activities.name,
      sportType: schema.activities.sportType,
      startDate: schema.activities.startDate,
      distance: schema.activities.distance,
      movingTime: schema.activities.movingTime,
      elapsedTime: schema.activities.elapsedTime,
      averageSpeed: schema.activities.averageSpeed,
      averageHeartrate: schema.activities.averageHeartrate,
      maxHeartrate: schema.activities.maxHeartrate,
      averageCadence: schema.activities.averageCadence,
      totalElevationGain: schema.activities.totalElevationGain,
      sufferScore: schema.activities.sufferScore,
      trainingCategory: schema.activities.trainingCategory,
    })
    .from(schema.activities)
    .where(
      and(
        eq(schema.activities.userId, userId),
        inArray(schema.activities.id, ids)
      )
    )
    .all();

  res.json(activities);
});

export default router;
