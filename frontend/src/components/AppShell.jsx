import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../AuthContext";
import Icon from "./Icon";

export function Wordmark({ className = "" }) {
  return <span className={"font-bold tracking-tight " + className}>SiteSense</span>;
}

export function initials(name) {
  return (name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");
}

export default function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/login");
  }

  return (
    <div className="min-h-screen">
      <header className="bg-white border-b border-line sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center gap-6">
          <Link to="/" className="text-ink text-[22px] leading-none">
            <Wordmark />
          </Link>
          <nav className="hidden sm:flex items-center gap-1 text-base">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                "px-3 py-1.5 rounded-md " + (isActive ? "bg-ink-50 text-ink font-semibold" : "text-sub hover:text-text")
              }
            >
              Visits
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <div className="hidden md:block text-right leading-tight">
              <div className="text-base font-bold">{user.name}</div>
              <div className="text-sm text-sub">{user.role === "manager" ? "Manager" : "Analyst"}</div>
            </div>
            {user.picture ? (
              <img src={user.picture} alt="" referrerPolicy="no-referrer" className="w-8 h-8 rounded-full" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-ink text-white grid place-items-center text-xs font-bold">
                {initials(user.name)}
              </div>
            )}
            <button
              onClick={handleLogout}
              className="inline-flex items-center gap-1.5 text-base text-sub hover:text-text px-3 h-10 rounded-lg"
              title="Sign out"
            >
              <Icon name="logout" size={16} />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
