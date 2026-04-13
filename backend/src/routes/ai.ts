import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db, schema } from "../db/index.js";
import { eq, desc } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";

const router = Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

router.post("/query", requireAuth, async (req, res) => {
  const userId = (req as any).userId as number;
  const { question } = req.body as { question: string };

  if (!question?.trim()) {
    res.status(400).json({ error: "question is required" });
    return;
  }

  try {
    // Pull activities (most recent 500)
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
      .where(eq(schema.activities.userId, userId))
      .orderBy(desc(schema.activities.startDateLocal))
      .limit(500)
      .all();

    // Pull all laps for those activities
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
          })
          .from(schema.laps)
          .all()
          .filter((l) => activityIds.includes(l.activityId))
      : [];

    // Group laps by activityId for easier reference
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

    const systemPrompt = `You are an expert running coach AI analysing an athlete's training data.

Key data notes:
- Speed is stored in m/s. Convert to pace with: paceSecPerKm = 1000 / speed, then format as M:SS /km
- Distance is in metres. Convert to km by dividing by 1000.
- movingTime is in seconds. Convert to minutes/hours for display.
- dayOfWeek is the local day the session was performed.
- sessionType values: easy, long, interval, threshold, warmup, crosstraining, race, default
- trainingCategory is the athlete's own label (e.g. "Track Workout", "Easy Run", "Threshold")
- laps array contains per-rep data for interval/threshold sessions

When answering:
- Always convert pace and distance to readable units (min/km, km)
- For interval sessions, break down each rep with pace, distance, HR
- Be specific with numbers — the athlete wants data, not generalities
- If comparing sessions, highlight trends (getting faster, slower, higher HR etc)
- Format responses clearly with sections if there are multiple parts`;

    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 2000,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Training data (${enrichedActivities.length} activities):\n${JSON.stringify(enrichedActivities)}\n\nQuestion: ${question}`,
        },
      ],
    });

    const answer =
      response.content[0].type === "text" ? response.content[0].text : "";

    res.json({ answer });
  } catch (err: any) {
    console.error("AI query error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
