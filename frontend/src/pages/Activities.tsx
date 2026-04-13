import { useEffect, useState } from "react";
import {
  getActivities,
  updateActivityCategory,
  updateActivity,
  bulkUpdateCategory,
  type Activity,
} from "../api/client";
import { Link } from "react-router-dom";

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

function CategoryCell({ activity, onUpdated }: { activity: Activity; onUpdated: (id: number, cat: string | null) => void }) {
  const handleChange = async (value: string) => {
    const category = value || null;
    await updateActivityCategory(activity.id, category);
    onUpdated(activity.id, category);
  };

  return (
    <select
      className="category-select"
      value={activity.trainingCategory || ""}
      onChange={(e) => handleChange(e.target.value)}
    >
      <option value="">{activity.sportType || "-"}</option>
      {TRAINING_CATEGORIES.map((cat) => (
        <option key={cat} value={cat}>{cat}</option>
      ))}
    </select>
  );
}

function NameCell({ activity, onRenamed }: { activity: Activity; onRenamed: (id: number, name: string) => void }) {
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

export default function Activities() {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ sport_type: "", category: "", from: "", to: "", search: "" });
  const [sortBy, setSortBy] = useState<SortKey>("date");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkCategory, setBulkCategory] = useState("");

  const load = () => {
    const params: Record<string, string> = {
      page: String(page),
      limit: "20",
      sort_by: sortBy,
      order: sortOrder,
    };
    if (filters.sport_type) params.sport_type = filters.sport_type;
    if (filters.category) params.category = filters.category;
    if (filters.from) params.from = filters.from;
    if (filters.to) params.to = filters.to;
    if (filters.search) params.search = filters.search;
    getActivities(params).then((r) => {
      setActivities(r.activities);
      setTotal(r.total);
      setSelected(new Set());
    });
  };

  useEffect(() => {
    load();
  }, [page, filters, sortBy, sortOrder]);

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
    if (selected.size === activities.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(activities.map((a) => a.id)));
    }
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

  return (
    <div className="page">
      <h1>Activities <span style={{ fontSize: "1rem", fontWeight: 400, color: "#94a3b8" }}>({total})</span></h1>

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
        <select
          value={filters.category}
          onChange={(e) => { setFilters({ ...filters, category: e.target.value }); setPage(1); }}
        >
          <option value="">All categories</option>
          <option value="__uncategorised__">Uncategorised</option>
          {TRAINING_CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>
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
          <button onClick={handleBulkAssign} className="btn btn-primary btn-sm" disabled={!bulkCategory}>
            Apply
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
            <SortHeader label="Type" field="type" current={sortBy} order={sortOrder} onSort={handleSort} />
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
              <td>
                <NameCell activity={a} onRenamed={handleRenamed} />
              </td>
              <td>
                <CategoryCell activity={a} onUpdated={handleCategoryUpdated} />
              </td>
              <td>{formatDistance(a.distance)}</td>
              <td>{formatPace(a.averageSpeed)}</td>
              <td>{formatDuration(a.movingTime)}</td>
              <td>{a.averageHeartrate ? Math.round(a.averageHeartrate) : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="pagination">
        <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page <= 1} className="btn">
          Previous
        </button>
        <span>Page {page} of {Math.max(1, Math.ceil(total / 20))}</span>
        <button onClick={() => setPage(page + 1)} disabled={page * 20 >= total} className="btn">
          Next
        </button>
      </div>
    </div>
  );
}
