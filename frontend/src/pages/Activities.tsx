import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  getActivities,
  updateActivityCategory,
  updateActivity,
  bulkUpdateCategory,
  bulkUpdateStructure,
  getAIInsight,
  activityToAI,
  type Activity,
  type AIInsightResponse,
  type RepStructure,
} from "../api/client";
import CompareModal from "./CompareModal";
import CoachPlot from "./CoachPlot";
import { formatMarkdown } from "../lib/markdown";
import "./Coach.css";
import "./Activities.css";

// The 11 training categories. `sessionType` on the backend maps these down to
// a 7-bucket pill palette (see classifySession in services/strava.ts).
const TRAINING_CATEGORIES = [
  "Easy Run",
  "Recovery Run",
  "Long Run",
  "Threshold",
  "Marathon Session",
  "Intervals",
  "Race",
  "WU/CD",
  "Heat Run",
  "Treadmill",
];

// CSS colour class per category. Mirrors the type-pill palette in Coach.css.
const CATEGORY_CLASS: Record<string, string> = {
  "Easy Run": "cat-easy",
  "Recovery Run": "cat-easy",
  "Long Run": "cat-long",
  "Threshold": "cat-threshold",
  "Marathon Session": "cat-long",
  "Intervals": "cat-interval",
  "Race": "cat-race",
  "WU/CD": "cat-warmup",
  "Heat Run": "cat-easy",
  "Treadmill": "cat-easy",
};

function categoryClass(cat: string | null | undefined): string {
  if (!cat) return "cat-none";
  return CATEGORY_CLASS[cat] ?? "cat-none";
}

const UNCATEGORISED = "__uncategorised__";

// Category chip order in the filter bar. Intentionally differs from
// TRAINING_CATEGORIES (which drives the per-row edit dropdown).
const FILTER_CATEGORIES: string[] = [
  "Intervals",
  "Threshold",
  "Marathon Session",
  "Long Run",
  "Race",
  "Heat Run",
  "Easy Run",
  "Recovery Run",
  "Treadmill",
  UNCATEGORISED,
  "WU/CD",
];

// Label overrides for the filter chips only — values stay as the real
// trainingCategory string so filter logic is unaffected.
const FILTER_LABELS: Record<string, string> = {
  "Recovery Run": "Rec Run",
  [UNCATEGORISED]: "Uncategorised",
};

const DATE_PRESETS: { label: string; days: number | null }[] = [
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
  { label: "2y", days: 730 },
  { label: "All", days: null },
];

// Starter prompts surfaced as clickable chips so the user doesn't stare at an
// empty input. Picked to lean on things the chart alone can't answer.
const QUESTION_SUGGESTIONS: string[] = [
  "Is my HR drifting up at the same paces, or am I just running harder?",
  "Which sessions look like breakthroughs vs. bad days?",
  "Am I getting fitter, or just trying harder?",
  "Any signs of fatigue or overreaching recently?",
  "How consistent is my pace across reps in a session?",
  "Compare my pace and HR trends side by side",
];

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
function matchesPreset(from: string, to: string, days: number | null): boolean {
  if (days == null) return !from && !to;
  if (!from || !to) return false;
  return from === isoDaysAgo(days) && to === isoToday();
}

