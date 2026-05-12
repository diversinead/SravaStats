import { useEffect, useState } from "react";
import {
  getRules,
  createRule,
  deleteRule,
  applyRules,
  applySingleRule,
  undoRulesApply,
  getRulesUndoAvailable,
  type Rule,
} from "../api/client";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const TRAINING_CATEGORIES = [
  "Easy Run",
  "Recovery Run",
  "Long Run",
  "Threshold",
  "Tempo",
  "Track Workout",
  "Intervals",
  "Fartlek",
  "Race",
  "WU/CD",
  "Marathon Session",
  "Road Workout",
  "Gravel Workout",
  "Grass Track",
  "Strides",
  "Heat Run",
];

const WORKOUT_TYPES: Record<number, string> = {
  0: "Default (Run)",
  1: "Race (Run)",
  2: "Long Run",
  3: "Workout (Run)",
  10: "Default (Ride)",
  11: "Race (Ride)",
  12: "Workout (Ride)",
};

// UI-only condition types pace_faster / pace_slower both serialize to the
// backend's "pace_range" rule with a single bound set.
const CONDITION_TYPES: { value: string; label: string }[] = [
  { value: "day_of_week", label: "Day of Week" },
  { value: "name_contains", label: "Name Contains" },
  { value: "sport_type", label: "Sport Type" },
  { value: "date_range", label: "Date Range" },
  { value: "duration_range", label: "Duration Range" },
  { value: "distance_range", label: "Distance Range" },
  { value: "pace_faster", label: "Pace faster than" },
  { value: "pace_slower", label: "Pace slower than" },
  { value: "workout_type", label: "Workout Type" },
  { value: "location", label: "Location" },
];

// One condition row in either the simple form or a compound rule. All input
// fields live here so the editor can hold partial text while the user types.
interface EditableCondition {
  type: string;
  day: number;
  pattern: string;
  sport: string;
  dateFrom: string;
  dateTo: string;
  durationMin: string;
  durationMax: string;
  distanceMin: string;
  distanceMax: string;
  pace: string;
  workoutType: number;
  location: string;
}

function emptyCondition(): EditableCondition {
  return {
    type: "day_of_week",
    day: 0,
    pattern: "",
    sport: "Run",
    dateFrom: "",
    dateTo: "",
    durationMin: "",
    durationMax: "",
    distanceMin: "",
    distanceMax: "",
    pace: "",
    workoutType: 1,
    location: "",
  };
}

function serializeCondition(c: EditableCondition): { ruleType: string; ruleValue: any } | null {
  switch (c.type) {
    case "day_of_week":
      return { ruleType: c.type, ruleValue: { day: c.day } };
    case "name_contains":
      if (!c.pattern.trim()) return null;
      return { ruleType: c.type, ruleValue: { pattern: c.pattern.trim() } };
    case "sport_type":
      if (!c.sport.trim()) return null;
      return { ruleType: c.type, ruleValue: { sport: c.sport.trim() } };
    case "date_range":
      if (!c.dateFrom && !c.dateTo) return null;
      return {
        ruleType: c.type,
        ruleValue: {
          ...(c.dateFrom && { from: c.dateFrom }),
          ...(c.dateTo && { to: c.dateTo }),
        },
      };
    case "duration_range": {
      const minSec = c.durationMin ? parseDurationToSeconds(c.durationMin) : null;
      const maxSec = c.durationMax ? parseDurationToSeconds(c.durationMax) : null;
      if (minSec == null && maxSec == null) return null;
      return {
        ruleType: c.type,
        ruleValue: {
          ...(minSec != null && { minSeconds: minSec }),
          ...(maxSec != null && { maxSeconds: maxSec }),
        },
      };
    }
    case "distance_range": {
      const minM = c.distanceMin ? Number(c.distanceMin) * 1000 : null;
      const maxM = c.distanceMax ? Number(c.distanceMax) * 1000 : null;
      if ((minM == null || isNaN(minM)) && (maxM == null || isNaN(maxM))) return null;
      return {
        ruleType: c.type,
        ruleValue: {
          ...(minM != null && !isNaN(minM) && { minMeters: minM }),
          ...(maxM != null && !isNaN(maxM) && { maxMeters: maxM }),
        },
      };
    }
    case "pace_faster": {
      // pace faster than X → activity must be at least that fast → speed floor.
      const speed = c.pace ? parsePaceToSpeed(c.pace) : null;
      if (speed == null) return null;
      return { ruleType: "pace_range", ruleValue: { minSpeedMs: speed } };
    }
    case "pace_slower": {
      // pace slower than X → activity must be at most that fast → speed ceiling.
      const speed = c.pace ? parsePaceToSpeed(c.pace) : null;
      if (speed == null) return null;
      return { ruleType: "pace_range", ruleValue: { maxSpeedMs: speed } };
    }
    case "workout_type":
      return { ruleType: c.type, ruleValue: { workoutType: c.workoutType } };
    case "location":
      if (!c.location.trim()) return null;
      return { ruleType: c.type, ruleValue: { timezone: c.location.trim() } };
    default:
      return null;
  }
}

