import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  getActivities,
  updateActivityCategory,
  updateActivity,
  bulkUpdateCategory,
  getAIInsight,
  activityToAI,
  type Activity,
  type AIInsightResponse,
} from "../api/client";
import CompareModal from "./CompareModal";
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
  "Cross Training",
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
  "Cross Training": "cat-crosstraining",
  "Heat Run": "cat-easy",
  "Treadmill": "cat-easy",
};

function categoryClass(cat: string | null | undefined): string {
  if (!cat) return "cat-none";
  return CATEGORY_CLASS[cat] ?? "cat-none";
}

const UNCATEGORISED = "__uncategorised__";

const DATE_PRESETS: { label: string; days: number | null }[] = [
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
  { label: "2y", days: 730 },
  { label: "All", days: null },
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

// Line-based markdown → HTML for the AI response bubble (headers, lists, hr,
// blockquotes, paragraphs, inline bold/italic/code).
function formatMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inList = false;
  let inBQ = false;
  let para: string[] = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.join(" ")}</p>`); para = []; } };
  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };
  const closeBQ = () => { if (inBQ) { out.push("</blockquote>"); inBQ = false; } };
  const closeAll = () => { flushPara(); closeList(); closeBQ(); };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeAll(); continue; }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^####\s+(.*)$/))) { closeAll(); out.push(`<h4>${formatInline(m[1])}</h4>`); }
    else if ((m = line.match(/^###\s+(.*)$/))) { closeAll(); out.push(`<h3>${formatInline(m[1])}</h3>`); }
    else if ((m = line.match(/^##\s+(.*)$/))) { closeAll(); out.push(`<h2>${formatInline(m[1])}</h2>`); }
    else if (/^---+$/.test(line)) { closeAll(); out.push("<hr>"); }
    else if ((m = line.match(/^[-*]\s+(.*)$/))) {
      flushPara(); closeBQ();
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${formatInline(m[1])}</li>`);
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara(); closeList();
      if (!inBQ) { out.push("<blockquote>"); inBQ = true; }
      out.push(`<p>${formatInline(m[1])}</p>`);
    } else {
      closeList(); closeBQ();
      para.push(formatInline(line));
    }
  }
  closeAll();
  return out.join("\n");
}
function formatInline(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  sport_type: string;
  // "__uncategorised__" sits alongside real categories in the array and
  // expands to IS NULL on the backend.
  categories: string[];
  from: string;
  to: string;
  search: string;
}

const INITIAL_FILTERS: Filters = {
  sport_type: "",
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
  const [selected, setSelected] = useState<Set<number>>(new Set());
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
    if (filters.sport_type) params.sport_type = filters.sport_type;
    if (filters.categories.length > 0) params.category = filters.categories;
    if (filters.from) params.from = filters.from;
    if (filters.to) params.to = filters.to;
    if (filters.search) params.search = filters.search;
    getActivities(params).then((r) => {
      setActivities(r.activities);
      setTotal(r.total);
      setSelected(new Set());
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

  const handleCategoryUpdated = (id: number, category: string | null) => {
    setActivities((prev) =>
      prev.map((a) => (a.id === id ? { ...a, trainingCategory: category } : a))
    );
  };
  const handleRenamed = (id: number, name: string) => {
    setActivities((prev) =>
      prev.map((a) => (a.id === id ? { ...a, name } : a))
    );
  };
  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    if (selected.size === activities.length) setSelected(new Set());
    else setSelected(new Set(activities.map((a) => a.id)));
  };

  const handleBulkAssign = async () => {
    if (selected.size === 0 || !bulkCategory) return;
    const category = bulkCategory === "__clear__" ? null : bulkCategory;
    await bulkUpdateCategory([...selected], category);
    setActivities((prev) =>
      prev.map((a) => selected.has(a.id) ? { ...a, trainingCategory: category } : a)
    );
    setSelected(new Set());
    setBulkCategory("");
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
      sportType: filters.sport_type || undefined,
    }),
    [filters]
  );

  const askAI = async () => {
    if (!question.trim() || insightLoading) return;
    setInsightLoading(true);
    setInsightError(null);
    try {
      const res = await getAIInsight({ question, filters: activeFilterOpts });
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
    () => activities.filter((a) => selected.has(a.id)).map(activityToAI),
    [activities, selected]
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
          type="text"
          placeholder="Sport type (e.g. Run)"
          value={filters.sport_type}
          onChange={(e) => { setFilters({ ...filters, sport_type: e.target.value }); setPage(1); }}
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
          {TRAINING_CATEGORIES.map((cat) => {
            const on = filters.categories.includes(cat);
            return (
              <label
                key={cat}
                className={`bucket-chip cat-chip ${categoryClass(cat)} ${on ? "is-on" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggleFilterCategory(cat)}
                />
                <span>{cat}</span>
              </label>
            );
          })}
          <label
            className={`bucket-chip cat-chip cat-none ${filters.categories.includes(UNCATEGORISED) ? "is-on" : ""}`}
          >
            <input
              type="checkbox"
              checked={filters.categories.includes(UNCATEGORISED)}
              onChange={() => toggleFilterCategory(UNCATEGORISED)}
            />
            <span>Uncategorised</span>
          </label>
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

        {insightError && <div className="coach-error">Error: {insightError}</div>}

        {insightLoading && (
          <div className="coach-loading">
            <div className="typing-indicator"><span /><span /><span /></div>
            <div className="coach-loading-text">Crunching the filtered set…</div>
          </div>
        )}

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

      {selected.size > 0 && (
        <div className="bulk-bar card">
          <span>{selected.size} selected</span>
          <select value={bulkCategory} onChange={(e) => setBulkCategory(e.target.value)}>
            <option value="">Assign category...</option>
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
          <button
            onClick={() => setShowCompare(true)}
            className="btn btn-sm"
            disabled={selected.size < 2}
            title={selected.size < 2 ? "Select at least 2 rows" : undefined}
          >
            Compare
          </button>
          <button onClick={() => setSelected(new Set())} className="btn btn-sm">
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
                checked={activities.length > 0 && selected.size === activities.length}
                onChange={toggleSelectAll}
              />
            </th>
            <SortHeader label="Date" field="date" current={sortBy} order={sortOrder} onSort={handleSort} />
            <SortHeader label="Name" field="name" current={sortBy} order={sortOrder} onSort={handleSort} />
            <SortHeader label="Category" field="type" current={sortBy} order={sortOrder} onSort={handleSort} />
            <SortHeader label="Distance" field="distance" current={sortBy} order={sortOrder} onSort={handleSort} />
            <SortHeader label="Pace" field="pace" current={sortBy} order={sortOrder} onSort={handleSort} />
            <SortHeader label="Duration" field="duration" current={sortBy} order={sortOrder} onSort={handleSort} />
            <SortHeader label="HR" field="hr" current={sortBy} order={sortOrder} onSort={handleSort} />
          </tr>
        </thead>
        <tbody>
          {activities.map((a) => (
            <tr key={a.id} className={selected.has(a.id) ? "row-selected" : ""}>
              <td>
                <input
                  type="checkbox"
                  checked={selected.has(a.id)}
                  onChange={() => toggleSelect(a.id)}
                />
              </td>
              <td>{new Date(a.startDate).toLocaleDateString()}</td>
              <td><NameCell activity={a} onRenamed={handleRenamed} /></td>
              <td><CategoryCell activity={a} onUpdated={handleCategoryUpdated} /></td>
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
