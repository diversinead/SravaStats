import { db, schema } from "../db/index.js";
import { eq, and } from "drizzle-orm";

interface RuleValue {
  day?: number;
  pattern?: string;
  sport?: string;
  from?: string;
  to?: string;
  minSeconds?: number;
  maxSeconds?: number;
  minMeters?: number;
  maxMeters?: number;
  minSpeedMs?: number;
  maxSpeedMs?: number;
  workoutType?: number;
  timezone?: string;
}

type Activity = typeof schema.activities.$inferSelect;

export function matchesRule(
  activity: Activity,
  ruleType: string,
  ruleValue: string
): boolean {
  const val: RuleValue = JSON.parse(ruleValue);

  switch (ruleType) {
    case "day_of_week": {
      const dateStr = activity.startDateLocal || activity.startDate;
      const date = new Date(dateStr);
      const day = activity.startDateLocal ? date.getDay() : date.getUTCDay();
      return day === val.day;
    }

    case "name_contains":
      return val.pattern
        ? activity.name.toLowerCase().includes(val.pattern.toLowerCase())
        : false;

    case "sport_type":
      return activity.sportType === val.sport;

    case "date_range": {
      const actDate = (activity.startDateLocal || activity.startDate).slice(0, 10);
      if (val.from && actDate < val.from) return false;
      if (val.to && actDate > val.to) return false;
      return true;
    }

    case "duration_range": {
      const moving = activity.movingTime;
      if (moving == null) return false;
      if (val.minSeconds != null && moving < val.minSeconds) return false;
      if (val.maxSeconds != null && moving > val.maxSeconds) return false;
      return true;
    }

    case "distance_range": {
      const dist = activity.distance;
      if (dist == null) return false;
      if (val.minMeters != null && dist < val.minMeters) return false;
      if (val.maxMeters != null && dist > val.maxMeters) return false;
      return true;
    }

    case "pace_range": {
      const speed = activity.averageSpeed;
      if (speed == null) return false;
      if (val.minSpeedMs != null && speed < val.minSpeedMs) return false;
      if (val.maxSpeedMs != null && speed > val.maxSpeedMs) return false;
      return true;
    }

    case "workout_type":
      return activity.workoutType === val.workoutType;

    case "location":
      return val.timezone
        ? (activity.timezone || "").toLowerCase().includes(val.timezone.toLowerCase())
        : false;

    default:
      return false;
  }
}

export function applyRulesToActivities(userId: number) {
  const rules = db
    .select()
    .from(schema.categoryRules)
    .where(
      and(
        eq(schema.categoryRules.userId, userId),
        eq(schema.categoryRules.enabled, 1)
      )
    )
    .orderBy(schema.categoryRules.priority)
    .all();

  const activities = db
    .select()
    .from(schema.activities)
    .where(eq(schema.activities.userId, userId))
    .all();

  let applied = 0;

  for (const activity of activities) {
    for (const rule of rules) {
      if (matchesRule(activity, rule.ruleType, rule.ruleValue)) {
        // Only set category if not already set (don't overwrite manual choices)
        if (!activity.trainingCategory) {
          db.update(schema.activities)
            .set({ trainingCategory: rule.category })
            .where(eq(schema.activities.id, activity.id))
            .run();
          applied++;
        }
        break; // first matching rule wins (by priority)
      }
    }
  }

  return applied;
}

export function applySingleRule(userId: number, ruleId: number) {
  const rule = db
    .select()
    .from(schema.categoryRules)
    .where(
      and(
        eq(schema.categoryRules.id, ruleId),
        eq(schema.categoryRules.userId, userId)
      )
    )
    .get();

  if (!rule) return null;

  const activities = db
    .select()
    .from(schema.activities)
    .where(eq(schema.activities.userId, userId))
    .all();

  let applied = 0;

  for (const activity of activities) {
    if (matchesRule(activity, rule.ruleType, rule.ruleValue)) {
      if (activity.trainingCategory !== rule.category) {
        db.update(schema.activities)
          .set({ trainingCategory: rule.category })
          .where(eq(schema.activities.id, activity.id))
          .run();
        applied++;
      }
    }
  }

  return applied;
}

export function previewRule(
  userId: number,
  ruleType: string,
  ruleValue: string
): Activity[] {
  const activities = db
    .select()
    .from(schema.activities)
    .where(eq(schema.activities.userId, userId))
    .all();

  return activities.filter((a) => matchesRule(a, ruleType, ruleValue));
}
