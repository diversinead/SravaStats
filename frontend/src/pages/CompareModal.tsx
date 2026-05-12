import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  syncLapsForActivities,
  type AIActivity,
  type AILap,
} from "../api/client";
import {
  DEFAULT_EFFORT_MAX_SEC,
  type RepBlock,
  type RepBucket,
  classifierModeForActivity,
  classifyRep,
  groupLapsIntoBlocks,
  mergeConsecutiveEffortLaps,
  sliceByStructure,
} from "./Coach.utils";

interface Props {
  activities: AIActivity[];
  effortMaxSec?: number;
  onClose: () => void;
}

type SyncState =
  | { kind: "idle" }
  | { kind: "syncing"; total: number }
  | { kind: "done"; synced: number; failed: number }
  | { kind: "error"; message: string };

// Tuned to be distinguishable on the dark background.
const SERIES_COLORS = [
  "#f97316", // orange (matches app accent)
  "#38bdf8", // sky
  "#a3e635", // lime
  "#e879f9", // fuchsia
  "#fbbf24", // amber
  "#22d3ee", // cyan
  "#f472b6", // pink
  "#94a3b8", // slate
];

interface ClassifiedRep {
  bucket: RepBucket;
  repNumber: number; // 1..N within this session+bucket
  lap: AILap;
}

// Lap-by-lap buckets (threshold mode) sort ascending so Lap 1 comes first;
// distance-mode buckets sort descending so mile → 800m → 400m.
function cmpBuckets(a: RepBucket, b: RepBucket): number {
  const aLap = a.key.startsWith("lap:");
  const bLap = b.key.startsWith("lap:");
  if (aLap && bLap) return a.size - b.size;
  if (aLap) return 1;
  if (bLap) return -1;
  return b.size - a.size;
}

// "800m #2" for bucketed reps, just "Lap 4" for lap-by-lap rows.
function rowLabel(bucket: RepBucket, repNumber: number): string {
  if (bucket.key.startsWith("lap:")) return bucket.label;
  return `${bucket.label} #${repNumber}`;
}

