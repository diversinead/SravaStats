import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db, schema } from "../db/index.js";
import { eq, desc, and, inArray } from "drizzle-orm";
import OpenAI from "openai";

const router = Router();

interface QueryFilters {
  dayOfWeek?: string;
  sessionTypes?: string[];
  limit?: number;
}

async function extractFilters(openai: OpenAI, question: string): Promise<QueryFilters> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini", // cheap model for filter extraction
    max_tokens: 200,
    messages: [
      {
        role: "system",
        content: `Extract query filters from a training question. Respond ONLY with valid JSON, no markdown.

Valid sessionTypes: easy, long, interval, threshold, warmup, crosstraining, race
Valid dayOfWeek: Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday

Example output:
{"dayOfWeek": "Tuesday", "sessionTypes": ["interval", "threshold"], "limit": 50}

If no specific day mentioned, omit dayOfWeek.
If no specific session type mentioned, omit sessionTypes.
Always include limit (max 50).`,
      },
      { role: "user", content: question },
    ],
  });

  try {
    const text = response.choices[0]?.message?.content ?? "{}";
    return JSON.parse(text) as QueryFilters;
  } catch {
    return { limit: 50 };
  }
}

router.post("/query", requireAuth, async (req, res) => {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const userId = (req as any).userId as number;
  const { question } = req.body as { question: string };

  if (!question?.trim()) {
    res.status(400).json({ error: "question is required" });
    return;
  }

  try {
    // Stage 1: extract filters from the question using cheap model
    const filters = await extractFilters(openai, question);
    console.log("Extracted filters:", filters);

    // Stage 2: build filtered DB query
    const conditions: any[] = [eq(schema.activities.userId, userId)];

    if (filters.dayOfWeek) {
      conditions.push(eq(schema.activities.dayOfWeek, filters.dayOfWeek));
    }
    if (filters.sessionTypes?.length) {
      conditions.push(inArray(schema.activities.sessionType, filters.sessionTypes));
    }

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
      .limit(filters.limit ?? 50)
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
- Keep it tight: a short summary paragraph plus 2–5 bullet points is usually
  enough. Use markdown headers only when there are genuinely multiple
  sections (e.g. comparing two periods).
- If comparing sessions or periods, lead with the trend, then back it up with
  one or two key numbers — not a per-session list.`;

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      max_tokens: 2000,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Training data (${enrichedActivities.length} activities):\n${JSON.stringify(enrichedActivities)}\n\nQuestion: ${question}`,
        },
      ],
    });

    const answer = response.choices[0]?.message?.content ?? "";
    res.json({
      answer,
      activitiesAnalysed: enrichedActivities.length,
      filters,
      activities: enrichedActivities,
    });
  } catch (err: any) {
    console.error("AI query error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Saved answers ----

router.post("/saved", requireAuth, async (req, res) => {
  const userId = (req as any).userId as number;
  const { question, answer, activitiesAnalysed, filters, activityIds } =
    req.body as {
      question?: string;
      answer?: string;
      activitiesAnalysed?: number;
      filters?: Record<string, unknown>;
      activityIds?: number[];
    };

  if (!question?.trim() || !answer?.trim()) {
    res.status(400).json({ error: "question and answer are required" });
    return;
  }

  const inserted = db
    .insert(schema.savedAiAnswers)
    .values({
      userId,
      question,
      answer,
      activitiesAnalysed: activitiesAnalysed ?? 0,
      filtersJson: JSON.stringify(filters ?? {}),
      activityIdsJson: JSON.stringify(activityIds ?? []),
    })
    .returning()
    .get();

  res.json({ id: inserted.id, savedAt: inserted.savedAt });
});

router.get("/saved", requireAuth, async (req, res) => {
  const userId = (req as any).userId as number;
  const rows = db
    .select({
      id: schema.savedAiAnswers.id,
      question: schema.savedAiAnswers.question,
      activitiesAnalysed: schema.savedAiAnswers.activitiesAnalysed,
      savedAt: schema.savedAiAnswers.savedAt,
    })
    .from(schema.savedAiAnswers)
    .where(eq(schema.savedAiAnswers.userId, userId))
    .orderBy(desc(schema.savedAiAnswers.savedAt))
    .all();
  res.json({ saved: rows });
});

router.get("/saved/:id", requireAuth, async (req, res) => {
  const userId = (req as any).userId as number;
  const id = Number(req.params.id);
  const row = db
    .select()
    .from(schema.savedAiAnswers)
    .where(
      and(
        eq(schema.savedAiAnswers.id, id),
        eq(schema.savedAiAnswers.userId, userId)
      )
    )
    .get();
  if (!row) {
    res.status(404).json({ error: "saved answer not found" });
    return;
  }

  // Re-hydrate activities + laps from current DB state. The answer text stays
  // as it was saved, but the table reflects whatever current classifications
  // / lap data exist (so re-categorising activities updates the saved view).
  const activityIds = JSON.parse(row.activityIdsJson) as number[];
  const activities = activityIds.length
    ? db
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
        .where(
          and(
            eq(schema.activities.userId, userId),
            inArray(schema.activities.id, activityIds)
          )
        )
        .all()
    : [];

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

  const lapsByActivity = laps.reduce(
    (acc: Record<number, typeof laps>, lap) => {
      if (!acc[lap.activityId]) acc[lap.activityId] = [];
      acc[lap.activityId].push(lap);
      return acc;
    },
    {}
  );

  // Preserve the original ordering from the activityIds array (newest first
  // as captured at save time).
  const byId = new Map(activities.map((a) => [a.id, a]));
  const enriched = activityIds
    .map((id) => byId.get(id))
    .filter((a): a is NonNullable<typeof a> => a != null)
    .map((a) => ({ ...a, laps: lapsByActivity[a.id] ?? [] }));

  res.json({
    id: row.id,
    question: row.question,
    answer: row.answer,
    activitiesAnalysed: row.activitiesAnalysed,
    filters: JSON.parse(row.filtersJson),
    activities: enriched,
    savedAt: row.savedAt,
  });
});

router.delete("/saved/:id", requireAuth, async (req, res) => {
  const userId = (req as any).userId as number;
  const id = Number(req.params.id);
  const result = db
    .delete(schema.savedAiAnswers)
    .where(
      and(
        eq(schema.savedAiAnswers.id, id),
        eq(schema.savedAiAnswers.userId, userId)
      )
    )
    .run();
  res.json({ deleted: result.changes });
});

export default router;