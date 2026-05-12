import type { AILap, RepStructure } from "../api/client";

// Rep distances the user actually runs. Anything outside this list gets dropped.
// 3600 = 9 laps of a standard 400m track.
const STANDARD_DISTANCES = [
  200, 300, 400, 500, 600, 800, 1000, 1200, 1600, 2000, 3600,
];

// Rep durations (seconds) for time-based sessions (thresholds, tempos).
// A 3×12min threshold session lands reps at 720s — that's the prevalent case.
const STANDARD_TIMES = [
  60, 120, 180, 240, 300, 360, 480, 600, 720, 900, 1200, 1500, 1800, 2700, 3600,
];

// Default effort / jog thresholds (seconds per km).
// Effort = faster than 4:00/km. Jog recovery = 4:00–6:00/km. Standing = slower than 6:00/km.
export const DEFAULT_EFFORT_MAX_SEC = 240;
export const DEFAULT_JOG_MAX_SEC = 360;

export type PaceClassification = "effort" | "jog" | "standing" | "mixed";

// Unified rep bucket used by both distance-based (intervals) and time-based
// (threshold) classifications. `key` is unique across both kinds so it's safe
// as a Map key or React list key; `size` is the sort ordinal (metres or
// seconds); `label` is what the user reads.
export interface RepBucket {
  key: string;
  label: string;
  kind: "distance" | "time";
  size: number;
  /** Back-compat: populated only when kind === "distance". */
  metres: number;
}

export type RepClassifierMode = "distance" | "time";

// Sessions the watch records as structured time-reps (3×12min threshold,
// 5×5min cruise intervals, marathon-pace blocks) use time buckets; everything
// else uses distance.
//
// We prefer `trainingCategory` because it's the athlete's explicit tag, while
// `sessionType` on existing rows may be stale (pre-dates the enum split
// between "interval" and "threshold") until the next Strava sync recomputes
// it. Marathon Session has no sessionType fallback because it maps to
// `long`, which is shared with Long Run — auto-detection would misclassify.
export function classifierModeForActivity(
  trainingCategory: string | null | undefined,
  sessionType: string | null | undefined
): RepClassifierMode {
  if (trainingCategory === "Threshold") return "time";
  if (trainingCategory === "Marathon Session") return "time";
  if (!trainingCategory && sessionType === "threshold") return "time";
  return "distance";
}

export interface RepGroup {
  bucket: RepBucket;
  laps: (AILap & { repNumber: number })[]; // sorted by lapIndex asc, repNumber 1..N within this session+bucket
  lapIndices: number[];
  paceMinSec: number | null;
  paceMaxSec: number | null;
  hrMin: number | null;
  hrMax: number | null;
  classification: PaceClassification;
}

/**
 * Snap a measured lap distance to the nearest standard athletics distance.
 * Returns null if the lap doesn't fit (warmup, cooldown, random lap split).
 *
 * Tolerance: within 15% or 100m of the standard, whichever is larger.
 * GPS overshoots are common (820 → 800m; 1630 → 1600m = mile).
 */
export function classifyDistance(
  metres: number | null | undefined
): RepBucket | null {
  if (!metres || metres <= 0) return null;
  let best = STANDARD_DISTANCES[0];
  for (const s of STANDARD_DISTANCES) {
    if (Math.abs(metres - s) < Math.abs(metres - best)) best = s;
  }
  const tolerance = Math.max(100, best * 0.15);
  if (Math.abs(metres - best) > tolerance) return null;
  return {
    key: `d:${best}`,
    label: distanceLabel(best),
    kind: "distance",
    size: best,
    metres: best,
  };
}

// Snap a measured lap moving_time to the nearest standard rep duration.
// Tolerance: within 15% or 30s of the standard, whichever is larger — slightly
// tighter than the distance one because watch-recorded time is exact but
// humans press lap a second or two off.
export function classifyTime(
  seconds: number | null | undefined
): RepBucket | null {
  if (!seconds || seconds <= 0) return null;
  let best = STANDARD_TIMES[0];
  for (const s of STANDARD_TIMES) {
    if (Math.abs(seconds - s) < Math.abs(seconds - best)) best = s;
  }
  const tolerance = Math.max(30, best * 0.15);
  if (Math.abs(seconds - best) > tolerance) return null;
  return {
    key: `t:${best}`,
    label: timeLabel(best),
    kind: "time",
    size: best,
    metres: 0, // n/a for time buckets; kept for RepBucket back-compat
  };
}

