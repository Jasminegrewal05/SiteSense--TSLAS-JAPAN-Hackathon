import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../AuthContext";
import { VISIT_TYPES, visitStatus } from "../constants";
import { formatDate } from "../format";
import Icon from "../components/Icon";
import { ButtonLink, Loading, Notice, PageHeading, Pill } from "../components/ui";

function Coverage({ coverage }) {
  if (!coverage) return <span className="text-sub">Not built yet</span>;
  const pct = coverage.total ? Math.round((coverage.checked / coverage.total) * 100) : 0;
  return (
    <div className="min-w-[140px]">
      <div className="num text-sm">
        {coverage.checked} of {coverage.total} checked
        {coverage.issue > 0 && <span className="text-high font-semibold">, {coverage.issue} issue{coverage.issue > 1 ? "s" : ""}</span>}
      </div>
      <div className="h-1.5 bg-line rounded-full mt-1.5 overflow-hidden">
        <div className="h-full bg-ok" style={{ width: pct + "%" }} />
      </div>
    </div>
  );
}

export default function Home() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [visits, setVisits] = useState(null);
  const [error, setError] = useState("");

  // Updates by itself: a checklist or report sent by someone else appears without reloading.
  useEffect(() => {
    const load = () =>
      api
        .listVisits()
        .then((d) => setVisits(d.visits))
        .catch((e) => setError(e.message));
    load();
    const timer = setInterval(() => document.visibilityState === "visible" && load(), 5000);
    return () => clearInterval(timer);
  }, []);

  const isManager = user.role === "manager";
  const todo = (visits || [])
    .map((v) => {
      if (isManager) {
        if (v.status === "submitted") return [v, "Approve the checklist", "checklist"];
        if (v.report_status === "submitted") return [v, "Approve the report", "report"];
        if (v.status === "declined") return [v, "Declined. Assign another analyst", "details"];
      } else {
        if (v.status === "assigned") return [v, "New visit for you. Accept or decline", ""];
        if (v.status === "approved") return [v, "Checklist approved. Lock it", "checklist"];
        if (v.status === "checklist_ready" || v.status === "draft") return null;
        if (v.report_status === "sent_back") return [v, "Report sent back. Read the note", "report"];
      }
      return null;
    })
    .filter(Boolean);

  return (
    <div>
      <PageHeading title="Visits">
        {user.role === "manager" && (
          <ButtonLink to="/visits/new" size="lg">
            <Icon name="plus" size={20} /> New visit
          </ButtonLink>
        )}
      </PageHeading>

      {error && <Notice tone="high">{error}</Notice>}

      {todo.length > 0 && (
        <section className="mb-8">
          <h2 className="text-xl font-bold mb-3">Waiting for you</h2>
          <ul className="space-y-2">
            {todo.map(([v, text, to]) => (
              <li key={v.visit_id}>
                <button
                  onClick={() => navigate("/visits/" + v.visit_id + (to ? "/" + to : ""))}
                  className="w-full text-left bg-white border-2 border-ink rounded-xl px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-6 hover:bg-ink-50"
                >
                  <span className="text-lg font-bold flex-1">{v.company}</span>
                  <span className="text-lg text-ink font-bold">{text}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {visits && visits.length > 0 && <h2 className="text-xl font-bold mb-3">All visits</h2>}
      {!visits && !error && <Loading />}

      {visits && visits.length === 0 && (
        <div className="bg-white border border-line rounded-lg px-6 py-14 text-center">
          <h2 className="text-xl font-bold">No visits yet</h2>
          {user.role === "manager" ? (
            <ButtonLink to="/visits/new" size="lg" className="mt-6">Create a visit</ButtonLink>
          ) : (
            <p className="text-sub text-lg mt-2">Your manager will assign visits to you here.</p>
          )}
        </div>
      )}

      {visits && visits.length > 0 && (
        <ul className="sm:hidden space-y-3">
          {visits.map((v) => {
            const status = visitStatus(v.status, v.capture, v.report_status);
            return (
              <li key={v.visit_id}>
                <button
                  onClick={() => navigate("/visits/" + v.visit_id)}
                  className="w-full text-left bg-white border border-line rounded-lg p-4 active:bg-canvas"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="font-bold text-lg leading-snug">{v.company}</div>
                    <Pill tone={status.tone} className="shrink-0">
                      {status.label}
                    </Pill>
                  </div>
                  <div className="text-sm text-sub mt-1">
                    {VISIT_TYPES[v.visit_type]}, {formatDate(v.visit_date)}
                    {v.signals ? ", " + v.signals + " warning sign" + (v.signals > 1 ? "s" : "") : ""}
                  </div>
                  {v.status === "locked" && (
                    <div className="mt-3">
                      <Coverage coverage={v.coverage} />
                    </div>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {visits && visits.length > 0 && (
        <div className="hidden sm:block bg-white border border-line rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-base">
              <thead className="text-left text-sub border-b border-line">
                <tr>
                  <th className="px-5 py-3.5 font-bold">Company</th>
                  <th className="px-5 py-3.5 font-bold">Visit</th>
                  <th className="px-5 py-3.5 font-bold">Warning signs</th>
                  <th className="px-5 py-3.5 font-bold">Status</th>
                  <th className="px-5 py-3.5 font-bold">On site</th>
                </tr>
              </thead>
              <tbody>
                {visits.map((v) => {
                  const status = visitStatus(v.status, v.capture, v.report_status);
                  return (
                    <tr
                      key={v.visit_id}
                      onClick={() => navigate("/visits/" + v.visit_id)}
                      className="border-t border-line first:border-t-0 hover:bg-canvas cursor-pointer"
                    >
                      <td className="px-5 py-5">
                        <div className="font-bold text-lg">{v.company}</div>
                      </td>
                      <td className="px-5 py-5 whitespace-nowrap">
                        <div>{formatDate(v.visit_date)}</div>
                        <div className="text-sm text-sub">
                          {VISIT_TYPES[v.visit_type]}
                          {v.location ? ", " + v.location : ""}
                        </div>
                      </td>
                      <td className="px-5 py-5 num">{v.signals === null ? <span className="text-sub">-</span> : v.signals}</td>
                      <td className="px-5 py-5">
                        <Pill tone={status.tone}>{status.label}</Pill>
                      </td>
                      <td className="px-5 py-5">
                        {v.status === "locked" && v.coverage?.checked ? <Coverage coverage={v.coverage} /> : <span className="text-sub">-</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