function formatDistance(meters: number | null): string {
  if (!meters) return "-";
  return (meters / 1000).toFixed(2) + " km";
}
function formatPace(speedMs: number | null): string {
  if (!speedMs || speedMs === 0) return "-";
  const paceMin = 1000 / 60 / speedMs;
  const mins = Math.floor(paceMin);
  const secs = Math.round((paceMin - mins) * 60);
  return `${mins}:${secs.toString().padStart(2, "0")} /km`;
}
function formatDuration(seconds: number | null): string {
  if (!seconds) return "-";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

// ---- Rep structure presets + helpers ----------------------------------
// "null" preset = Auto (no structure stored). The rest cover the athlete's
// usual session shapes; custom is handled by tweaking the form inputs.
interface Preset {
  label: string;
  value: RepStructure | null;
}
const STRUCTURE_PRESETS: Preset[] = [
  { label: "Auto", value: null },
  { label: "3 × 6min / 1min", value: { mode: "time", reps: 3, repSize: 360, recSec: 60 } },
  { label: "3 × 8min / 1min", value: { mode: "time", reps: 3, repSize: 480, recSec: 60 } },
  { label: "3 × 10min / 1min", value: { mode: "time", reps: 3, repSize: 600, recSec: 60 } },
  { label: "3 × 12min / 1min", value: { mode: "time", reps: 3, repSize: 720, recSec: 60 } },
  { label: "3 × 15min / 1min", value: { mode: "time", reps: 3, repSize: 900, recSec: 60 } },
  { label: "4 × 8min / 1min", value: { mode: "time", reps: 4, repSize: 480, recSec: 60 } },
  { label: "5 × 1km / 1min", value: { mode: "distance", reps: 5, repSize: 1000, recSec: 60 } },
];

function formatRepSize(s: RepStructure): string {
  if (s.mode === "time") {
    const m = Math.floor(s.repSize / 60);
    const sec = s.repSize % 60;
    return sec === 0 ? `${m}min` : `${m}:${sec.toString().padStart(2, "0")}`;
  }
  if (s.repSize >= 1000) {
    return s.repSize % 1000 === 0
      ? `${s.repSize / 1000}km`
      : `${(s.repSize / 1000).toFixed(1)}km`;
  }
  return `${s.repSize}m`;
}

function formatRecovery(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}min` : `${m}:${s.toString().padStart(2, "0")}`;
}

function formatStructure(s: RepStructure | null | undefined): string {
  if (!s) return "—";
  return `${s.reps}×${formatRepSize(s)}/${formatRecovery(s.recSec)}`;
}

function RepStructureCell({
  activity,
  onUpdated,
}: {
  activity: Activity;
  onUpdated: (id: number, structure: RepStructure | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<"" | "time" | "distance">(
    activity.repStructure?.mode ?? ""
  );
  const [reps, setReps] = useState<number>(activity.repStructure?.reps ?? 3);
  // Display in the athlete's unit (min or km); convert to sec/m on save.
  const [sizeInput, setSizeInput] = useState<number>(() => {
    if (!activity.repStructure) return 8;
    return activity.repStructure.mode === "time"
      ? activity.repStructure.repSize / 60
      : activity.repStructure.repSize / 1000;
  });
  const [recInput, setRecInput] = useState<number>(
    activity.repStructure?.recSec ?? 60
  );
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    const s = activity.repStructure;
    setMode(s?.mode ?? "");
    setReps(s?.reps ?? 3);
    setSizeInput(s ? (s.mode === "time" ? s.repSize / 60 : s.repSize / 1000) : 8);
    setRecInput(s?.recSec ?? 60);
    setEditing(true);
  };

  const applyPreset = (idx: string) => {
    if (idx === "") return;
    const p = STRUCTURE_PRESETS[Number(idx)];
    if (!p.value) {
      setMode("");
      return;
    }
    setMode(p.value.mode);
    setReps(p.value.reps);
    setSizeInput(p.value.mode === "time" ? p.value.repSize / 60 : p.value.repSize / 1000);
    setRecInput(p.value.recSec);
  };

  const save = async () => {
    setSaving(true);
    const structure: RepStructure | null =
      mode === ""
        ? null
        : {
            mode,
            reps,
            repSize:
              mode === "time"
                ? Math.round(sizeInput * 60)
                : Math.round(sizeInput * 1000),
            recSec: Math.round(recInput),
          };
    try {
      await updateActivity(activity.id, { repStructure: structure });
      onUpdated(activity.id, structure);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <span className="structure-display" onClick={startEdit} title="Click to edit">
        {formatStructure(activity.repStructure)}
      </span>
    );
  }

  return (
    <span className="structure-edit">
      <select
        defaultValue=""
        onChange={(e) => {
          applyPreset(e.target.value);
          e.target.value = "";
        }}
        title="Apply preset"
      >
        <option value="">Preset…</option>
        {STRUCTURE_PRESETS.map((p, i) => (
          <option key={i} value={String(i)}>{p.label}</option>
        ))}
      </select>
      <select value={mode} onChange={(e) => setMode(e.target.value as "" | "time" | "distance")}>
        <option value="">Auto</option>
        <option value="time">Time</option>
        <option value="distance">Distance</option>
      </select>
      {mode !== "" && (
        <>
          <input
            type="number"
            min={1}
            value={reps}
            onChange={(e) => setReps(Number(e.target.value))}
            style={{ width: "3rem" }}
          />
          ×
          <input
            type="number"
            min={0}
            step={mode === "time" ? 0.5 : 0.1}
            value={sizeInput}
            onChange={(e) => setSizeInput(Number(e.target.value))}
            style={{ width: "4rem" }}
          />
          <span>{mode === "time" ? "min" : "km"}</span>
          <span>/</span>
          <input
            type="number"
            min={0}
            step={15}
            value={recInput}
            onChange={(e) => setRecInput(Number(e.target.value))}
            style={{ width: "4rem" }}
          />
          <span>s rec</span>
        </>
      )}
      <button onClick={save} disabled={saving} className="btn btn-sm">Save</button>
      <button onClick={() => setEditing(false)} disabled={saving} className="btn btn-sm">Cancel</button>
    </span>
  );
}

// Structure editor used in the bulk-action bar. Mirrors the single-row cell
// editor's controls but has its own internal state and calls back with the
// chosen structure when Apply is pressed.
function BulkStructureControl({
  onApply,
  disabled,
}: {
  onApply: (structure: RepStructure | null) => Promise<void> | void;
  disabled: boolean;
}) {
  const [mode, setMode] = useState<"" | "time" | "distance">("");
  const [reps, setReps] = useState(3);
  const [sizeInput, setSizeInput] = useState(8);
  const [recInput, setRecInput] = useState(60);
  const [applying, setApplying] = useState(false);

  const applyPreset = (idx: string) => {
    if (idx === "") return;
    const p = STRUCTURE_PRESETS[Number(idx)];
    if (!p.value) {
      setMode("");
      return;
    }
    setMode(p.value.mode);
    setReps(p.value.reps);
    setSizeInput(
      p.value.mode === "time" ? p.value.repSize / 60 : p.value.repSize / 1000
    );
    setRecInput(p.value.recSec);
  };

  const handleApply = async () => {
    setApplying(true);
    const structure: RepStructure | null =
      mode === ""
        ? null
        : {
            mode,
            reps,
            repSize:
              mode === "time"
                ? Math.round(sizeInput * 60)
                : Math.round(sizeInput * 1000),
            recSec: Math.round(recInput),
          };
    try {
      await onApply(structure);
    } finally {
      setApplying(false);
    }
  };

  return (
    <>
      <span className="bulk-sep">|</span>
      <span>Structure:</span>
      <select
        defaultValue=""
        onChange={(e) => {
          applyPreset(e.target.value);
          e.target.value = "";
        }}
        title="Apply preset"
      >
        <option value="">Preset…</option>
        {STRUCTURE_PRESETS.map((p, i) => (
          <option key={i} value={String(i)}>{p.label}</option>
        ))}
      </select>
      <select
        value={mode}
        onChange={(e) => setMode(e.target.value as "" | "time" | "distance")}
      >
        <option value="">Clear</option>
        <option value="time">Time</option>
        <option value="distance">Distance</option>
      </select>
      {mode !== "" && (
        <>
          <input
            type="number"
            min={1}
            value={reps}
            onChange={(e) => setReps(Number(e.target.value))}
            style={{ width: "3rem" }}
          />
          ×
          <input
            type="number"
            min={0}
            step={mode === "time" ? 0.5 : 0.1}
            value={sizeInput}
            onChange={(e) => setSizeInput(Number(e.target.value))}
            style={{ width: "4rem" }}
          />
          <span>{mode === "time" ? "min" : "km"}</span>
          <span>/</span>
          <input
            type="number"
            min={0}
            step={15}
            value={recInput}
            onChange={(e) => setRecInput(Number(e.target.value))}
            style={{ width: "4rem" }}
          />
          <span>s rec</span>
        </>
      )}
      <button
        onClick={handleApply}
        disabled={disabled || applying}
        className="btn btn-primary btn-sm"
      >
        Apply structure
      </button>
    </>
  );
}

function CategoryCell({
  activity,
  onUpdated,
}: {
  activity: Activity;
  onUpdated: (id: number, cat: string | null) => void;
}) {
  const handleChange = async (value: string) => {
    const category = value || null;
    await updateActivityCategory(activity.id, category);
    onUpdated(activity.id, category);
  };
  return (
    <select
      className={`category-select pill ${categoryClass(activity.trainingCategory)}`}
      value={activity.trainingCategory || ""}
      onChange={(e) => handleChange(e.target.value)}
      title={activity.trainingCategory || "Uncategorised"}
    >
      <option value="">{activity.sportType || "-"}</option>
      {TRAINING_CATEGORIES.map((cat) => (
        <option key={cat} value={cat}>{cat}</option>
      ))}
    </select>
  );
}

function NameCell({
  activity,
  onRenamed,
}: {
  activity: Activity;
  onRenamed: (id: number, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(activity.name);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === activity.name) { setEditing(false); return; }
    setSaving(true);
    await updateActivity(activity.id, { name: trimmed });
    onRenamed(activity.id, trimmed);
    setEditing(false);
    setSaving(false);
  };

  if (!editing) {
    return (
      <span>
        <Link to={`/activities/${activity.id}`}>{activity.name}</Link>
        <span
          className="edit-icon"
          onClick={() => { setValue(activity.name); setEditing(true); }}
          title="Rename"
        >&#9998;</span>
      </span>
    );
  }
  return (
    <span className="name-edit">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
        autoFocus
        disabled={saving}
      />
      <button onClick={save} disabled={saving} className="btn btn-sm">Save</button>
      <button onClick={() => setEditing(false)} disabled={saving} className="btn btn-sm">Cancel</button>
    </span>
  );
}

type SortKey = "date" | "name" | "type" | "distance" | "pace" | "duration" | "hr";

function SortHeader({ label, field, current, order, onSort }: {
  label: string;
  field: SortKey;
  current: SortKey;
  order: "asc" | "desc";
  onSort: (field: SortKey) => void;
}) {
  const active = current === field;
  const arrow = active ? (order === "asc" ? " \u25B2" : " \u25BC") : "";
  return (
    <th className="sortable-th" onClick={() => onSort(field)}>
      {label}{arrow}
    </th>
  );
}

interface Filters {
  // "__uncategorised__" sits alongside real categories in the array and
  // expands to IS NULL on the backend.
  categories: string[];
  from: string;
  to: string;
  search: string;
}

const INITIAL_FILTERS: Filters = {
  categories: [],
  from: "",
  to: "",
  search: "",
};

export default function Activities() {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS);
  const [sortBy, setSortBy] = useState<SortKey>("date");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [total, setTotal] = useState(0);
  // Selection is cached as full Activity objects so rows ticked on one page
  // remain available for Compare/bulk after paginating, filtering, or sorting.
  const [selectedMap, setSelectedMap] = useState<Map<number, Activity>>(new Map());
  const [bulkCategory, setBulkCategory] = useState("");

  const [question, setQuestion] = useState("");
  const [insight, setInsight] = useState<AIInsightResponse | null>(null);
  const [insightLoading, setInsightLoading] = useState(false);
  const [insightError, setInsightError] = useState<string | null>(null);
  const [insightOpen, setInsightOpen] = useState(true);

  const [showCompare, setShowCompare] = useState(false);

  const load = () => {
    const params: Record<string, string | string[] | undefined> = {
      page: String(page),
      limit: "20",
      sort_by: sortBy,
      order: sortOrder,
    };
    if (filters.categories.length > 0) params.category = filters.categories;
    if (filters.from) params.from = filters.from;
    if (filters.to) params.to = filters.to;
    if (filters.search) params.search = filters.search;
    getActivities(params).then((r) => {
      setActivities(r.activities);
      setTotal(r.total);
      // Don't clear selection — user may be assembling a cross-page set.
      // Refresh cached copies for any selected rows that appear on this page.
      setSelectedMap((prev) => {
        if (prev.size === 0) return prev;
        const next = new Map(prev);
        for (const a of r.activities) {
          if (next.has(a.id)) next.set(a.id, a);
        }
        return next;
      });
    });
  };

  useEffect(() => { load(); }, [page, filters, sortBy, sortOrder]);

  const handleSort = (field: SortKey) => {
    if (field === sortBy) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortOrder(field === "name" ? "asc" : "desc");
    }
    setPage(1);
  };

  // Patch an activity in both the visible list and the selection cache so the
  // Compare modal and bulk ops keep seeing fresh data even after edits.
  const patchActivity = (id: number, patch: Partial<Activity>) => {
    setActivities((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    setSelectedMap((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.set(id, { ...next.get(id)!, ...patch });
      return next;
    });
  };

  const handleCategoryUpdated = (id: number, category: string | null) => {
    patchActivity(id, { trainingCategory: category });
  };
  const handleStructureUpdated = (
    id: number,
    structure: RepStructure | null
  ) => {
    patchActivity(id, { repStructure: structure });
  };
  const handleRenamed = (id: number, name: string) => {
    patchActivity(id, { name });
  };
  const toggleSelect = (a: Activity) => {
    setSelectedMap((prev) => {
      const next = new Map(prev);
      if (next.has(a.id)) next.delete(a.id); else next.set(a.id, a);
      return next;
    });
  };
  const allOnPageSelected =
    activities.length > 0 && activities.every((a) => selectedMap.has(a.id));
  const toggleSelectAll = () => {
    setSelectedMap((prev) => {
      const next = new Map(prev);
      if (allOnPageSelected) {
        for (const a of activities) next.delete(a.id);
      } else {
        for (const a of activities) next.set(a.id, a);
      }
      return next;
    });
  };

  const selectedOnOtherPages =
    [...selectedMap.keys()].filter((id) => !activities.some((a) => a.id === id)).length;

  const handleBulkAssign = async () => {
    if (selectedMap.size === 0 || !bulkCategory) return;
    const category = bulkCategory === "__clear__" ? null : bulkCategory;
    const ids = [...selectedMap.keys()];
    await bulkUpdateCategory(ids, category);
    setActivities((prev) =>
      prev.map((a) => selectedMap.has(a.id) ? { ...a, trainingCategory: category } : a)
    );
    setSelectedMap(new Map());
    setBulkCategory("");
  };

  const handleBulkStructure = async (structure: RepStructure | null) => {
    if (selectedMap.size === 0) return;
    const ids = [...selectedMap.keys()];
    await bulkUpdateStructure(ids, structure);
    setActivities((prev) =>
      prev.map((a) =>
        selectedMap.has(a.id) ? { ...a, repStructure: structure } : a
      )
    );
    setSelectedMap(new Map());
  };

  const toggleFilterCategory = (cat: string) => {
    setFilters((f) => {
      const has = f.categories.includes(cat);
      const next = has
        ? f.categories.filter((c) => c !== cat)
        : [...f.categories, cat];
      return { ...f, categories: next };
    });
    setPage(1);
  };

  const setDateRangeDays = (days: number | null) => {
    setFilters((f) =>
      days == null
        ? { ...f, from: "", to: "" }
        : { ...f, from: isoDaysAgo(days), to: isoToday() }
    );
    setPage(1);
  };

  // Filter opts for the AI endpoint — mirrors the server-side list filter so
  // the AI sees the same scope as the table (not just the visible page).
  const activeFilterOpts = useMemo(
    () => ({
      categories: filters.categories.length > 0 ? filters.categories : undefined,
      from: filters.from || undefined,
      to: filters.to || undefined,
      search: filters.search || undefined,
    }),
    [filters]
  );

  const askAI = async (overrideQuestion?: string) => {
    const q = (overrideQuestion ?? question).trim();
    if (!q || insightLoading) return;
    if (overrideQuestion !== undefined) setQuestion(overrideQuestion);
    setInsightLoading(true);
    setInsightError(null);
    try {
      const res = await getAIInsight({ question: q, filters: activeFilterOpts });
      setInsight(res);
      setInsightOpen(true);
    } catch (err) {
      setInsightError(err instanceof Error ? err.message : String(err));
    } finally {
      setInsightLoading(false);
    }
  };
  const clearInsight = () => {
    setInsight(null);
    setInsightError(null);
    setQuestion("");
  };

  const selectedActivities = useMemo(
    () => [...selectedMap.values()].map(activityToAI),
    [selectedMap]
  );

  return (
    <div className="page">
      <h1>
        Activities{" "}
        <span style={{ fontSize: "1rem", fontWeight: 400, color: "#94a3b8" }}>
          ({total})
        </span>
      </h1>

      <div className="filters card">
        <input
          type="text"
          placeholder="Search name..."
          value={filters.search}
          onChange={(e) => { setFilters({ ...filters, search: e.target.value }); setPage(1); }}
        />
        <input
          type="date"
          value={filters.from}
          onChange={(e) => { setFilters({ ...filters, from: e.target.value }); setPage(1); }}
        />
        <input
          type="date"
          value={filters.to}
          onChange={(e) => { setFilters({ ...filters, to: e.target.value }); setPage(1); }}
        />
        <div className="date-presets">
          {DATE_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className={`date-preset-chip ${matchesPreset(filters.from, filters.to, p.days) ? "is-on" : ""}`}
              onClick={() => setDateRangeDays(p.days)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="category-filter-bar card">
        <span className="filter-label">Categories:</span>
        <div className="category-chips">
          {FILTER_CATEGORIES.map((cat) => {
            const on = filters.categories.includes(cat);
            const label = FILTER_LABELS[cat] ?? cat;
            return (
              <label
                key={cat}
                className={`bucket-chip cat-chip ${categoryClass(cat === UNCATEGORISED ? null : cat)} ${on ? "is-on" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggleFilterCategory(cat)}
                />
                <span>{label}</span>
              </label>
            );
          })}
          {filters.categories.length > 0 && (
            <button
              type="button"
              className="bucket-filter-action"
              onClick={() => { setFilters((f) => ({ ...f, categories: [] })); setPage(1); }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="card ai-coach-panel">
        <div className="ai-coach-header">
          <span className="ai-coach-title">AI Coach</span>
          <span className="ai-coach-hint">— scoped to the current filters</span>
        </div>

        <form
          className="coach-input-form"
          onSubmit={(e) => { e.preventDefault(); askAI(); }}
        >
          <input
            className="coach-input"
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about your filtered activities…"
            disabled={insightLoading}
          />
          <button
            className="coach-send btn btn-primary"
            type="submit"
            disabled={insightLoading || !question.trim()}
          >
            {insightLoading ? "Asking…" : "Ask AI"}
          </button>
        </form>

        <div className="coach-suggestions">
          <span className="coach-suggestions-label">Try:</span>
          {QUESTION_SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className="coach-suggestion-chip"
              onClick={() => askAI(s)}
              disabled={insightLoading}
              title={s}
            >
              {s}
            </button>
          ))}
        </div>

        {insightError && <div className="coach-error">Error: {insightError}</div>}

        {insightLoading && (
          <div className="coach-loading">
            <div className="typing-indicator"><span /><span /><span /></div>
            <div className="coach-loading-text">Crunching the filtered set…</div>
          </div>
        )}

        <CoachPlot filterOpts={activeFilterOpts} />

        {insight && !insightLoading && (
          <div className="message message--assistant">
            <div className="message-meta message-meta--top">
              <span>
                Analysed {insight.activitiesAnalysed}{" "}
                {insight.activitiesAnalysed === 1 ? "activity" : "activities"}
                {insight.truncated && (
                  <>
                    {" "}
                    <span className="message-meta-warn">
                      (capped at {insight.maxActivities} — narrow filters for the rest)
                    </span>
                  </>
                )}
              </span>
              <button
                className="message-toggle"
                onClick={() => setInsightOpen((o) => !o)}
              >
                {insightOpen ? "Hide answer" : "Show answer"}
              </button>
              <button
                className="message-toggle"
                onClick={clearInsight}
                title="Clear this answer"
              >
                ← Clear
              </button>
            </div>
            {insightOpen && (
              <div className="message-bubble">
                <div
                  className="message-content"
                  dangerouslySetInnerHTML={{ __html: formatMarkdown(insight.answer) }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {selectedMap.size > 0 && (
        <div className="bulk-bar card">
          <span>
            {selectedMap.size} selected
            {selectedOnOtherPages > 0 && (
              <span style={{ color: "#94a3b8", fontWeight: 400 }}>
                {" "}
                ({selectedOnOtherPages} on other pages)
              </span>
            )}
          </span>
          <span>Category:</span>
          <select value={bulkCategory} onChange={(e) => setBulkCategory(e.target.value)}>
            <option value="">Assign…</option>
            <option value="__clear__">Clear category</option>
            {TRAINING_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
          <button
            onClick={handleBulkAssign}
            className="btn btn-primary btn-sm"
            disabled={!bulkCategory}
          >
            Apply
          </button>
          <BulkStructureControl
            onApply={handleBulkStructure}
            disabled={selectedMap.size === 0}
          />
          <span className="bulk-sep">|</span>
          <button
            onClick={() => setShowCompare(true)}
            className="btn btn-sm"
            disabled={selectedMap.size < 2}
            title={selectedMap.size < 2 ? "Select at least 2 rows" : undefined}
          >
            Compare
          </button>
          <button onClick={() => setSelectedMap(new Map())} className="btn btn-sm">
            Cancel
          </button>
        </div>
      )}

      <table className="activity-table">
        <thead>
          <tr>
            <th style={{ width: "2rem" }}>
              <input
                type="checkbox"
                checked={allOnPageSelected}
                onChange={toggleSelectAll}
              />
            </th>
            <SortHeader label="Date" field="date" current={sortBy} order={sortOrder} onSort={handleSort} />
            <SortHeader label="Name" field="name" current={sortBy} order={sortOrder} onSort={handleSort} />
            <SortHeader label="Category" field="type" current={sortBy} order={sortOrder} onSort={handleSort} />
            <th>Structure</th>
            <SortHeader label="Distance" field="distance" current={sortBy} order={sortOrder} onSort={handleSort} />
            <SortHeader label="Pace" field="pace" current={sortBy} order={sortOrder} onSort={handleSort} />
            <SortHeader label="Duration" field="duration" current={sortBy} order={sortOrder} onSort={handleSort} />
            <SortHeader label="HR" field="hr" current={sortBy} order={sortOrder} onSort={handleSort} />
          </tr>
        </thead>
        <tbody>
          {activities.map((a) => (
            <tr key={a.id} className={selectedMap.has(a.id) ? "row-selected" : ""}>
              <td>
                <input
                  type="checkbox"
                  checked={selectedMap.has(a.id)}
                  onChange={() => toggleSelect(a)}
                />
              </td>
              <td>{new Date(a.startDate).toLocaleDateString()}</td>
              <td><NameCell activity={a} onRenamed={handleRenamed} /></td>
              <td><CategoryCell activity={a} onUpdated={handleCategoryUpdated} /></td>
              <td><RepStructureCell activity={a} onUpdated={handleStructureUpdated} /></td>
              <td>{formatDistance(a.distance)}</td>
              <td>{formatPace(a.averageSpeed)}</td>
              <td>{formatDuration(a.movingTime)}</td>
              <td>{a.averageHeartrate ? Math.round(a.averageHeartrate) : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="pagination">
        <button
          onClick={() => setPage(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="btn"
        >
          Previous
        </button>
        <span>Page {page} of {Math.max(1, Math.ceil(total / 20))}</span>
        <button
          onClick={() => setPage(page + 1)}
          disabled={page * 20 >= total}
          className="btn"
        >
          Next
        </button>
      </div>

      {showCompare && selectedActivities.length >= 2 && (
        <CompareModal
          activities={selectedActivities}
          onClose={() => setShowCompare(false)}
        />
      )}
    </div>
  );
}
