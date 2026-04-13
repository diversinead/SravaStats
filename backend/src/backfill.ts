/**
 * backfill.ts — re-run to reclassify all activities using trainingCategory
 * as the primary source, falling back to name/workout_type keywords.
 * Safe to run multiple times. Never touches name or trainingCategory.
 *
 * Run from backend/ folder:
 *   npx tsx src/backfill.ts
 */

import { db, schema } from "./db/index.js";
import { eq } from "drizzle-orm";

function classifySession(raw: any, trainingCategory: string | null): string {
  const cat = (trainingCategory ?? "").toLowerCase();

  // Primary: use trainingCategory
  if (cat.includes("easy") || cat.includes("recovery") || cat.includes("heat")) return "easy";
  if (cat.includes("long") || cat.includes("marathon")) return "long";
  if (cat.includes("threshold") || cat.includes("tempo")) return "threshold";
  if (cat.includes("track") || cat.includes("road workout") || cat.includes("gravel")) return "interval";
  if (cat.includes("wu") || cat.includes("cd") || cat.includes("strides")) return "warmup";
  if (cat.includes("cross")) return "crosstraining";
  if (cat.includes("race")) return "race";
  if (cat.includes("tempo")) return "tempo";

  // Fallback: use Strava workout_type
  if (raw.workout_type === 1) return "race";
  if (raw.workout_type === 2) return "long";
  if (raw.workout_type === 3) return "interval";

  // Fallback: name keywords
  const name = (raw.name ?? "").toLowerCase();
  if (/\d+\s*x\s*\d+/.test(name)) return "interval"; // matches "8 x 1k", "10 x 400" etc
  if (/interval|rep|track|speed|threshold|fartlek|tempo/.test(name)) return "interval";
  if (/long|lsd|ferny|b&b/.test(name)) return "long";
  if (/easy|recovery|jog|dbl|rec run/.test(name)) return "easy";
  if (/elliptical|bike|ride|swim/.test(name)) return "crosstraining";
  if (/warm.?up|cool.?down|wu|cd|strides/.test(name)) return "warmup";

  return "default";
}

const rows = db
  .select({
    id: schema.activities.id,
    rawJson: schema.activities.rawJson,
    trainingCategory: schema.activities.trainingCategory,
  })
  .from(schema.activities)
  .all();

console.log(`Backfilling ${rows.length} activities...`);

let updated = 0;
let skipped = 0;

for (const row of rows) {
  if (!row.rawJson) {
    skipped++;
    continue;
  }

  try {
    const raw = JSON.parse(row.rawJson);

    const dayOfWeek = new Date(raw.start_date).toLocaleDateString("en-AU", {
      weekday: "long",
    });
    const sessionType = classifySession(raw, row.trainingCategory);
    const polyline = raw.map?.summary_polyline ?? null;

    db.update(schema.activities)
      .set({ dayOfWeek, sessionType, polyline })
      .where(eq(schema.activities.id, row.id))
      .run();

    updated++;
  } catch {
    console.warn(`Skipped activity ${row.id} — invalid rawJson`);
    skipped++;
  }
}

console.log(`Done. Updated: ${updated}, Skipped: ${skipped}`);

// Print summary of classifications
const summary = db
  .select({
    sessionType: schema.activities.sessionType,
  })
  .from(schema.activities)
  .all()
  .reduce((acc: Record<string, number>, row) => {
    const key = row.sessionType ?? "null";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

console.log("\nClassification summary:");
Object.entries(summary)
  .sort((a, b) => b[1] - a[1])
  .forEach(([type, count]) => console.log(`  ${type}: ${count}`));