import { Routes, Route, Navigate } from "react-router-dom";
import { DashboardPage } from "./pages/DashboardPage";
import { AdminPage } from "./pages/AdminPage";
import { MonitoringPage } from "./pages/MonitoringPage";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<AdminPage />} />
      <Route path="/admin" element={<Navigate to="/" replace />} />
      <Route path="/dashboard" element={<DashboardPage />} />
      <Route path="/monitoring" element={<MonitoringPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