function describeRule(rule: Rule): string {
  return describeRuleParts(rule.ruleType, rule.ruleValue);
}

function describeRuleParts(ruleType: string, ruleValue: string | object): string {
  const val: any = typeof ruleValue === "string" ? JSON.parse(ruleValue) : ruleValue;
  switch (ruleType) {
    case "day_of_week":
      return `Day = ${DAYS[val.day] || val.day}`;
    case "name_contains":
      return `Name contains "${val.pattern}"`;
    case "sport_type":
      return `Sport = ${val.sport}`;
    case "date_range": {
      const parts: string[] = [];
      if (val.from) parts.push(`from ${val.from}`);
      if (val.to) parts.push(`to ${val.to}`);
      return `Date ${parts.join(" ")}`;
    }
    case "duration_range": {
      const parts: string[] = [];
      if (val.minSeconds != null) parts.push(`min ${formatDurationShort(val.minSeconds)}`);
      if (val.maxSeconds != null) parts.push(`max ${formatDurationShort(val.maxSeconds)}`);
      return `Duration ${parts.join(", ")}`;
    }
    case "distance_range": {
      const parts: string[] = [];
      if (val.minMeters != null) parts.push(`min ${(val.minMeters / 1000).toFixed(1)} km`);
      if (val.maxMeters != null) parts.push(`max ${(val.maxMeters / 1000).toFixed(1)} km`);
      return `Distance ${parts.join(", ")}`;
    }
    case "pace_range": {
      const parts: string[] = [];
      if (val.minSpeedMs != null) parts.push(`faster than ${formatPaceFromSpeed(val.minSpeedMs)}`);
      if (val.maxSpeedMs != null) parts.push(`slower than ${formatPaceFromSpeed(val.maxSpeedMs)}`);
      return `Pace ${parts.join(", ")}`;
    }
    case "workout_type":
      return `Type = ${WORKOUT_TYPES[val.workoutType] || `#${val.workoutType}`}`;
    case "location":
      return `Location contains "${val.timezone}"`;
    case "compound": {
      const subs = (val.conditions || []) as { ruleType: string; ruleValue: any }[];
      if (subs.length === 0) return "(empty compound rule)";
      return subs.map((s) => describeRuleParts(s.ruleType, s.ruleValue)).join(" AND ");
    }
    default:
      return typeof ruleValue === "string" ? ruleValue : JSON.stringify(val);
  }
}

