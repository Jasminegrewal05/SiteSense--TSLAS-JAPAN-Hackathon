import { Navigate, useOutletContext } from "react-router-dom";
import { useAuth } from "../../AuthContext";

// Opening a visit lands on the step that needs attention next.
export default function VisitStart() {
  const { visit } = useOutletContext();
  const { user } = useAuth();
  const p = visit.progress;
  if (user.role === "manager") {
    if (p.checklist === "submitted") return <Navigate to="checklist" replace />;
    if (["submitted", "approved"].includes(visit.report_status)) return <Navigate to="report" replace />;
    return <Navigate to="details" replace />;
  }
  if (visit.report_status) return <Navigate to={visit.report_status === "approved" ? "report" : "findings"} replace />;
  if (p.reviewed || p.capture === "deleted") return <Navigate to="findings" replace />;
  if (p.docs === 0) return <Navigate to="documents" replace />;
  if (!p.numbers_confirmed || p.numbers_outdated) return <Navigate to="numbers" replace />;
  if (p.checklist !== "locked") return <Navigate to="checklist" replace />;
  if (p.capture === "done" || p.capture === "deleted") return <Navigate to="review" replace />;
  return <Navigate to="live" replace />;
}
