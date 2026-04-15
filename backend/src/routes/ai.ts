import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db, schema } from "../db/index.js";
import { eq, desc, and, inArray, gte, lte } from "drizzle-orm";
import OpenAI from "openai";

const router = Router();

// Hard ceiling so a "show me everything since 2020" query can't melt the token
// budget. UI surfaces the count back to the user so they can narrow the range.
const MAX_ACTIVITIES = 500;

interface QueryFilters {
  dayOfWeek?: string;
  sessionTypes?: string[];
}

async function extractFilters(openai: OpenAI, question: string): Promise<QueryFilters> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini", // cheap model for filter extraction
    max_tokens: 150,
    messages: [
      {
        role: "system",
        content: `Extract query filters from a training question. Respond ONLY with valid JSON, no markdown.

Valid sessionTypes: easy, long, interval, threshold, warmup, crosstraining, race
Valid dayOfWeek: Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday

Example output:
{"dayOfWeek": "Tuesday", "sessionTypes": ["interval", "threshold"]}

If no specific day mentioned, omit dayOfWeek.
If no specific session type mentioned, omit sessionTypes.
Do NOT extract date ranges — those are supplied separately by the UI.`,
      },
      { role: "user", content: question },
    ],
  });

  try {
    const text = response.choices[0]?.message?.content ?? "{}";
    return JSON.parse(text) as QueryFilters;
  } catch {
    return {};
  }
}