export function classifyRep(
  lap: AILap,
  mode: RepClassifierMode
): RepBucket | null {
  if (mode === "time") return classifyTime(lap.movingTime);
  return classifyDistance(lap.distance);
}

export function distanceLabel(m: number): string {
  if (m === 1600) return "mile";
  if (m === 3600) return "9 laps";
  if (m === 1000) return "1k";
  if (m === 2000) return "2k";
  return `${m}m`;
}

export function timeLabel(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}min` : `${m}:${s.toString().padStart(2, "0")}`;
}

export function classifyPace(
  secPerKm: number,
  effortMaxSec: number,
  jogMaxSec: number
): Exclude<PaceClassification, "mixed"> {
  if (secPerKm < effortMaxSec) return "effort";
  if (secPerKm < jogMaxSec) return "jog";
  return "standing";
}

/**
 * Merge consecutive effort laps (pace faster than effortMaxSec) into a single
 * combined lap, but only when it makes sense as one rep.
 *
 * Two guards on the merging:
 *
 *  1. **Big laps stay standalone.** Any lap that already snaps to a standard
 *     rep distance of 1km or larger is never merged with neighbours — it's a
 *     full rep on its own (a 1km threshold lap, a mile rep, a 2k cruise).
 *     This stops continuous threshold runs (lapped every km) from being
 *     collapsed into one giant un-classifiable chunk.
 *
 *  2. **Small-lap merges must snap.** Sub-1km effort laps can buffer and
 *     merge, but the result is only emitted as one merged rep if the combined
 *     distance snaps to a standard rep (e.g. 3×400m → 1200m ✓). If the
 *     combined distance doesn't snap (e.g. 4×300m = 1200m… does snap; 5×300m
 *     = 1500m doesn't), the laps are emitted individually instead — they
 *     were almost certainly per-section splits of a continuous effort, not
 *     sub-rep splits of a single rep.
 */
export function mergeConsecutiveEffortLaps(
  laps: AILap[],
  effortMaxSec: number,
  mode: RepClassifierMode = "distance"
): AILap[] {
  const sorted = [...laps].sort((a, b) => a.lapIndex - b.lapIndex);
  // Time-mode sessions (threshold / cruise intervals) are shown lap-by-lap
  // rather than collapsed into merged reps — the lap structure on the watch
  // already matches how the athlete thinks about them.
  if (mode === "time") return sorted;

  const out: AILap[] = [];
  let buffer: AILap[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    if (buffer.length === 1) {
      out.push(buffer[0]);
    } else {
      const merged = combineLaps(buffer);
      if (classifyDistance(merged.distance) != null) {
        out.push(merged);
      } else {
        // Combined distance isn't a standard rep — these were likely per-km
        // splits of a continuous effort. Keep them as-is.
        out.push(...buffer);
      }
    }
    buffer = [];
  };

  for (const lap of sorted) {
    const isEffort =
      lap.averageSpeed != null && 1000 / lap.averageSpeed < effortMaxSec;
    if (!isEffort) {
      flush();
      out.push(lap);
      continue;
    }
    // 1km+ standalone-rep guard: a lap that classifies to a 1km-or-larger
    // bucket is a full rep on its own and never merges with neighbours.
    const cls = classifyDistance(lap.distance);
    if (cls != null && cls.metres >= 1000) {
      flush();
      out.push(lap);
      continue;
    }
    buffer.push(lap);
  }
  flush();
  return out;
}

function combineLaps(laps: AILap[]): AILap {
  const totalDistance = laps.reduce((s, l) => s + (l.distance ?? 0), 0);
  const totalTime = laps.reduce((s, l) => s + (l.movingTime ?? 0), 0);
  let hrSum = 0;
  let hrWeight = 0;
  let maxHr: number | null = null;
  let cadSum = 0;
  let cadWeight = 0;
  for (const l of laps) {
    if (l.averageHeartrate != null && l.movingTime != null) {
      hrSum += l.averageHeartrate * l.movingTime;
      hrWeight += l.movingTime;
    }
    if (l.maxHeartrate != null && (maxHr == null || l.maxHeartrate > maxHr)) {
      maxHr = l.maxHeartrate;
    }
    if (l.averageCadence != null && l.movingTime != null) {
      cadSum += l.averageCadence * l.movingTime;
      cadWeight += l.movingTime;
    }
  }
  const first = laps[0];
  const last = laps[laps.length - 1];
  return {
    activityId: first.activityId,
    lapIndex: first.lapIndex,
    name: `Laps ${first.lapIndex}–${last.lapIndex}`,
    customName: null,
    distance: totalDistance,
    movingTime: totalTime,
    averageSpeed: totalTime > 0 ? totalDistance / totalTime : null,
    averageHeartrate: hrWeight > 0 ? hrSum / hrWeight : null,
    maxHeartrate: maxHr,
    averageCadence: cadWeight > 0 ? cadSum / cadWeight : null,
    lapType: first.lapType,
  };
}

/**
 * Group a session's laps by distance bucket, dropping any laps that don't
 * snap to a standard distance. Returns groups sorted by distance descending.
 *
 * Consecutive effort laps are merged first so e.g. 3×400m with no rest
 * registers as one 1200m rep.
 */
export function groupLapsByBucket(
  laps: AILap[],
  effortMaxSec: number,
  jogMaxSec: number
): RepGroup[] {
  const merged = mergeConsecutiveEffortLaps(laps, effortMaxSec);
  const byMetres = new Map<number, AILap[]>();
  for (const lap of merged) {
    const bucket = classifyDistance(lap.distance);
    if (!bucket) continue;
    const arr = byMetres.get(bucket.metres) ?? [];
    arr.push(lap);
    byMetres.set(bucket.metres, arr);
  }

  const groups: RepGroup[] = [];
  for (const [metres, lapList] of byMetres.entries()) {
    const sorted = [...lapList]
      .sort((a, b) => a.lapIndex - b.lapIndex)
      .map((l, idx) => ({ ...l, repNumber: idx + 1 }));

    const paces = sorted
      .filter((l) => l.averageSpeed)
      .map((l) => 1000 / l.averageSpeed!);
    const hrs = sorted
      .filter((l) => l.averageHeartrate)
      .map((l) => l.averageHeartrate!);

    const paceClassifications = new Set(
      paces.map((p) => classifyPace(p, effortMaxSec, jogMaxSec))
    );
    const classification: PaceClassification =
      paceClassifications.size === 1
        ? (paceClassifications.values().next().value as Exclude<
            PaceClassification,
            "mixed"
          >)
        : "mixed";

    groups.push({
      bucket: {
        key: `d:${metres}`,
        label: distanceLabel(metres),
        kind: "distance",
        size: metres,
        metres,
      },
      laps: sorted,
      lapIndices: sorted.map((l) => l.lapIndex),
      paceMinSec: paces.length ? Math.min(...paces) : null,
      paceMaxSec: paces.length ? Math.max(...paces) : null,
      hrMin: hrs.length ? Math.min(...hrs) : null,
      hrMax: hrs.length ? Math.max(...hrs) : null,
      classification,
    });
  }

  // Biggest distance first — matches typical session description
  // ("mile repeats with 400m recoveries").
  return groups.sort((a, b) => b.bucket.metres - a.bucket.metres);
}

export function formatPaceSec(sec: number | null): string {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Parse "4:00" or "3:45" → seconds/km. Returns null on invalid input. */
export function parsePaceMMSS(input: string): number | null {
  const match = /^(\d{1,2}):([0-5]?\d)$/.exec(input.trim());
  if (!match) return null;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

/**
 * One continuous block of effort — used for non-interval sessions (threshold,
 * easy, long, race) where the user cares about per-segment pace rather than
 * which standard rep distance a lap snaps to.
 *
 * A segment is a run of consecutive effort laps (faster than effortMaxSec)
 * with no recovery in between. Continuous threshold = one segment.
 * 3×12min threshold reps with jog recoveries = 3 segments.
 */
export interface EffortSegment {
  laps: AILap[];
  totalDistance: number; // metres
  totalTime: number;     // seconds
  avgPaceSec: number;    // sec per km
  hrAvg: number | null;
}

export function groupLapsIntoEffortSegments(
  laps: AILap[],
  effortMaxSec: number
): EffortSegment[] {
  const sorted = [...laps].sort((a, b) => a.lapIndex - b.lapIndex);
  const segments: EffortSegment[] = [];
  let buffer: AILap[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    const totalDistance = buffer.reduce((s, l) => s + (l.distance ?? 0), 0);
    const totalTime = buffer.reduce((s, l) => s + (l.movingTime ?? 0), 0);
    let hrSum = 0;
    let hrW = 0;
    for (const l of buffer) {
      if (l.averageHeartrate != null && l.movingTime != null) {
        hrSum += l.averageHeartrate * l.movingTime;
        hrW += l.movingTime;
      }
    }
    segments.push({
      laps: [...buffer],
      totalDistance,
      totalTime,
      avgPaceSec: totalDistance > 0 ? (totalTime / totalDistance) * 1000 : 0,
      hrAvg: hrW > 0 ? hrSum / hrW : null,
    });
    buffer = [];
  };

  for (const lap of sorted) {
    const isEffort =
      lap.averageSpeed != null && 1000 / lap.averageSpeed < effortMaxSec;
    if (isEffort) buffer.push(lap);
    else flush();
  }
  flush();
  return segments;
}

/**
 * Split a session's laps into alternating rep / recovery blocks. A lap is
 * flagged as "recovery" (vs effort) when either:
 *   • its moving_time ≤ `breakMaxTimeSec` (a short recovery lap pressed as
 *     its own lap on the watch, typical of 3×12min with rep/rec/rep/rec/rep
 *     user-laps), OR
 *   • its average pace is slower than the session's median pace by at least
 *     `breakPaceMarginPct`. Self-calibrating: a fast athlete (median 3:20)
 *     flags kms slower than ~3:28, a slower athlete with threshold at 5:00
 *     flags kms slower than ~5:12. This picks up both user-lap recoveries
 *     (sharply slower) and per-km splits that averaged in a recovery.
 * The function returns BOTH effort and recovery blocks in the order they
 * occurred — recoveries aren't dropped, so their pace is visible in the
 * rep-averages table.
 * Works the same way for:
 *   • 3×12min (five blocks: effort, rec, effort, rec, effort)
 *   • 3×8min / 3×10min (same shape)
 *   • 10k straight (one effort block; no laps qualify as recovery)
 *   • Any continuous run split into km laps (one effort block)
 */
export interface RepBlock {
  blockIndex: number;   // 1-based, across all blocks in the session
  kind: "effort" | "recovery";
  laps: AILap[];
  totalDistance: number; // metres
  totalTime: number;     // seconds
  avgPaceSec: number | null; // sec per km, weighted by distance
  hrAvg: number | null;
  lapStart: number;     // first lapIndex in this block
  lapEnd: number;       // last lapIndex in this block
}

export function groupLapsIntoBlocks(
  laps: AILap[],
  options: { breakMaxTimeSec?: number; breakPaceMarginPct?: number } = {}
): RepBlock[] {
  const breakMaxTimeSec = options.breakMaxTimeSec ?? 90;
  // 4% slower than the session's median lap pace = break. Picks up a per-km
  // split that averaged in a 1-min recovery (typically 4–6% slower than the
  // effort kms) while leaving inside-rep variation alone. Proportional so
  // the same rule works for a 3:20/km athlete and a 5:00/km athlete.
  const primaryMarginPct = options.breakPaceMarginPct ?? 0.04;

  const sorted = [...laps].sort((a, b) => a.lapIndex - b.lapIndex);

  const paces = sorted
    .filter((l) => l.averageSpeed != null && l.averageSpeed > 0)
    .map((l) => 1000 / l.averageSpeed!);
  const medianPace = paces.length > 0 ? medianOf(paces) : null;

  // Narrow-pace sessions (3×8min where effort is 3:26 and "recovery" kms
  // average 3:40 — only ~4% gap) fall under the primary margin. If 4% gives
  // zero breaks but tightening to 2% surfaces at least two, it's a rep
  // session with a compressed pace range; use the tighter margin. Requiring
  // ≥2 breaks at 2% prevents a single outlier km from splitting a genuine
  // continuous 10k.
  let marginPct = primaryMarginPct;
  if (medianPace != null) {
    const paceBreaksAt = (pct: number) =>
      paces.filter((p) => p > medianPace * (1 + pct)).length;
    if (paceBreaksAt(primaryMarginPct) === 0 && paceBreaksAt(0.02) >= 2) {
      marginPct = 0.02;
    }
  }
  const breakPaceSec =
    medianPace != null ? medianPace * (1 + marginPct) : null;

  const blocks: RepBlock[] = [];
  let buffer: AILap[] = [];
  let bufferKind: "effort" | "recovery" | null = null;

  const flush = () => {
    if (buffer.length === 0 || bufferKind === null) return;
    const totalDistance = buffer.reduce((s, l) => s + (l.distance ?? 0), 0);
    const totalTime = buffer.reduce((s, l) => s + (l.movingTime ?? 0), 0);
    let hrSum = 0;
    let hrW = 0;
    for (const l of buffer) {
      if (l.averageHeartrate != null && l.movingTime != null) {
        hrSum += l.averageHeartrate * l.movingTime;
        hrW += l.movingTime;
      }
    }
    blocks.push({
      blockIndex: blocks.length + 1,
      kind: bufferKind,
      laps: [...buffer],
      totalDistance,
      totalTime,
      avgPaceSec: totalDistance > 0 ? (totalTime / totalDistance) * 1000 : null,
      hrAvg: hrW > 0 ? hrSum / hrW : null,
      lapStart: buffer[0].lapIndex,
      lapEnd: buffer[buffer.length - 1].lapIndex,
    });
    buffer = [];
    bufferKind = null;
  };

  for (const lap of sorted) {
    const shortLap = (lap.movingTime ?? 0) <= breakMaxTimeSec;
    const slowLap =
      breakPaceSec != null &&
      lap.averageSpeed != null &&
      1000 / lap.averageSpeed > breakPaceSec;
    const lapKind: "effort" | "recovery" =
      shortLap || slowLap ? "recovery" : "effort";
    if (bufferKind !== null && lapKind !== bufferKind) flush();
    buffer.push(lap);
    bufferKind = lapKind;
  }
  flush();
  return blocks;
}

function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Slice a session's laps into effort blocks following an explicit user
 * structure (e.g. 3×8min / 1min rec). Starts from lap 1; if your activity
 * has a separate warmup lap set, slicing will shift accordingly.
 *
 * We walk laps sequentially while tracking phase state (effort vs recovery,
 * which rep we're in, how far into the current phase). When a lap straddles
 * a phase boundary, its time and distance are prorated between the phases
 * so each effort block only counts the portion of each lap that was
 * actually part of that rep — no recovery time or distance bleeds into the
 * effort averages.
 *
 * Empty effort windows (fewer laps than the structure expects) return as
 * blocks with null pace so the user sees "Rep 3 — no data" instead of a
 * silently-dropped rep.
 */
export function sliceByStructure(
  laps: AILap[],
  structure: RepStructure
): RepBlock[] {
  const sortedLaps = [...laps].sort((a, b) => a.lapIndex - b.lapIndex);

  interface Accum {
    distance: number;
    time: number;
    hrWeightedSum: number;
    hrWeight: number;
    firstLapIndex: number | null;
    lastLapIndex: number | null;
  }
  const accums: Accum[] = Array.from({ length: structure.reps }, () => ({
    distance: 0,
    time: 0,
    hrWeightedSum: 0,
    hrWeight: 0,
    firstLapIndex: null,
    lastLapIndex: null,
  }));

  let phase: "effort" | "recovery" = "effort";
  let currentRep = 0;
  let effortProgress = 0;
  let recProgress = 0;

  for (const lap of sortedLaps) {
    const totalTime = lap.movingTime ?? 0;
    const totalDist = lap.distance ?? 0;
    if (totalTime <= 0) continue;

    let remainingTime = totalTime;
    let remainingDist = totalDist;
    const hr = lap.averageHeartrate;

    while (currentRep < structure.reps && (remainingTime > 0 || remainingDist > 0)) {
      if (phase === "effort") {
        const phaseAxisLeft = structure.repSize - effortProgress;
        const lapAxisLeft =
          structure.mode === "time" ? remainingTime : remainingDist;
        if (lapAxisLeft <= 0) break;

        let consumeTime: number;
        let consumeDist: number;
        if (lapAxisLeft <= phaseAxisLeft + 1e-6) {
          // Rest of the lap fits inside the current effort rep.
          consumeTime = remainingTime;
          consumeDist = remainingDist;
          effortProgress += lapAxisLeft;
        } else {
          // Rep completes mid-lap; take the portion that fits.
          if (structure.mode === "time") {
            consumeTime = phaseAxisLeft;
            consumeDist = totalDist * (consumeTime / totalTime);
          } else {
            consumeDist = phaseAxisLeft;
            consumeTime = totalTime * (consumeDist / totalDist);
          }
          effortProgress = 0;
          phase = "recovery";
          recProgress = 0;
        }

        accums[currentRep].distance += consumeDist;
        accums[currentRep].time += consumeTime;
        if (hr != null) {
          accums[currentRep].hrWeightedSum += hr * consumeTime;
          accums[currentRep].hrWeight += consumeTime;
        }
        if (accums[currentRep].firstLapIndex == null) {
          accums[currentRep].firstLapIndex = lap.lapIndex;
        }
        accums[currentRep].lastLapIndex = lap.lapIndex;

        remainingTime -= consumeTime;
        remainingDist -= consumeDist;

        // If that was the final rep, drop the rest of the activity.
        if (phase === "recovery" && currentRep + 1 >= structure.reps) {
          currentRep = structure.reps;
          break;
        }
      } else {
        // Recovery: always time-based. Distance swallowed with it but
        // discarded since it doesn't belong to any rep.
        const recLeft = structure.recSec - recProgress;
        if (recLeft <= 0) {
          // No recovery (e.g. recSec = 0) — jump straight to the next rep.
          phase = "effort";
          currentRep += 1;
          continue;
        }
        let consumeTime: number;
        let consumeDist: number;
        if (remainingTime <= recLeft + 1e-6) {
          consumeTime = remainingTime;
          consumeDist = remainingDist;
          recProgress += consumeTime;
        } else {
          consumeTime = recLeft;
          consumeDist = totalDist * (consumeTime / totalTime);
          recProgress = 0;
          phase = "effort";
          currentRep += 1;
        }
        remainingTime -= consumeTime;
        remainingDist -= consumeDist;
      }
    }
    if (currentRep >= structure.reps) break;
  }

  return accums.map((acc, idx) => ({
    blockIndex: idx + 1,
    kind: "effort" as const,
    laps: [],
    totalDistance: acc.distance,
    totalTime: acc.time,
    avgPaceSec: acc.distance > 0 ? (acc.time / acc.distance) * 1000 : null,
    hrAvg: acc.hrWeight > 0 ? acc.hrWeightedSum / acc.hrWeight : null,
    lapStart: acc.firstLapIndex ?? 0,
    lapEnd: acc.lastLapIndex ?? 0,
  }));
}

/** Fastest lap pace (sec/km) across laps that snap to a standard distance,
 *  after merging consecutive efforts so multi-lap reps are scored as one rep. */
export function fastestClassifiedPace(
  laps: AILap[],
  effortMaxSec: number = DEFAULT_EFFORT_MAX_SEC
): number | null {
  const merged = mergeConsecutiveEffortLaps(laps, effortMaxSec);
  const paces = merged
    .filter((l) => l.averageSpeed && classifyDistance(l.distance))
    .map((l) => 1000 / l.averageSpeed!);
  return paces.length ? Math.min(...paces) : null;
}