export default function CompareModal({
  activities: initialActivities,
  effortMaxSec = DEFAULT_EFFORT_MAX_SEC,
  onClose,
}: Props) {
  // Local copy of the activities so we can splice in freshly-fetched laps
  // without forcing the parent to refetch.
  const [activities, setActivities] =
    useState<AIActivity[]>(initialActivities);
  const [syncState, setSyncState] = useState<SyncState>({ kind: "idle" });

  // On mount, pull fresh per-rep data from Strava for sessions where what's
  // in the DB is wrong for the user's intent:
  //   • Interval & threshold sessions: user-pressed laps are the source of
  //     truth for rep boundaries (3×12min threshold, 400m reps, mile
  //     repeats). Resync if none are in the DB yet, or if the only rows are
  //     leftover per-km splits from an earlier classifier.
  //   • Everything else (easy/long/race): always pull
  //     splits_metric, since there are rarely meaningful user-laps and the
  //     per-km view is what the compare chart renders against.
  useEffect(() => {
    const missing = initialActivities
      .filter((a) => {
        // trainingCategory is the athlete's explicit tag and survives across
        // re-syncs; sessionType in the DB may still carry the pre-split
        // classifier (Threshold used to be stored as sessionType='interval').
        // When a trainingCategory is set, it wins.
        const isInterval = a.trainingCategory
          ? a.trainingCategory === "Intervals"
          : a.sessionType === "interval";
        if (isInterval) {
          if (!a.laps || a.laps.length === 0) return true;
          return a.laps.every((l) => l.lapType === "split");
        }
        // Everything else (threshold / long / easy / race) wants consistent
        // per-km splits. Resync if empty or if the DB still has user-laps
        // from an earlier sync (lapType !== "split" means user-laps).
        if (!a.laps || a.laps.length === 0) return true;
        return a.laps.some((l) => l.lapType !== "split");
      })
      .map((a) => a.id);
    if (missing.length === 0) return;

    let cancelled = false;
    setSyncState({ kind: "syncing", total: missing.length });
    syncLapsForActivities(missing)
      .then((res) => {
        if (cancelled) return;
        setActivities((prev) =>
          prev.map((a) => {
            const fresh = res.lapsByActivity[a.id];
            return fresh ? { ...a, laps: fresh } : a;
          })
        );
        setSyncState({
          kind: "done",
          synced: res.synced,
          failed: res.failed,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setSyncState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
    // initialActivities is stable per mount (parent passes a fresh array
    // each open), so this runs once per modal open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A short unique label per session, used as the key for table columns and chart series.
  const labels = useMemo(() => makeLabels(activities), [activities]);

  // Per session:
  //   • Time-mode sessions (threshold / cruise interval): every lap gets its
  //     own row, paced exactly as recorded — recoveries included, because the
  //     athlete wants to see those paces too. Laps align across sessions by
  //     lapIndex so "lap 4 here vs lap 4 there" is a meaningful comparison.
  //   • Distance-mode sessions (intervals): existing merge + bucket logic.
  const classifiedPerSession = useMemo<ClassifiedRep[][]>(() => {
    return activities.map((a) => {
      const mode = classifierModeForActivity(a.trainingCategory, a.sessionType);

      if (mode === "time") {
        const sorted = [...a.laps].sort((x, y) => x.lapIndex - y.lapIndex);
        return sorted.map((lap) => ({
          bucket: {
            key: `lap:${lap.lapIndex}`,
            label: `Lap ${lap.lapIndex}`,
            kind: "time" as const,
            size: lap.lapIndex,
            metres: 0,
          },
          repNumber: 1,
          lap,
        }));
      }

      const merged = mergeConsecutiveEffortLaps(a.laps, effortMaxSec, mode);
      const efforts = merged.filter(
        (l) => l.averageSpeed && 1000 / l.averageSpeed < effortMaxSec
      );
      const byBucket = new Map<string, { bucket: RepBucket; laps: AILap[] }>();
      for (const lap of efforts) {
        const bucket = classifyRep(lap, mode);
        if (!bucket) continue;
        const entry = byBucket.get(bucket.key) ?? { bucket, laps: [] };
        entry.laps.push(lap);
        byBucket.set(bucket.key, entry);
      }
      const reps: ClassifiedRep[] = [];
      for (const { bucket, laps } of byBucket.values()) {
        const sorted = [...laps].sort((x, y) => x.lapIndex - y.lapIndex);
        sorted.forEach((lap, idx) => {
          reps.push({ bucket, repNumber: idx + 1, lap });
        });
      }
      return reps;
    });
  }, [activities, effortMaxSec]);

  // True when every compared session is lap-by-lap (time mode). Lets us hide
  // the rep-distance filter row and swap row labels for "Lap N".
  const allLapByLap = useMemo(
    () =>
      activities.length > 0 &&
      activities.every(
        (a) =>
          classifierModeForActivity(a.trainingCategory, a.sessionType) ===
          "time"
      ),
    [activities]
  );

  // Effort blocks per session. When the athlete has tagged an explicit
  // repStructure on the activity (e.g. "3×8min/1min"), we slice by that —
  // the time/distance windows cut cleanly through per-km split fuzziness.
  // When the activity is untagged, fall back to auto-detection from pace
  // patterns. Recoveries are filtered out either way so the table reads as
  // a clean Rep 1 / Rep 2 / Rep 3 breakdown.
  const blocksPerSession = useMemo<RepBlock[][]>(
    () =>
      activities.map((a) =>
        a.repStructure
          ? sliceByStructure(a.laps, a.repStructure)
          : groupLapsIntoBlocks(a.laps).filter((b) => b.kind === "effort")
      ),
    [activities]
  );
  const maxBlockCount = useMemo(
    () => blocksPerSession.reduce((m, b) => Math.max(m, b.length), 0),
    [blocksPerSession]
  );

  // Distinct buckets across all compared sessions, biggest first. Sessions of
  // different kinds (distance vs time) just get separate chips — that's OK,
  // they're comparable side-by-side, not overlapping.
  const availableBuckets = useMemo(() => {
    const byKey = new Map<string, { bucket: RepBucket; count: number }>();
    classifiedPerSession.forEach((reps) =>
      reps.forEach((r) => {
        const existing = byKey.get(r.bucket.key);
        if (existing) existing.count += 1;
        else byKey.set(r.bucket.key, { bucket: r.bucket, count: 1 });
      })
    );
    return [...byKey.values()].sort((a, b) => cmpBuckets(a.bucket, b.bucket));
  }, [classifiedPerSession]);

  // Selected buckets default to all available; resync when the underlying
  // session set changes (e.g. user opens compare with a different selection).
  const [selectedBuckets, setSelectedBuckets] = useState<Set<string>>(
    new Set()
  );
  useEffect(() => {
    setSelectedBuckets(new Set(availableBuckets.map((b) => b.bucket.key)));
  }, [availableBuckets]);

  const toggleBucket = (key: string) => {
    setSelectedBuckets((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Row keys: union of (bucket.key, repNumber) across all sessions, filtered
  // to only the user-selected buckets. Sorted by bucket size desc, then
  // repNumber asc — so "mile" rows appear before "800m", "20min" before
  // "12min", etc.
  const rowKeys = useMemo(() => {
    const byKey = new Map<
      string,
      { key: string; bucket: RepBucket; repNumber: number }
    >();
    classifiedPerSession.forEach((reps) =>
      reps.forEach((r) => {
        if (!selectedBuckets.has(r.bucket.key)) return;
        const rowKey = `${r.bucket.key}#${r.repNumber}`;
        if (!byKey.has(rowKey)) {
          byKey.set(rowKey, {
            key: rowKey,
            bucket: r.bucket,
            repNumber: r.repNumber,
          });
        }
      })
    );
    return [...byKey.values()].sort((a, b) => {
      const byBucket = cmpBuckets(a.bucket, b.bucket);
      if (byBucket !== 0) return byBucket;
      return a.repNumber - b.repNumber;
    });
  }, [classifiedPerSession, selectedBuckets]);

  const chartData = useMemo(() => {
    return rowKeys.map(({ key, bucket, repNumber }) => {
      const row: Record<string, number | string | null> = {
        label: rowLabel(bucket, repNumber),
      };
      classifiedPerSession.forEach((reps, sessionIdx) => {
        const rep = reps.find(
          (r) => r.bucket.key === bucket.key && r.repNumber === repNumber
        );
        row[labels[sessionIdx]] = rep?.lap.averageSpeed
          ? Number((1000 / rep.lap.averageSpeed).toFixed(1))
          : null;
      });
      row.__key = key;
      return row;
    });
  }, [rowKeys, classifiedPerSession, labels]);

  const hasAnyReps = rowKeys.length > 0;

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal compare-modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>Compare {activities.length} sessions</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body">
          {syncState.kind === "syncing" && (
            <div className="compare-sync-banner">
              <span className="compare-sync-spinner" />
              Pulling lap data from Strava for {syncState.total}{" "}
              {syncState.total === 1 ? "session" : "sessions"}…
            </div>
          )}
          {syncState.kind === "done" && syncState.failed > 0 && (
            <div className="compare-sync-banner compare-sync-banner--warn">
              Synced {syncState.synced}, {syncState.failed} failed (likely
              Strava rate limit — wait 15 min and reopen).
            </div>
          )}
          {syncState.kind === "error" && (
            <div className="compare-sync-banner compare-sync-banner--err">
              Lap sync failed: {syncState.message}
            </div>
          )}

          <section className="compare-section">
            <h3>Summary</h3>
            <table className="compare-table compare-summary-table">
              <thead>
                <tr>
                  <th>Session</th>
                  <th className="align-right">Date</th>
                  <th className="align-right">Distance</th>
                  <th className="align-right">Time</th>
                  <th className="align-right">Avg pace</th>
                  <th className="align-right">Avg HR</th>
                  <th className="align-right">Reps</th>
                </tr>
              </thead>
              <tbody>
                {activities.map((a, idx) => (
                  <tr key={a.id}>
                    <td>
                      <span
                        className="series-swatch"
                        style={{
                          background: SERIES_COLORS[idx % SERIES_COLORS.length],
                        }}
                      />
                      <a
                        href={`/activities/${a.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {labels[idx]}
                      </a>
                    </td>
                    <td className="align-right">
                      {formatDate(a.startDateLocal)}
                    </td>
                    <td className="align-right">{formatDistance(a.distance)}</td>
                    <td className="align-right">{formatTime(a.movingTime)}</td>
                    <td className="align-right">{formatPace(a.averageSpeed)}</td>
                    <td className="align-right">
                      {a.averageHeartrate
                        ? Math.round(a.averageHeartrate)
                        : "—"}
                    </td>
                    <td className="align-right">
                      {classifiedPerSession[idx].length}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {availableBuckets.length > 0 && !allLapByLap && (
            <section className="compare-section compare-bucket-filter">
              <span className="bucket-filter-label">Show reps:</span>
              <div className="bucket-filter-chips">
                {availableBuckets.map(({ bucket, count }) => {
                  const checked = selectedBuckets.has(bucket.key);
                  return (
                    <label
                      key={bucket.key}
                      className={`bucket-chip ${checked ? "is-on" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleBucket(bucket.key)}
                      />
                      <span>
                        {bucket.label}{" "}
                        <span className="bucket-chip-count">({count})</span>
                      </span>
                    </label>
                  );
                })}
                <button
                  type="button"
                  className="bucket-filter-action"
                  onClick={() =>
                    setSelectedBuckets(
                      new Set(availableBuckets.map((b) => b.bucket.key))
                    )
                  }
                  disabled={
                    selectedBuckets.size === availableBuckets.length
                  }
                >
                  All
                </button>
                <button
                  type="button"
                  className="bucket-filter-action"
                  onClick={() => setSelectedBuckets(new Set())}
                  disabled={selectedBuckets.size === 0}
                >
                  None
                </button>
              </div>
            </section>
          )}

          {hasAnyReps ? (
            <>
              <section className="compare-section">
                <h3>Pace per rep</h3>
                <div className="compare-chart">
                  <ResponsiveContainer width="100%" height={280}>
                    <LineChart
                      data={chartData}
                      margin={{ top: 10, right: 24, left: 0, bottom: 8 }}
                    >
                      <CartesianGrid stroke="#334155" strokeDasharray="3 3" />
                      <XAxis
                        dataKey="label"
                        stroke="#94a3b8"
                        interval={0}
                        tick={{ fontSize: 11 }}
                      />
                      <YAxis
                        stroke="#94a3b8"
                        reversed
                        tickFormatter={(v) => secondsToPaceShort(v)}
                        width={70}
                        domain={[
                          // Fit to data ±5s and snap to a 5-second grid so
                          // ticks land on round paces like 3:25, 3:30 — same
                          // treatment as the trend chart.
                          (min: number) => Math.floor((min - 5) / 5) * 5,
                          (max: number) => Math.ceil((max + 5) / 5) * 5,
                        ]}
                        allowDecimals={false}
                        label={{
                          value: "Pace /km",
                          angle: -90,
                          position: "insideLeft",
                          fill: "#94a3b8",
                          offset: 12,
                        }}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "#1e293b",
                          border: "1px solid #334155",
                          borderRadius: 6,
                        }}
                        labelStyle={{ color: "#f1f5f9" }}
                        formatter={(value, name) => [
                          typeof value === "number"
                            ? secondsToPaceShort(value)
                            : String(value ?? "—"),
                          String(name),
                        ]}
                      />
                      <Legend wrapperStyle={{ color: "#e2e8f0" }} />
                      {labels.map((label, idx) => (
                        <Line
                          key={label}
                          type="monotone"
                          dataKey={label}
                          stroke={SERIES_COLORS[idx % SERIES_COLORS.length]}
                          strokeWidth={2}
                          connectNulls
                          dot={{ r: 3 }}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </section>

              {allLapByLap && maxBlockCount > 0 && (
                <section className="compare-section">
                  <h3>Rep averages</h3>
                  <div className="compare-table-wrap">
                    <table className="compare-table compare-matrix">
                      <thead>
                        <tr>
                          <th>Rep</th>
                          {labels.map((label) => (
                            <th key={label} className="align-right">
                              {label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from({ length: maxBlockCount }).map((_, i) => (
                          <tr key={i}>
                            <td>Rep {i + 1}</td>
                            {blocksPerSession.map((blocks, sessionIdx) => {
                              const b = blocks[i];
                              if (!b) {
                                return (
                                  <td
                                    key={sessionIdx}
                                    className="align-right"
                                  >
                                    —
                                  </td>
                                );
                              }
                              const km = (b.totalDistance / 1000).toFixed(2);
                              const time = formatTime(b.totalTime);
                              const pace =
                                b.avgPaceSec != null
                                  ? `${secondsToPace(b.avgPaceSec)} /km`
                                  : "—";
                              return (
                                <td
                                  key={sessionIdx}
                                  className="align-right"
                                  title={`${km}km`}
                                >
                                  {pace} · {time}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              <section className="compare-section">
                <h3>Rep pace</h3>
                <RepMatrix
                  labels={labels}
                  rowKeys={rowKeys}
                  classifiedPerSession={classifiedPerSession}
                  valueFn={(lap) => formatPace(lap.averageSpeed)}
                />
              </section>

              <section className="compare-section">
                <h3>Rep heart rate</h3>
                <RepMatrix
                  labels={labels}
                  rowKeys={rowKeys}
                  classifiedPerSession={classifiedPerSession}
                  valueFn={(lap) =>
                    lap.averageHeartrate
                      ? String(Math.round(lap.averageHeartrate))
                      : "—"
                  }
                />
              </section>
            </>
          ) : availableBuckets.length === 0 ? (
            <div className="compare-no-laps">
              {syncState.kind === "syncing"
                ? "Loading lap data — chart will appear shortly."
                : "These sessions don't have any laps that match a standard rep size (400m, 800m, mile, 12min, 15min, etc.). If they're continuous runs without per-km laps on the watch, there's nothing to compare on a per-rep basis."}
            </div>
          ) : (
            <div className="compare-no-laps">
              No reps selected — tick at least one above to see the
              comparison.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RepMatrix({
  labels,
  rowKeys,
  classifiedPerSession,
  valueFn,
}: {
  labels: string[];
  rowKeys: { key: string; bucket: RepBucket; repNumber: number }[];
  classifiedPerSession: ClassifiedRep[][];
  valueFn: (lap: AILap) => string;
}) {
  return (
    <div className="compare-table-wrap">
      <table className="compare-table compare-matrix">
        <thead>
          <tr>
            <th>Rep</th>
            {labels.map((label) => (
              <th key={label} className="align-right">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowKeys.map(({ key, bucket, repNumber }) => (
            <tr key={key}>
              <td>{rowLabel(bucket, repNumber)}</td>
              {classifiedPerSession.map((reps, sessionIdx) => {
                const rep = reps.find(
                  (r) => r.bucket.key === bucket.key && r.repNumber === repNumber
                );
                return (
                  <td key={sessionIdx} className="align-right">
                    {rep ? valueFn(rep.lap) : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function makeLabels(activities: AIActivity[]): string[] {
  const shortDate = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "2-digit",
        })
      : "Unknown";

  const rawLabels = activities.map((a) => shortDate(a.startDateLocal));
  const counts = rawLabels.reduce<Record<string, number>>((acc, l) => {
    acc[l] = (acc[l] ?? 0) + 1;
    return acc;
  }, {});

  return activities.map((a, idx) => {
    const base = rawLabels[idx];
    if (counts[base] === 1) return base;
    const shortName = a.name.length > 18 ? a.name.slice(0, 16) + "…" : a.name;
    return `${base} · ${shortName}`;
  });
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDistance(metres: number | null): string {
  if (metres == null) return "—";
  return `${(metres / 1000).toFixed(2)} km`;
}

function formatTime(seconds: number | null): string {
  if (seconds == null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

function formatPace(speedMs: number | null): string {
  if (!speedMs) return "—";
  const secPerKm = 1000 / speedMs;
  return secondsToPace(secPerKm) + " /km";
}

function secondsToPace(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${pad(s)}`;
}

function secondsToPaceShort(sec: number): string {
  return secondsToPace(sec);
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
