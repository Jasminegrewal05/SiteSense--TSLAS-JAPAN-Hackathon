import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { Loading } from "./ui";

// The real protection is on the backend: every API call without a valid
// session cookie is rejected. This only keeps signed-out people on /login.
export default function RequireLogin() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <Loading />;
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  // A phone paired by QR can only record its one visit.
  if (user.device_visit && location.pathname !== "/visits/" + user.device_visit + "/capture") {
    return <Navigate to={"/visits/" + user.device_visit + "/capture"} replace />;
  }
  return <Outlet />;
}
