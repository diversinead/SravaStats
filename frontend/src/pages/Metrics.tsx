import { useEffect, useState } from "react";
import {
  getMetricsSummary,
  compareActivities,
  type MetricPeriod,
  type Activity,
} from "../api/client";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
} from "recharts";

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

export default function Metrics() {
  const [periods, setPeriods] = useState<MetricPeriod[]>([]);
  const [groupBy, setGroupBy] = useState("week");
  const [categoryFilter, setCategoryFilter] = useState("");

  // Compare
  const [compareIds, setCompareIds] = useState("");
  const [compareData, setCompareData] = useState<Activity[] | null>(null);

  const loadMetrics = () => {
    const params: Record<string, string> = { group_by: groupBy };
    if (categoryFilter) params.category = categoryFilter;
    getMetricsSummary(params).then((r) => setPeriods(r.periods));
  };

  useEffect(() => {
    loadMetrics();
  }, [groupBy, categoryFilter]);

  const handleCompare = async () => {
    const ids = compareIds
      .split(",")
      .map((s) => Number(s.trim()))
      .filter(Boolean);
    if (ids.length < 2) return;
    const data = await compareActivities(ids);
    setCompareData(data);
  };

  const chartData = periods.map((p) => ({
    period: p.period,
    distance: Number((p.totalDistance / 1000).toFixed(1)),
    avgPace: p.avgSpeed > 0 ? Number((1000 / 60 / p.avgSpeed).toFixed(2)) : null,
    avgHR: p.avgHeartrate ? Math.round(p.avgHeartrate) : null,
    count: p.count,
  }));

  return (
    <div className="page">
      <h1>Metrics</h1>

      <div className="card">
        <div className="form-row">
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
          </select>
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="">All categories</option>
            {TRAINING_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
        </div>
      </div>

      {chartData.length > 0 && (
        <>
          <div className="card">
            <h2>Distance (km)</h2>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="period" tick={{ fontSize: 12 }} />
                <YAxis />
                <Tooltip />
                <Line type="monotone" dataKey="distance" stroke="#3b82f6" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="card">
            <h2>Avg Pace (min/km) & Heart Rate</h2>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="period" tick={{ fontSize: 12 }} />
                <YAxis yAxisId="pace" orientation="left" />
                <YAxis yAxisId="hr" orientation="right" />
                <Tooltip />
                <Legend />
                <Line yAxisId="pace" type="monotone" dataKey="avgPace" stroke="#ef4444" name="Pace (min/km)" strokeWidth={2} />
                <Line yAxisId="hr" type="monotone" dataKey="avgHR" stroke="#f97316" name="Avg HR" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="card">
            <h2>Activity Count</h2>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="period" tick={{ fontSize: 12 }} />
                <YAxis />
                <Tooltip />
                <Line type="monotone" dataKey="count" stroke="#10b981" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      <div className="card">
        <h2>Compare Workouts</h2>
        <div className="form-row">
          <input
            type="text"
            placeholder="Activity IDs (comma-separated, e.g. 123,456)"
            value={compareIds}
            onChange={(e) => setCompareIds(e.target.value)}
          />
          <button onClick={handleCompare} className="btn btn-primary">Compare</button>
        </div>

        {compareData && (
          <table className="activity-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Date</th>
                <th>Category</th>
                <th>Distance</th>
                <th>Pace</th>
                <th>Duration</th>
                <th>Avg HR</th>
                <th>Max HR</th>
                <th>Elevation</th>
              </tr>
            </thead>
            <tbody>
              {compareData.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>{new Date(a.startDate).toLocaleDateString()}</td>
                  <td>{a.trainingCategory || a.sportType || "-"}</td>
                  <td>{a.distance ? (a.distance / 1000).toFixed(2) + " km" : "-"}</td>
                  <td>
                    {a.averageSpeed
                      ? `${Math.floor(1000 / 60 / a.averageSpeed)}:${Math.round(
                          ((1000 / 60 / a.averageSpeed) % 1) * 60
                        )
                          .toString()
                          .padStart(2, "0")} /km`
                      : "-"}
                  </td>
                  <td>{a.movingTime ? `${Math.floor(a.movingTime / 60)}m` : "-"}</td>
                  <td>{a.averageHeartrate ? Math.round(a.averageHeartrate) : "-"}</td>
                  <td>{a.maxHeartrate ? Math.round(a.maxHeartrate) : "-"}</td>
                  <td>{a.totalElevationGain ? `${Math.round(a.totalElevationGain)}m` : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
