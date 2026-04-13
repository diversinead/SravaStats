import { useEffect, useState } from "react";
import {
  getRules,
  createRule,
  deleteRule,
  applyRules,
  applySingleRule,
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
  "Cross Training",
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

function describeRule(rule: Rule): string {
  const val = JSON.parse(rule.ruleValue);
  switch (rule.ruleType) {
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
      if (val.maxSpeedMs != null) parts.push(`min ${formatPaceFromSpeed(val.maxSpeedMs)}`);
      if (val.minSpeedMs != null) parts.push(`max ${formatPaceFromSpeed(val.minSpeedMs)}`);
      return `Pace ${parts.join(", ")}`;
    }
    case "workout_type":
      return `Type = ${WORKOUT_TYPES[val.workoutType] || `#${val.workoutType}`}`;
    case "location":
      return `Location contains "${val.timezone}"`;
    default:
      return rule.ruleValue;
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

export default function RulesPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [applyResult, setApplyResult] = useState<string | null>(null);
  const [ruleResults, setRuleResults] = useState<Record<number, string>>({});

  // New rule form
  const [ruleType, setRuleType] = useState("day_of_week");
  const [category, setCategory] = useState("");

  // Rule-specific values
  const [dayValue, setDayValue] = useState(0);
  const [patternValue, setPatternValue] = useState("");
  const [sportValue, setSportValue] = useState("Run");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [durationMin, setDurationMin] = useState("");
  const [durationMax, setDurationMax] = useState("");
  const [distanceMin, setDistanceMin] = useState("");
  const [distanceMax, setDistanceMax] = useState("");
  const [paceMin, setPaceMin] = useState("");
  const [paceMax, setPaceMax] = useState("");
  const [workoutTypeValue, setWorkoutTypeValue] = useState(1);
  const [locationValue, setLocationValue] = useState("");

  const load = () => {
    getRules().then(setRules);
  };

  useEffect(() => {
    load();
  }, []);

  const handleCreate = async () => {
    if (!category) return;

    let ruleValue: string;
    switch (ruleType) {
      case "day_of_week":
        ruleValue = JSON.stringify({ day: dayValue });
        break;
      case "name_contains":
        if (!patternValue.trim()) return;
        ruleValue = JSON.stringify({ pattern: patternValue.trim() });
        break;
      case "sport_type":
        if (!sportValue.trim()) return;
        ruleValue = JSON.stringify({ sport: sportValue.trim() });
        break;
      case "date_range":
        if (!dateFrom && !dateTo) return;
        ruleValue = JSON.stringify({
          ...(dateFrom && { from: dateFrom }),
          ...(dateTo && { to: dateTo }),
        });
        break;
      case "duration_range": {
        const minSec = durationMin ? parseDurationToSeconds(durationMin) : null;
        const maxSec = durationMax ? parseDurationToSeconds(durationMax) : null;
        if (minSec == null && maxSec == null) return;
        ruleValue = JSON.stringify({
          ...(minSec != null && { minSeconds: minSec }),
          ...(maxSec != null && { maxSeconds: maxSec }),
        });
        break;
      }
      case "distance_range": {
        const minM = distanceMin ? Number(distanceMin) * 1000 : null;
        const maxM = distanceMax ? Number(distanceMax) * 1000 : null;
        if ((minM == null || isNaN(minM)) && (maxM == null || isNaN(maxM))) return;
        ruleValue = JSON.stringify({
          ...(minM != null && !isNaN(minM) && { minMeters: minM }),
          ...(maxM != null && !isNaN(maxM) && { maxMeters: maxM }),
        });
        break;
      }
      case "pace_range": {
        const minSpeed = paceMax ? parsePaceToSpeed(paceMax) : null; // slower pace = lower speed
        const maxSpeed = paceMin ? parsePaceToSpeed(paceMin) : null; // faster pace = higher speed
        if (minSpeed == null && maxSpeed == null) return;
        ruleValue = JSON.stringify({
          ...(minSpeed != null && { minSpeedMs: minSpeed }),
          ...(maxSpeed != null && { maxSpeedMs: maxSpeed }),
        });
        break;
      }
      case "workout_type":
        ruleValue = JSON.stringify({ workoutType: workoutTypeValue });
        break;
      case "location":
        if (!locationValue.trim()) return;
        ruleValue = JSON.stringify({ timezone: locationValue.trim() });
        break;
      default:
        return;
    }

    await createRule({ category, ruleType, ruleValue });
    load();
  };

  const handleApply = async () => {
    const result = await applyRules();
    setApplyResult(`Updated ${result.applied} activities`);
    load();
  };

  const handleApplySingle = async (id: number) => {
    const result = await applySingleRule(id);
    setRuleResults((prev) => ({ ...prev, [id]: `Updated ${result.applied} activities` }));
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
          <select value={ruleType} onChange={(e) => setRuleType(e.target.value)}>
            <option value="day_of_week">Day of Week</option>
            <option value="name_contains">Name Contains</option>
            <option value="sport_type">Sport Type</option>
            <option value="date_range">Date Range</option>
            <option value="duration_range">Duration Range</option>
            <option value="distance_range">Distance Range</option>
            <option value="pace_range">Pace Range</option>
            <option value="workout_type">Workout Type</option>
            <option value="location">Location</option>
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

        <div className="form-row">
          {ruleType === "day_of_week" && (
            <select value={dayValue} onChange={(e) => setDayValue(Number(e.target.value))}>
              {DAYS.map((d, i) => (
                <option key={i} value={i}>{d}</option>
              ))}
            </select>
          )}

          {ruleType === "name_contains" && (
            <input
              type="text"
              placeholder="Pattern (e.g. tempo)"
              value={patternValue}
              onChange={(e) => setPatternValue(e.target.value)}
            />
          )}

          {ruleType === "sport_type" && (
            <input
              type="text"
              placeholder="Sport (e.g. Run, Ride)"
              value={sportValue}
              onChange={(e) => setSportValue(e.target.value)}
            />
          )}

          {ruleType === "date_range" && (
            <>
              <label style={{ color: "#94a3b8", fontSize: "0.85rem" }}>From</label>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
              <label style={{ color: "#94a3b8", fontSize: "0.85rem" }}>To</label>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </>
          )}

          {ruleType === "duration_range" && (
            <>
              <input
                type="text"
                placeholder="Min (e.g. 30m, 1h30m)"
                value={durationMin}
                onChange={(e) => setDurationMin(e.target.value)}
              />
              <input
                type="text"
                placeholder="Max (e.g. 60m, 2h)"
                value={durationMax}
                onChange={(e) => setDurationMax(e.target.value)}
              />
            </>
          )}

          {ruleType === "distance_range" && (
            <>
              <input
                type="text"
                placeholder="Min km (e.g. 5)"
                value={distanceMin}
                onChange={(e) => setDistanceMin(e.target.value)}
              />
              <input
                type="text"
                placeholder="Max km (e.g. 10)"
                value={distanceMax}
                onChange={(e) => setDistanceMax(e.target.value)}
              />
            </>
          )}

          {ruleType === "pace_range" && (
            <>
              <input
                type="text"
                placeholder="Min pace (e.g. 4:10)"
                value={paceMin}
                onChange={(e) => setPaceMin(e.target.value)}
              />
              <input
                type="text"
                placeholder="Max pace (e.g. 5:00)"
                value={paceMax}
                onChange={(e) => setPaceMax(e.target.value)}
              />
              <span style={{ color: "#94a3b8", fontSize: "0.8rem" }}>/km</span>
            </>
          )}

          {ruleType === "workout_type" && (
            <select
              value={workoutTypeValue}
              onChange={(e) => setWorkoutTypeValue(Number(e.target.value))}
            >
              {Object.entries(WORKOUT_TYPES).map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          )}

          {ruleType === "location" && (
            <input
              type="text"
              placeholder="Timezone (e.g. Europe/London, America)"
              value={locationValue}
              onChange={(e) => setLocationValue(e.target.value)}
              style={{ minWidth: "260px" }}
            />
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h2>Rules</h2>
          <button onClick={handleApply} className="btn btn-primary">Apply All Rules</button>
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
