import { Navigate, Route, Routes } from "react-router-dom";
import RequireLogin from "./components/RequireLogin";
import AppShell from "./components/AppShell";
import Login from "./pages/Login";
import Home from "./pages/Home";
import NewVisit from "./pages/NewVisit";
import Capture from "./pages/Capture";
import VisitLayout from "./pages/visit/VisitLayout";
import VisitStart from "./pages/visit/VisitStart";
import Details from "./pages/visit/Details";
import Documents from "./pages/visit/Documents";
import Numbers from "./pages/visit/Numbers";
import Checklist from "./pages/visit/Checklist";
import Live from "./pages/visit/Live";
import Review from "./pages/visit/Review";
import Findings from "./pages/visit/Findings";
import Report from "./pages/visit/Report";
import ReportPrint from "./pages/ReportPrint";
import Pair from "./pages/Pair";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/pair/:code" element={<Pair />} />

      <Route element={<RequireLogin />}>
        {/* Phone pages: no desktop chrome */}
        <Route path="/visits/:visitId/capture" element={<Capture />} />
        <Route path="/visits/:visitId/report/print" element={<ReportPrint />} />

        <Route element={<AppShell />}>
          <Route path="/" element={<Home />} />
          <Route path="/visits/new" element={<NewVisit />} />
          <Route path="/visits/:visitId" element={<VisitLayout />}>
            <Route index element={<VisitStart />} />
            <Route path="details" element={<Details />} />
            <Route path="documents" element={<Documents />} />
            <Route path="numbers" element={<Numbers />} />
            <Route path="checklist" element={<Checklist />} />
            <Route path="live" element={<Live />} />
            <Route path="review" element={<Review />} />
            <Route path="findings" element={<Findings />} />
            <Route path="report" element={<Report />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
