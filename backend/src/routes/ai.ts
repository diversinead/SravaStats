import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db, schema } from "../db/index.js";
import { eq, desc, and, inArray, gte, lte } from "drizzle-orm";
import OpenAI from "openai";

const router = Router();

// Hard ceiling so a "show me everything since 2020" query can't melt the token
// budget. UI surfaces the count back to the user so they can narrow the range.
const MAX_ACTIVITIES = 500;

function buildActivityConditions(
  userId: number,
  opts: { categories?: string[]; from?: string; to?: string }
): any[] {
  const conditions: any[] = [eq(schema.activities.userId, userId)];

  if (opts.categories && opts.categories.length > 0) {
    conditions.push(
      inArray(schema.activities.trainingCategory, opts.categories)
    );
  }
  // Date range applied against startDateLocal (athlete's local date). The
  // YYYY-MM-DD prefix lexicographically compares correctly against the
  // ISO-8601 string stored in the column.
  if (opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from)) {
    conditions.push(gte(schema.activities.startDateLocal, opts.from));
  }
  if (opts.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to)) {
    conditions.push(
      lte(schema.activities.startDateLocal, nextDayIso(opts.to))
    );
  }
  return conditions;
}

function fetchActivitiesByConditions(conditions: any[]) {
  return db
    .select({
      id: schema.activities.id,
      name: schema.activities.name,
      sportType: schema.activities.sportType,
      sessionType: schema.activities.sessionType,
      trainingCategory: schema.activities.trainingCategory,
      dayOfWeek: schema.activities.dayOfWeek,
      startDateLocal: schema.activities.startDateLocal,
      distance: schema.activities.distance,
      movingTime: schema.activities.movingTime,
      averageSpeed: schema.activities.averageSpeed,
      averageHeartrate: schema.activities.averageHeartrate,
      maxHeartrate: schema.activities.maxHeartrate,
      averageCadence: schema.activities.averageCadence,
      totalElevationGain: schema.activities.totalElevationGain,
      sufferScore: schema.activities.sufferScore,
    })
    .from(schema.activities)
    .where(and(...conditions))
    .orderBy(desc(schema.activities.startDateLocal))
    .limit(MAX_ACTIVITIES)
    .all();
}

function fetchLapsByActivityIds(ids: number[]) {
  if (ids.length === 0) return {} as Record<number, any[]>;
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
    .where(inArray(schema.laps.activityId, ids))
    .all();
  const grouped: Record<number, typeof rows> = {};
  for (const lap of rows) {
    if (!grouped[lap.activityId]) grouped[lap.activityId] = [];
    grouped[lap.activityId].push(lap);
  }
  return grouped;
}

