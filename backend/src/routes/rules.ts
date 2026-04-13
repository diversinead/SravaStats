import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db, schema } from "../db/index.js";
import { eq, and } from "drizzle-orm";
import { applyRulesToActivities, applySingleRule, previewRule } from "../services/rules.js";

const router = Router();

const VALID_TYPES = [
  "day_of_week", "name_contains", "sport_type",
  "date_range", "duration_range", "distance_range",
  "workout_type", "location",
];

// List rules
router.get("/", requireAuth, (req, res) => {
  const userId = (req as any).userId as number;

  const rules = db
    .select()
    .from(schema.categoryRules)
    .where(eq(schema.categoryRules.userId, userId))
    .orderBy(schema.categoryRules.priority)
    .all();

  res.json(rules);
});

// Create rule
router.post("/", requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const { category, ruleType, ruleValue, priority } = req.body as {
    category: string;
    ruleType: string;
    ruleValue: string;
    priority?: number;
  };

  if (!category || !ruleType || !ruleValue) {
    res.status(400).json({ error: "category, ruleType, and ruleValue required" });
    return;
  }

  if (!VALID_TYPES.includes(ruleType)) {
    res.status(400).json({ error: `ruleType must be one of: ${VALID_TYPES.join(", ")}` });
    return;
  }

  const result = db
    .insert(schema.categoryRules)
    .values({
      userId,
      category,
      ruleType,
      ruleValue,
      priority: priority ?? 0,
    })
    .returning()
    .get();

  res.status(201).json(result);
});

// Update rule
router.put("/:id", requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const ruleId = Number(req.params.id);
  const { category, ruleType, ruleValue, priority, enabled } = req.body;

  const existing = db
    .select()
    .from(schema.categoryRules)
    .where(
      and(eq(schema.categoryRules.id, ruleId), eq(schema.categoryRules.userId, userId))
    )
    .get();

  if (!existing) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }

  const updated = db
    .update(schema.categoryRules)
    .set({
      ...(category !== undefined && { category }),
      ...(ruleType !== undefined && { ruleType }),
      ...(ruleValue !== undefined && { ruleValue }),
      ...(priority !== undefined && { priority }),
      ...(enabled !== undefined && { enabled }),
    })
    .where(eq(schema.categoryRules.id, ruleId))
    .returning()
    .get();

  res.json(updated);
});

// Delete rule
router.delete("/:id", requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const ruleId = Number(req.params.id);

  db.delete(schema.categoryRules)
    .where(
      and(eq(schema.categoryRules.id, ruleId), eq(schema.categoryRules.userId, userId))
    )
    .run();

  res.json({ ok: true });
});

// Apply all rules to existing activities
router.post("/apply", requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const applied = applyRulesToActivities(userId);
  res.json({ applied });
});

// Apply a single rule
router.post("/:id/apply", requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const ruleId = Number(req.params.id);

  const applied = applySingleRule(userId, ruleId);
  if (applied === null) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }

  res.json({ applied });
});

// Preview which activities a rule would match
router.post("/:id/preview", requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const { ruleType, ruleValue } = req.body as {
    ruleType: string;
    ruleValue: string;
  };

  if (!ruleType || !ruleValue) {
    res.status(400).json({ error: "ruleType and ruleValue required" });
    return;
  }

  const matched = previewRule(userId, ruleType, ruleValue);

  res.json({
    matchCount: matched.length,
    activities: matched.slice(0, 50).map((a) => ({
      id: a.id,
      name: a.name,
      startDate: a.startDate,
      sportType: a.sportType,
    })),
  });
});

export default router;