router.post("/query", requireAuth, async (req, res) => {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const userId = (req as any).userId as number;
  const { question, from, to } = req.body as {
    question: string;
    from?: string; // YYYY-MM-DD inclusive
    to?: string;   // YYYY-MM-DD inclusive
  };

  if (!question?.trim()) {
    res.status(400).json({ error: "question is required" });
    return;
  }

  try {
    // Stage 1: extract filters from the question using cheap model
    const filters = await extractFilters(openai, question);
    console.log("Extracted filters:", filters, "Date range:", { from, to });

    // Stage 2: build filtered DB query
    const conditions: any[] = [eq(schema.activities.userId, userId)];

    if (filters.dayOfWeek) {
      conditions.push(eq(schema.activities.dayOfWeek, filters.dayOfWeek));
    }
    if (filters.sessionTypes?.length) {
      conditions.push(inArray(schema.activities.sessionType, filters.sessionTypes));
    }

    // Date range applied against startDateLocal (athlete's local date). The
    // YYYY-MM-DD prefix lexicographically compares correctly against the
    // ISO-8601 string stored in the column. `to` is inclusive — bump it to
    // the start of the next day so a "to: 2026-04-15" query catches anything
    // that happened on Apr 15 itself.
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
      conditions.push(gte(schema.activities.startDateLocal, from));
    }
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
      // Exclusive upper bound on the next day, so e.g. to=2026-04-15 includes
      // activities with startDateLocal "2026-04-15T18:30:00".
      const nextDay = nextDayIso(to);
      conditions.push(lte(schema.activities.startDateLocal, nextDay));
    }

    // Count first so we can warn the user when the range is too wide.
    // Using a separate count query would be cleaner; doing a fetch + slice is
    // fine at this scale.
    const allMatching = db
      .select({ id: schema.activities.id })
      .from(schema.activities)
      .where(and(...conditions))
      .all();
    const totalMatching = allMatching.length;
    const truncated = totalMatching > MAX_ACTIVITIES;

    const activities = db
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

    // Pull laps only for the filtered activities
    const activityIds = activities.map((a) => a.id);
    const laps = activityIds.length
      ? db
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
          .where(inArray(schema.laps.activityId, activityIds))
          .all()
      : [];

    // Group laps by activityId
    const lapsByActivity = laps.reduce(
      (acc: Record<number, typeof laps>, lap) => {
        if (!acc[lap.activityId]) acc[lap.activityId] = [];
        acc[lap.activityId].push(lap);
        return acc;
      },
      {}
    );

    // Attach laps to activities
    const enrichedActivities = activities.map((a) => ({
      ...a,
      laps: lapsByActivity[a.id] ?? [],
    }));

    console.log(`Sending ${enrichedActivities.length} activities to GPT-4o`);

    // Stage 3: answer the question with filtered data
    const systemPrompt = `You are an expert running coach AI analysing an athlete's training data.

Key data notes:
- Speed is stored in m/s. Convert to pace with: paceSecPerKm = 1000 / speed, then format as M:SS /km
- Distance is in metres. Convert to km by dividing by 1000.
- movingTime is in seconds. Convert to minutes/hours for display.
- dayOfWeek is the local day the session was performed.
- sessionType values: easy, long, interval, threshold, warmup, crosstraining, race
- trainingCategory is the athlete's own label (e.g. "Track Workout", "Easy Run", "Threshold")
- laps array contains per-rep data for interval/threshold sessions

How to answer (IMPORTANT — the user sees the full per-session and per-rep
breakdown in a table directly below your answer):

- Give a HIGH-LEVEL SUMMARY only. Do NOT enumerate sessions one by one and do
  NOT list every rep with its pace/HR/distance — that detail is in the table.
- Focus on the answer to the question: counts, averages, ranges, trends,
  notable patterns, standout sessions.
- Use specific numbers for the headline insights (e.g. "averaged 3:05/km
  across 24 reps", "fastest mile rep dropped from 5:12 to 4:58 over 3 months"),
  but skip per-row data.
- If comparing sessions or periods, lead with the trend, then back it up with
  one or two key numbers — not a per-session list.

FORMAT for visual readability — the answer is rendered as styled markdown,
so use the structure to break up the wall of text:

- Open with a 1-line **TL;DR** (bold) summarising the headline finding.
- Use \`## Section headers\` (with a leading emoji) to group findings — at most
  3–4 sections. Examples: \`## 📊 Volume\`, \`## ⚡ Pace trends\`,
  \`## ❤️ Heart rate\`, \`## 🏆 Standouts\`, \`## 🎯 Takeaways\`.
- Use bullet lists (\`- item\`) inside each section. Keep bullets to 1 line.
- Wrap key numeric values in backticks (\`3:05/km\`, \`24 reps\`, \`+8%\`)
  so they pop visually.
- Use a blockquote (\`> coach's note\`) at most once for a one-line takeaway
  the athlete should remember.
- Sprinkle emojis only in headers and rare emphasis (📈 📉 🔥 ✅ ⚠️) — not
  inside every bullet.

Example skeleton (do not copy verbatim — adapt to the question):

**TL;DR:** Threshold pace has improved by ~6s/km over the last 3 months.

## ⚡ Pace trends
- Avg threshold pace: \`3:42/km\` (down from \`3:48/km\` in Jan)
- Fastest single rep: \`3:28/km\` on 12 Mar

## ❤️ Heart rate
- Avg HR at threshold: \`168 bpm\` (steady — no drift)

> Big aerobic gain — same HR, faster pace.`;

    // Hand the model the explicit scope so it doesn't make up timeframes.
    const scopeNote =
      from || to
        ? `\n\nScope: only activities between ${from ?? "the earliest record"} and ${to ?? "today"}${truncated ? ` (truncated to the most recent ${MAX_ACTIVITIES} of ${totalMatching} matching).` : "."}`
        : `\n\nScope: most recent ${enrichedActivities.length} matching activities${truncated ? ` (truncated from ${totalMatching}).` : "."}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      max_tokens: 2000,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Training data (${enrichedActivities.length} activities):${scopeNote}\n${JSON.stringify(enrichedActivities)}\n\nQuestion: ${question}`,
        },
      ],
    });

    const answer = response.choices[0]?.message?.content ?? "";
    res.json({
      answer,
      activitiesAnalysed: enrichedActivities.length,
      totalMatching,
      truncated,
      maxActivities: MAX_ACTIVITIES,
      filters,
      from: from ?? null,
      to: to ?? null,
      activities: enrichedActivities,
    });
  } catch (err: any) {
    console.error("AI query error:", err);
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