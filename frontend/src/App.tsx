import { BrowserRouter, Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Activities from "./pages/Activities";
import Rules from "./pages/Rules";
import Metrics from "./pages/Metrics";
import ActivityDetail from "./pages/ActivityDetail";
import "./App.css";
import Coach from "./pages/Coach";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/activities" element={<Activities />} />
          <Route path="/activities/:id" element={<ActivityDetail />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="/metrics" element={<Metrics />} />
          <Route path="/coach" element={<Coach />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
