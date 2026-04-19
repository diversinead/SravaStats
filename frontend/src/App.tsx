import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Activities from "./pages/Activities";
import Rules from "./pages/Rules";
import ActivityDetail from "./pages/ActivityDetail";
import "./App.css";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/activities" element={<Activities />} />
          <Route path="/activities/:id" element={<ActivityDetail />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="/coach" element={<Navigate to="/activities" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