function formatDurationShort(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatPaceFromSpeed(speedMs: number): string {
  if (!speedMs || speedMs === 0) return "-";
  const paceMin = 1000 / 60 / speedMs;
  const mins = Math.floor(paceMin);
  const secs = Math.round((paceMin - mins) * 60);
  return `${mins}:${secs.toString().padStart(2, "0")} /km`;
}

function parsePaceToSpeed(value: string): number | null {
  const match = value.match(/^(\d+):(\d{1,2})$/);
  if (match) {
    const totalSeconds = Number(match[1]) * 60 + Number(match[2]);
    if (totalSeconds === 0) return null;
    return 1000 / totalSeconds; // m/s
  }
  return null;
}

function parseDurationToSeconds(value: string): number | null {
  const hmMatch = value.match(/^(\d+)h\s*(\d+)m?$/i);
  if (hmMatch) return Number(hmMatch[1]) * 3600 + Number(hmMatch[2]) * 60;
  const hOnly = value.match(/^(\d+)h$/i);
  if (hOnly) return Number(hOnly[1]) * 3600;
  const mOnly = value.match(/^(\d+)m$/i);
  if (mOnly) return Number(mOnly[1]) * 60;
  const colonMatch = value.match(/^(\d+):(\d+)$/);
  if (colonMatch) return Number(colonMatch[1]) * 3600 + Number(colonMatch[2]) * 60;
  const num = Number(value);
  if (!isNaN(num)) return num * 60;
  return null;
}

function ConditionEditor({
  value,
  onChange,
  onRemove,
}: {
  value: EditableCondition;
  onChange: (v: EditableCondition) => void;
  onRemove?: () => void;
}) {
  const set = (patch: Partial<EditableCondition>) => onChange({ ...value, ...patch });

  return (
    <div className="form-row" style={{ marginBottom: "0.4rem" }}>
      <select value={value.type} onChange={(e) => set({ type: e.target.value })}>
        {CONDITION_TYPES.map((t) => (
          <option key={t.value} value={t.value}>{t.label}</option>
        ))}
      </select>

      {value.type === "day_of_week" && (
        <select value={value.day} onChange={(e) => set({ day: Number(e.target.value) })}>
          {DAYS.map((d, i) => (
            <option key={i} value={i}>{d}</option>
          ))}
        </select>
      )}

      {value.type === "name_contains" && (
        <input
          type="text"
          placeholder="Pattern (e.g. tempo)"
          value={value.pattern}
          onChange={(e) => set({ pattern: e.target.value })}
        />
      )}

      {value.type === "sport_type" && (
        <input
          type="text"
          placeholder="Sport (e.g. Run, Ride)"
          value={value.sport}
          onChange={(e) => set({ sport: e.target.value })}
        />
      )}

      {value.type === "date_range" && (
        <>
          <label style={{ color: "#94a3b8", fontSize: "0.85rem" }}>From</label>
          <input type="date" value={value.dateFrom} onChange={(e) => set({ dateFrom: e.target.value })} />
          <label style={{ color: "#94a3b8", fontSize: "0.85rem" }}>To</label>
          <input type="date" value={value.dateTo} onChange={(e) => set({ dateTo: e.target.value })} />
        </>
      )}

      {value.type === "duration_range" && (
        <>
          <input
            type="text"
            placeholder="Min (e.g. 30m, 1h30m)"
            value={value.durationMin}
            onChange={(e) => set({ durationMin: e.target.value })}
          />
          <input
            type="text"
            placeholder="Max (e.g. 60m, 2h)"
            value={value.durationMax}
            onChange={(e) => set({ durationMax: e.target.value })}
          />
        </>
      )}

      {value.type === "distance_range" && (
        <>
          <input
            type="text"
            placeholder="Min km (e.g. 5)"
            value={value.distanceMin}
            onChange={(e) => set({ distanceMin: e.target.value })}
          />
          <input
            type="text"
            placeholder="Max km (e.g. 10)"
            value={value.distanceMax}
            onChange={(e) => set({ distanceMax: e.target.value })}
          />
        </>
      )}

      {(value.type === "pace_faster" || value.type === "pace_slower") && (
        <>
          <input
            type="text"
            placeholder="e.g. 4:00"
            value={value.pace}
            onChange={(e) => set({ pace: e.target.value })}
          />
          <span style={{ color: "#94a3b8", fontSize: "0.8rem" }}>/km</span>
        </>
      )}

      {value.type === "workout_type" && (
        <select
          value={value.workoutType}
          onChange={(e) => set({ workoutType: Number(e.target.value) })}
        >
          {Object.entries(WORKOUT_TYPES).map(([val, label]) => (
            <option key={val} value={val}>{label}</option>
          ))}
        </select>
      )}

      {value.type === "location" && (
        <input
          type="text"
          placeholder="Timezone (e.g. Europe/London, America)"
          value={value.location}
          onChange={(e) => set({ location: e.target.value })}
          style={{ minWidth: "260px" }}
        />
      )}

      {onRemove && (
        <button onClick={onRemove} className="btn btn-sm btn-danger" type="button" title="Remove condition">
          ✕
        </button>
      )}
    </div>
  );
}

export default function RulesPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [applyResult, setApplyResult] = useState<string | null>(null);
  const [ruleResults, setRuleResults] = useState<Record<number, string>>({});
  const [canUndo, setCanUndo] = useState(false);

  const [mode, setMode] = useState<"single" | "compound">("single");
  const [category, setCategory] = useState("");
  const [condition, setCondition] = useState<EditableCondition>(emptyCondition());
  const [compoundConditions, setCompoundConditions] = useState<EditableCondition[]>([
    emptyCondition(),
    emptyCondition(),
  ]);

  const load = () => {
    getRules().then(setRules);
  };

  useEffect(() => {
    load();
    getRulesUndoAvailable().then((r) => setCanUndo(r.available)).catch(() => {});
  }, []);

  const handleCreate = async () => {
    if (!category) return;

    let ruleType: string;
    let ruleValue: string;

    if (mode === "single") {
      const s = serializeCondition(condition);
      if (!s) return;
      ruleType = s.ruleType;
      ruleValue = JSON.stringify(s.ruleValue);
    } else {
      const serialized = compoundConditions
        .map(serializeCondition)
        .filter((s): s is { ruleType: string; ruleValue: any } => s != null);
      if (serialized.length === 0) return;
      ruleType = "compound";
      ruleValue = JSON.stringify({ conditions: serialized });
    }

    await createRule({ category, ruleType, ruleValue });
    load();
    if (mode === "single") setCondition(emptyCondition());
    else setCompoundConditions([emptyCondition(), emptyCondition()]);
  };

  const handleApply = async () => {
    const result = await applyRules();
    setApplyResult(`Updated ${result.applied} activities`);
    setCanUndo(true);
    load();
  };

  const handleApplySingle = async (id: number) => {
    const result = await applySingleRule(id);
    setRuleResults((prev) => ({ ...prev, [id]: `Updated ${result.applied} activities` }));
    setCanUndo(true);
  };

  const handleUndo = async () => {
    try {
      const result = await undoRulesApply();
      setApplyResult(`Reverted ${result.restored} activities`);
      setCanUndo(false);
      setRuleResults({});
      load();
    } catch (e: any) {
      setApplyResult(e.message || "Nothing to undo");
    }
  };

  const handleDelete = async (id: number) => {
    await deleteRule(id);
    load();
  };

  return (
    <div className="page">
      <h1>Category Rules</h1>

      <div className="card">
        <h2>Create Rule</h2>
        <div className="form-row" style={{ marginBottom: "0.5rem" }}>
          <select value={mode} onChange={(e) => setMode(e.target.value as "single" | "compound")}>
            <option value="single">Single condition</option>
            <option value="compound">Compound (all must match)</option>
          </select>

          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Assign category...</option>
            {TRAINING_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>

          <button onClick={handleCreate} className="btn btn-primary" disabled={!category}>
            Add Rule
          </button>
        </div>

        {mode === "single" ? (
          <ConditionEditor value={condition} onChange={setCondition} />
        ) : (
          <>
            {compoundConditions.map((c, i) => (
              <ConditionEditor
                key={i}
                value={c}
                onChange={(nc) => {
                  const next = [...compoundConditions];
                  next[i] = nc;
                  setCompoundConditions(next);
                }}
                onRemove={
                  compoundConditions.length > 1
                    ? () => setCompoundConditions(compoundConditions.filter((_, j) => j !== i))
                    : undefined
                }
              />
            ))}
            <button
              onClick={() => setCompoundConditions([...compoundConditions, emptyCondition()])}
              className="btn btn-sm"
              type="button"
              style={{ marginTop: "0.25rem" }}
            >
              + Add condition
            </button>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h2>Rules</h2>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              onClick={handleUndo}
              className="btn btn-sm"
              disabled={!canUndo}
              title="Revert the last Apply"
            >
              Undo Last Apply
            </button>
            <button onClick={handleApply} className="btn btn-primary">Apply All Rules</button>
          </div>
        </div>
        {applyResult && <p className="sync-result">{applyResult}</p>}

        {rules.length === 0 && <p>No rules yet.</p>}
        {rules.length > 0 && (
          <table className="activity-table">
            <thead>
              <tr>
                <th>Condition</th>
                <th>Category</th>
                <th>Enabled</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>{describeRule(r)}</td>
                  <td>{r.category}</td>
                  <td>{r.enabled ? "Yes" : "No"}</td>
                  <td>
                    <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                      <button onClick={() => handleApplySingle(r.id)} className="btn btn-sm">
                        Apply
                      </button>
                      <button onClick={() => handleDelete(r.id)} className="btn btn-sm btn-danger">
                        Delete
                      </button>
                      {ruleResults[r.id] && (
                        <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>{ruleResults[r.id]}</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
