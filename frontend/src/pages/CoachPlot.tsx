import { useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import {
  fetchFilteredActivities,
  explainPlot,
  type ActivityFilterOpts,
  type AIActivity,
} from "../api/client";
import { classifyDistance, DEFAULT_EFFORT_MAX_SEC } from "./Coach.utils";
import { formatMarkdown } from "../lib/markdown";

interface Preset {
  value: string;
  label: string;
  kind: "rep" | "session_pace" | "session_hr";
  metres?: number;
}

// Rep distance presets cover the standard work-rep sizes the athlete runs.
// The session_* presets fall back to whole-activity averages when reps aren't
// the right granularity.
const PRESETS: Preset[] = [
  { value: "rep_200", label: "200m rep pace", kind: "rep", metres: 200 },
  { value: "rep_400", label: "400m rep pace", kind: "rep", metres: 400 },
  { value: "rep_800", label: "800m rep pace", kind: "rep", metres: 800 },
  { value: "rep_1k", label: "1k rep pace", kind: "rep", metres: 1000 },
  { value: "rep_1200", label: "1200m rep pace", kind: "rep", metres: 1200 },
  { value: "rep_mile", label: "Mile rep pace", kind: "rep", metres: 1600 },
  { value: "rep_2k", label: "2k rep pace", kind: "rep", metres: 2000 },
  { value: "session_pace", label: "Session avg pace", kind: "session_pace" },
  { value: "session_hr", label: "Session avg HR", kind: "session_hr" },
];

interface Point {
  dateMs: number;
  dateLabel: string;
  // YYYY-MM-DD — sent to backend; UI uses dateMs for the X axis.
  date: string;
  avgPaceSec: number | null;
  bestPaceSec: number | null;
  avgHr: number | null;
  repCount: number;
  name: string;
  activityId: number;
}

function speedToSec(speed: number | null | undefined): number | null {
  if (!speed || speed <= 0) return null;
  return 1000 / speed;
}

function paceLabel(sec: number | null): string {
  if (sec == null || !isFinite(sec)) return "-";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function buildPoints(activities: AIActivity[], preset: Preset): Point[] {
  const out: Point[] = [];
  for (const a of activities) {
    if (!a.startDateLocal) continue;
    const dateMs = new Date(a.startDateLocal).getTime();
    const dateLabel = new Date(a.startDateLocal).toLocaleDateString();
    const base = {
      dateMs,
      dateLabel,
      date: a.startDateLocal.slice(0, 10),
      name: a.name,
      activityId: a.id,
    };

    if (preset.kind === "session_pace") {
      out.push({
        ...base,
        avgPaceSec: speedToSec(a.averageSpeed),
        bestPaceSec: null,
        avgHr: a.averageHeartrate ?? null,
        repCount: 1,
      });
      continue;
    }
    if (preset.kind === "session_hr") {
      out.push({
        ...base,
        avgPaceSec: null,
        bestPaceSec: null,
        avgHr: a.averageHeartrate ?? null,
        repCount: 1,
      });
      continue;
    }

    // Rep-based: keep user-pressed laps (not Strava per-km splits) that snap to
    // the chosen rep distance AND were run at effort pace.
    const matching = (a.laps ?? []).filter((lap) => {
      if (lap.lapType === "split") return false;
      const bucket = classifyDistance(lap.distance);
      if (!bucket || bucket.size !== preset.metres) return false;
      const pace = speedToSec(lap.averageSpeed);
      return pace != null && pace < DEFAULT_EFFORT_MAX_SEC;
    });
    if (matching.length === 0) continue;

    const paces = matching
      .map((l) => speedToSec(l.averageSpeed))
      .filter((p): p is number => p != null);
    const avgPaceSec = paces.reduce((s, p) => s + p, 0) / paces.length;
    const bestPaceSec = Math.min(...paces);
    const hrValues = matching
      .map((l) => l.averageHeartrate)
      .filter((h): h is number => h != null);
    const avgHr = hrValues.length
      ? hrValues.reduce((s, h) => s + h, 0) / hrValues.length
      : null;

    out.push({
      ...base,
      avgPaceSec,
      bestPaceSec,
      avgHr,
      repCount: matching.length,
    });
  }
  return out.sort((a, b) => a.dateMs - b.dateMs);
}

export default function CoachPlot({
  filterOpts,
}: {
  filterOpts: ActivityFilterOpts;
}) {
  const [presetKey, setPresetKey] = useState("rep_1k");
  const [points, setPoints] = useState<Point[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [explainHtml, setExplainHtml] = useState<string | null>(null);
  const [explainLoading, setExplainLoading] = useState(false);
  const preset = PRESETS.find((p) => p.value === presetKey)!;
  const isHrPlot = preset.kind === "session_hr";
  const isRepPlot = preset.kind === "rep";

  const plot = async () => {
    setLoading(true);
    setError(null);
    setExplainHtml(null);
    try {
      const r = await fetchFilteredActivities(filterOpts);
      setPoints(buildPoints(r.activities, preset));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const explainTrend = async () => {
    if (!points || points.length === 0) return;
    setExplainLoading(true);
    setError(null);
    try {
      const r = await explainPlot(
        preset.label,
        points.map((p) => ({
          date: p.date,
          avgPaceSec: p.avgPaceSec,
          bestPaceSec: p.bestPaceSec,
          avgHr: p.avgHr,
          repCount: p.repCount,
          name: p.name,
        }))
      );
      setExplainHtml(formatMarkdown(r.answer));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExplainLoading(false);
    }
  };

  return (
    <div className="coach-plot" style={{ marginTop: "0.75rem" }}>
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <span style={{ color: "#94a3b8" }}>Plot:</span>
        <select
          value={presetKey}
          onChange={(e) => {
            setPresetKey(e.target.value);
            setPoints(null);
          }}
        >
          {PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <button
          onClick={plot}
          className="btn btn-sm btn-primary"
          disabled={loading}
        >
          {loading ? "Plotting…" : "Plot"}
        </button>
        {points && (
          <button
            onClick={() => {
              setPoints(null);
              setExplainHtml(null);
            }}
            className="btn btn-sm"
          >
            Clear
          </button>
        )}
        {points && points.length > 0 && (
          <button
            onClick={explainTrend}
            className="btn btn-sm"
            disabled={explainLoading}
            title="Ask AI to narrate this chart"
          >
            {explainLoading ? "Explaining…" : "Explain trend"}
          </button>
        )}
        {points && (
          <span style={{ color: "#94a3b8", fontSize: "0.85rem" }}>
            {points.length} {points.length === 1 ? "session" : "sessions"}
          </span>
        )}
      </div>

      {error && <div className="coach-error">Error: {error}</div>}

      {points && points.length === 0 && (
        <div style={{ marginTop: "0.5rem", color: "#94a3b8" }}>
          No sessions in the current filter contain {preset.label.toLowerCase()}.
          Widen the date range, change the category filter, or pick a different
          preset.
        </div>
      )}

      {points && points.length > 0 && (
        <div style={{ width: "100%", height: 340, marginTop: "0.5rem" }}>
          <ResponsiveContainer>
            <LineChart
              data={points}
              margin={{ top: 10, right: 20, left: 20, bottom: 10 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis
                dataKey="dateMs"
                domain={["dataMin", "dataMax"]}
                type="number"
                scale="time"
                tickFormatter={(ms: number) =>
                  new Date(ms).toLocaleDateString(undefined, {
                    month: "short",
                    year: "2-digit",
                  })
                }
                stroke="#94a3b8"
              />
              <YAxis
                tickFormatter={(v: number) =>
                  isHrPlot ? `${Math.round(v)}` : paceLabel(v)
                }
                reversed={!isHrPlot}
                stroke="#94a3b8"
                domain={
                  isHrPlot
                    ? [
                        (min: number) => Math.floor((min - 3) / 5) * 5,
                        (max: number) => Math.ceil((max + 3) / 5) * 5,
                      ]
                    : [
                        // Pace axis: pad ±5s and snap to a 5-second grid so
                        // ticks land on round values like 3:25, 3:30, 3:35.
                        (min: number) => Math.floor((min - 5) / 5) * 5,
                        (max: number) => Math.ceil((max + 5) / 5) * 5,
                      ]
                }
                allowDecimals={false}
                label={{
                  value: isHrPlot ? "bpm" : "min/km",
                  angle: -90,
                  position: "insideLeft",
                  style: { fill: "#94a3b8" },
                }}
              />
              <Tooltip
                contentStyle={{
                  background: "#0f172a",
                  border: "1px solid #334155",
                  color: "#e2e8f0",
                }}
                labelFormatter={(ms: number) =>
                  new Date(ms).toLocaleDateString()
                }
                formatter={(value: number, _name: string, item: any) => {
                  // item.dataKey reliably identifies which Line the tooltip
                  // entry came from; item.name reflects the Line's name prop,
                  // which makes equality checks fragile.
                  const key = item?.dataKey;
                  if (key === "avgHr")
                    return [`${Math.round(value)} bpm`, "Avg HR"];
                  const reps = item?.payload?.repCount ?? 0;
                  const suffix = reps > 1 ? ` (${reps} reps)` : "";
                  if (key === "bestPaceSec")
                    return [`${paceLabel(value)} /km${suffix}`, "Best rep"];
                  return [`${paceLabel(value)} /km${suffix}`, "Avg rep"];
                }}
              />
              <Legend wrapperStyle={{ color: "#94a3b8" }} />
              {isHrPlot ? (
                <Line
                  type="monotone"
                  dataKey="avgHr"
                  name="Avg HR"
                  stroke="#ef4444"
                  strokeWidth={2}
                  dot={{ r: 4 }}
                  isAnimationActive={false}
                  connectNulls
                />
              ) : (
                <>
                  <Line
                    type="monotone"
                    dataKey="avgPaceSec"
                    name="Avg rep"
                    stroke="#60a5fa"
                    strokeWidth={2}
                    dot={{ r: 4 }}
                    isAnimationActive={false}
                    connectNulls
                  />
                  {isRepPlot && (
                    <Line
                      type="monotone"
                      dataKey="bestPaceSec"
                      name="Best rep"
                      stroke="#22c55e"
                      strokeWidth={2}
                      strokeDasharray="4 2"
                      dot={{ r: 3 }}
                      isAnimationActive={false}
                      connectNulls
                    />
                  )}
                </>
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {explainHtml && (
        <div
          className="coach-plot-explain"
          dangerouslySetInnerHTML={{ __html: explainHtml }}
        />
      )}
    </div>
  );
}