// POST /api/ai/activities  body: { categories?: string[]; from?: string; to?: string }
// Returns the user's filtered activities + their laps. No AI involvement —
// this is the data source for the table on the AI Coach page.
router.post("/activities", requireAuth, async (req, res) => {
  const userId = (req as any).userId as number;
  const { categories, from, to } = req.body as {
    categories?: string[];
    from?: string;
    to?: string;
  };

  try {
    const conditions = buildActivityConditions(userId, {
      categories,
      from,
      to,
    });

    const allMatching = db
      .select({ id: schema.activities.id })
      .from(schema.activities)
      .where(and(...conditions))
      .all();
    const totalMatching = allMatching.length;
    const truncated = totalMatching > MAX_ACTIVITIES;

    const activities = fetchActivitiesByConditions(conditions);
    const lapsByActivity = fetchLapsByActivityIds(activities.map((a) => a.id));
    const enriched = activities.map((a) => ({
      ...a,
      laps: lapsByActivity[a.id] ?? [],
    }));

    res.json({
      activities: enriched,
      totalMatching,
      truncated,
      maxActivities: MAX_ACTIVITIES,
      from: from ?? null,
      to: to ?? null,
      categories: categories ?? null,
    });
  } catch (err: any) {
    console.error("AI activities query error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/insights  body: { question, activityIds }
// Sends a specific set of activities (already chosen by the user via filters
// + selection) to OpenAI for a coaching insight. No filter extraction stage —
// the user picked the scope.
router.post("/insights", requireAuth, async (req, res) => {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const userId = (req as any).userId as number;
  const { question, activityIds } = req.body as {
    question: string;
    activityIds: number[];
  };

  if (!question?.trim()) {
    res.status(400).json({ error: "question is required" });
    return;
  }
  if (!Array.isArray(activityIds) || activityIds.length === 0) {
    res.status(400).json({ error: "activityIds must be a non-empty array" });
    return;
  }

  // Cap the set sent to OpenAI; surface to the caller so the UI can warn.
  const cappedIds = activityIds.slice(0, MAX_ACTIVITIES);
  const truncated = activityIds.length > MAX_ACTIVITIES;

  // Re-fetch from the DB. Important for security (verify userId owns these
  // activities) and to get fresh laps without trusting client-side data.
  const conditions = [
    eq(schema.activities.userId, userId),
    inArray(schema.activities.id, cappedIds),
  ];
  const activities = fetchActivitiesByConditions(conditions);
  const lapsByActivity = fetchLapsByActivityIds(activities.map((a) => a.id));
  const enriched = activities.map((a) => ({
    ...a,
    laps: lapsByActivity[a.id] ?? [],
  }));

  if (enriched.length === 0) {
    res
      .status(404)
      .json({ error: "no matching activities found for those ids" });
    return;
  }

  const systemPrompt = `You are an expert running coach AI analysing an athlete's training data.

Key data notes:
- Speed is stored in m/s. Convert to pace with: paceSecPerKm = 1000 / speed, then format as M:SS /km
- Distance is in metres. Convert to km by dividing by 1000.
- movingTime is in seconds. Convert to minutes/hours for display.
- dayOfWeek is the local day the session was performed.
- sessionType values: easy, long, interval, threshold, warmup, crosstraining, race
- trainingCategory is the athlete's own label (e.g. "Track Workout", "Easy Run", "Threshold")
- laps array contains per-rep / per-km data. lapType="split" means Strava's
  per-km auto-split (continuous threshold/easy/long); lapType=null means
  user-pressed lap (interval rep boundaries).

How to answer (IMPORTANT — the user has ALREADY filtered the activities
they care about via UI controls. They can also see the full per-session and
per-rep breakdown in a table directly below your answer):

- Give a HIGH-LEVEL SUMMARY only. Do NOT enumerate sessions one by one and
  do NOT list every rep with its pace/HR/distance — that detail is in the
  table.
- Focus on the question: counts, averages, ranges, trends, notable patterns,
  standout sessions across the filtered set.
- Use specific numbers for the headline insights (e.g. "averaged \`3:35/km\`
  across 24 threshold reps", "fastest mile dropped from \`5:12\` to
  \`4:58\`"), but skip per-row data.

FORMAT for visual readability (rendered as styled markdown):

- Open with a 1-line **TL;DR** (bold) summarising the headline finding.
- Use \`## Section headers\` with a leading emoji to group findings (max 3–4
  sections). Examples: \`## 📊 Volume\`, \`## ⚡ Pace trends\`,
  \`## ❤️ Heart rate\`, \`## 🏆 Standouts\`, \`## 🎯 Takeaways\`.
- Use bullet lists (\`- item\`). Keep bullets to 1 line.
- Wrap key numeric values in backticks (\`3:35/km\`, \`24 reps\`, \`+8%\`).
- Use a blockquote (\`> coach's note\`) at most once for the takeaway.
- Use realistic competitive-runner numbers when relevant — the athlete runs
  threshold around 3:30–3:40/km, so pick examples accordingly.`;

  const scopeNote = `\n\nScope: ${enriched.length} activities pre-filtered by the user${truncated ? ` (capped from ${activityIds.length}).` : "."}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      max_tokens: 2000,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Training data (${enriched.length} activities):${scopeNote}\n${JSON.stringify(enriched)}\n\nQuestion: ${question}`,
        },
      ],
    });

    const answer = response.choices[0]?.message?.content ?? "";
    res.json({
      answer,
      activitiesAnalysed: enriched.length,
      truncated,
      maxActivities: MAX_ACTIVITIES,
    });
  } catch (err: any) {
    console.error("AI insights error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Add 1 day to a YYYY-MM-DD string (used for inclusive `to` upper bound).
function nextDayIso(ymd: string): string {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export default router;
