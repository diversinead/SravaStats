import { sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey(), // Strava athlete ID
  username: text("username"),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  tokenExpiresAt: integer("token_expires_at").notNull(),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

export const activities = sqliteTable("activities", {
  id: integer("id").primaryKey(), // Strava activity ID
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  sportType: text("sport_type"),
  startDate: text("start_date").notNull(), // ISO 8601 (UTC)
  startDateLocal: text("start_date_local"), // ISO 8601 (athlete's local time)
  elapsedTime: integer("elapsed_time"), // seconds
  movingTime: integer("moving_time"), // seconds
  distance: real("distance"), // meters
  totalElevationGain: real("total_elevation_gain"),
  averageSpeed: real("average_speed"), // m/s
  averageHeartrate: real("average_heartrate"),
  maxHeartrate: real("max_heartrate"),
  averageCadence: real("average_cadence"),
  sufferScore: integer("suffer_score"),
  trainingCategory: text("training_category"), // user-defined: e.g. "Easy Run", "Threshold", "Track Workout"
  workoutType: integer("workout_type"), // Strava: 0=default, 1=race, 2=long run, 3=workout (runs); 10=default, 11=race, 12=workout (rides)
  timezone: text("timezone"), // e.g. "(GMT+00:00) Europe/London"
  startLatlng: text("start_latlng"), // JSON [lat, lng]]
  dayOfWeek: text("day_of_week"),        // 'Monday', 'Tuesday' etc — computed on insert
  sessionType: text("session_type"),     // 'interval', 'easy', 'tempo', 'race', 'long'
  polyline: text("polyline"),            // encoded polyline from rawJson for maps
  garminActivityId: integer("garmin_activity_id"), // link to Garmin
  lapsSynced: integer("laps_synced").default(0),   // flag: 0=no, 1=yes (for bulk sync)
  rawJson: text("raw_json"), // full Strava response
  syncedAt: text("synced_at").default(sql`(datetime('now'))`),
});

export const laps = sqliteTable(
  "laps",
  {
    id: integer("id").primaryKey(), // Strava lap ID
    activityId: integer("activity_id")
      .notNull()
      .references(() => activities.id, { onDelete: "cascade" }),
    lapIndex: integer("lap_index").notNull(),
    name: text("name").notNull(), // Strava default name (e.g. "Lap 1")
    customName: text("custom_name"), // user-editable name (e.g. "400m rep")
    distance: real("distance"),
    movingTime: integer("moving_time"),
    elapsedTime: integer("elapsed_time"),
    averageSpeed: real("average_speed"),
    averageHeartrate: real("average_heartrate"),
    maxHeartrate: real("max_heartrate"),
    averageCadence: real("average_cadence"),
    totalElevationGain: real("total_elevation_gain"),
    syncedAt: text("synced_at").default(sql`(datetime('now'))`),
    lapType: text("lap_type"),   // 'active' or 'rest' — for interval detection
    startLat: real("start_lat"),
    startLng: real("start_lng"),
  },
  (table) => [uniqueIndex("idx_laps_activity_index").on(table.activityId, table.lapIndex)]
);

export const garminActivities = sqliteTable("garmin_activities", {
  id: integer("id").primaryKey(),           // Garmin activity ID
  activityId: integer("activity_id")
    .references(() => activities.id),       // linked Strava activity (nullable)
  userId: integer("user_id").notNull()
    .references(() => users.id),
  startTime: text("start_time").notNull(),
  name: text("name"),
  sportType: text("sport_type"),
  rawJson: text("raw_json"),
  lapsSynced: integer("laps_synced").default(0),
  syncedAt: text("synced_at").default(sql`(datetime('now'))`),
});

export const categoryRules = sqliteTable("category_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  category: text("category").notNull(), // training category to assign, e.g. "Easy Run"
  ruleType: text("rule_type").notNull(),
  ruleValue: text("rule_value").notNull(), // JSON
  priority: integer("priority").default(0),
  enabled: integer("enabled").default(1),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});
