import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import { VISIT_TYPES, visitStatus } from "../../constants";
import { formatDate } from "../../format";
import Icon from "../../components/Icon";
import { Button, Loading, NextStep, Notice, Pill, inputClass } from "../../components/ui";

const PHASES = [
  ["Before", [["details", "Details"], ["documents", "Documents"], ["numbers", "Numbers"], ["checklist", "Checklist"]]],
  ["During", [["live", "Visit"], ["review", "Review"]]],
  ["After", [["findings", "Findings"], ["report", "Report"]]],
];

function doneSteps(visit) {
  const p = visit.progress;
  return {
    details: true,
    documents: p.docs > 0,
    numbers: p.numbers_confirmed && !p.numbers_outdated,
    checklist: p.checklist === "locked",
    live: p.capture === "done" || p.capture === "deleted",
    review: p.reviewed || p.capture === "deleted",
    findings: ["submitted", "approved"].includes(visit.report_status),
    report: visit.report_status === "approved",
  };
}

// The single thing to do now, for this person.
function nextStep(visit, user) {
  const p = visit.progress;
  const r = visit.report_status;
  if (visit.assignment !== "accepted") return null;
  if (user.role === "manager") {
    if (p.checklist === "submitted") return { text: "Approve or send back the checklist.", action: "Open checklist", to: "checklist" };
    if (r === "submitted") return { text: "Approve or send back the report.", action: "Open report", to: "report" };
    if (r === "approved") return { text: "The report is approved and locked.", action: "Open report", to: "report" };
    return { text: "Nothing for you to do yet. " + visit.analyst_name + " is working on it." };
  }
  if (p.docs === 0) return { text: "Upload the company's financials and annual report.", action: "Upload documents", to: "documents" };
  if (!p.numbers_confirmed || p.numbers_outdated) return { text: "Read the numbers and confirm them.", action: "Go to numbers", to: "numbers" };
  if (!p.checklist) return { text: "Build the checklist from the numbers.", action: "Build checklist", to: "checklist" };
  if (p.checklist === "draft") return { text: "Check the list, then send it to your manager.", action: "Open checklist", to: "checklist" };
  if (p.checklist === "submitted") return { text: "Waiting for your manager to approve the checklist." };
  if (p.checklist === "approved") return { text: "Approved. Lock the checklist to start the visit.", action: "Lock checklist", to: "checklist" };
  if (!p.capture) return { text: "Scan the code with your phone and start the visit.", action: "Start the visit", to: "live" };
  if (["recording", "paused"].includes(p.capture)) return { text: "The visit is being recorded.", action: "Watch progress", to: "live" };
  if (["ending", "processing", "splitting"].includes(p.capture)) return { text: "The laptop is processing the recording." , action: "Watch progress", to: "live" };
  if (p.capture === "failed") return { text: "Processing failed. See what went wrong.", action: "Open visit", to: "live" };
  if (p.capture === "done" && !p.reviewed) return { text: "Check the recording: consent, speakers and suggestions.", action: "Start review", to: "review" };
  if (!r) return { text: "Compare what was said, the numbers and what was seen.", action: "Build findings", to: "findings" };
  if (r === "draft") return { text: "Keep or remove each finding, then submit the report.", action: "Open findings", to: "findings" };
  if (r === "sent_back") return { text: "Your manager sent the report back. Read the note and fix it.", action: "Open report", to: "report" };
  if (r === "submitted") return { text: "Waiting for your manager to approve the report.", action: "Open report", to: "report" };
  return { text: "The report is approved and locked.", action: "Open report", to: "report" };
}

function AssignmentBar({ visit, user, reload }) {
  const navigate = useNavigate();
  const [reason, setReason] = useState("");
  const [declining, setDeclining] = useState(false);
  const [analysts, setAnalysts] = useState([]);
  const [pick, setPick] = useState("");
  const [error, setError] = useState("");
  const isManager = user.role === "manager";
  const waiting = visit.assignment === "assigned";
  const declined = visit.assignment === "declined";

  useEffect(() => {
    if (isManager && (waiting || declined)) api.analysts().then((d) => setAnalysts(d.analysts)).catch(() => {});
  }, [isManager, waiting, declined]);

  async function run(fn, after) {
    setError("");
    try {
      await fn();
      if (after) after();
      else await reload();
    } catch (e) {
      setError(e.message);
    }
  }

  if (!waiting && !declined) return null;
  const last = (visit.declined || []).slice(-1)[0];

  return (
    <div className="mb-6 space-y-3">
      {!isManager && waiting && (
        <Notice tone="med" className="space-y-3">
          <div className="font-semibold">{visit.created_by_name || "Your manager"} assigned this visit to you.</div>
          <div>Can you do it on {formatDate(visit.visit_date)} in {visit.location}? Accept to start, or decline with a reason.</div>
          {declining && (
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (for example: on leave that day)" maxLength={300} className={inputClass} />
          )}
          <div className="flex gap-2">
            {!declining ? (
              <>
                <Button onClick={() => run(() => api.acceptVisit(visit.visit_id))}>Accept</Button>
                <Button variant="secondary" onClick={() => setDeclining(true)}>Decline</Button>
              </>
            ) : (
              <>
                <Button disabled={reason.trim().length < 3} onClick={() => run(() => api.declineVisit(visit.visit_id, reason), () => navigate("/"))}>
                  Send decline
                </Button>
                <Button variant="quiet" onClick={() => setDeclining(false)}>Cancel</Button>
              </>
            )}
          </div>
        </Notice>
      )}
      {isManager && (waiting || declined) && (
        <Notice tone={declined ? "high" : "med"} className="space-y-3">
          <div className="font-semibold">
            {declined ? "Declined" + (last ? " by " + last.by + ": " + last.reason : "") : "Waiting for " + visit.analyst_name + " to accept."}
          </div>
          <div className="flex gap-2 items-center">
            <select value={pick} onChange={(e) => setPick(e.target.value)} className={inputClass + " max-w-xs"}>
              <option value="">{declined ? "Assign to another analyst" : "Reassign to another analyst"}</option>
              {analysts.filter((a) => a.email !== visit.analyst_email).map((a) => (
                <option key={a.email} value={a.email}>{a.name}</option>
              ))}
            </select>
            <Button disabled={!pick} onClick={() => run(() => api.reassignVisit(visit.visit_id, pick))}>Assign</Button>
          </div>
        </Notice>
      )}
      {error && <Notice tone="high">{error}</Notice>}
    </div>
  );
}

// What the manager sees: only their part. No analyst steps.
function ManagerVisit({ visit, user, status, reload }) {
  const p = visit.progress;
  const r = visit.report_status;
  const here = useLocation().pathname;
  const next = nextStep(visit, user);
  const onIt = next && next.to && here.endsWith("/" + next.to);
  const checkpoints = [
    ["Assigned to " + (visit.analyst_name || "an analyst"), true],
    ["Accepted", visit.assignment === "accepted"],
    ["Checklist approved", ["approved", "locked"].includes(p.checklist)],
    ["Visit recorded", p.reviewed || p.capture === "deleted"],
    ["Report approved", r === "approved"],
  ];
  const tabs = [["details", "Details"]];
  if (["submitted", "approved", "locked"].includes(p.checklist)) tabs.push(["checklist", "Checklist"]);
  if (["submitted", "approved", "sent_back"].includes(r)) tabs.push(["report", "Report"]);

  return (
    <div>
      <Link to="/" className="inline-flex items-center gap-1.5 text-base text-sub hover:text-text mb-4">
        <Icon name="back" size={18} /> All visits
      </Link>
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-3xl font-bold">{visit.company}</h1>
        <Pill tone={status.tone}>{status.label}</Pill>
      </div>
      <p className="text-sub text-lg mt-1 mb-6">
        {VISIT_TYPES[visit.visit_type]} in {visit.location}, {formatDate(visit.visit_date)}
        {visit.analyst_name ? ". Analyst: " + visit.analyst_name : ""}
      </p>

      <AssignmentBar visit={visit} user={user} reload={reload} />
      {next && next.action && !onIt && (
        <div className="mb-6">
          <NextStep text={next.text} action={next.action} to={"/visits/" + visit.visit_id + "/" + next.to} />
        </div>
      )}

      <ol className="bg-white border border-line rounded-xl px-5 py-4 mb-8 grid sm:grid-cols-5 gap-3">
        {checkpoints.map(([label, ok]) => (
          <li key={label} className="flex sm:flex-col items-center sm:items-start gap-2">
            <span
              className={
                "w-7 h-7 rounded-full grid place-items-center shrink-0 " + (ok ? "bg-ok text-white" : "border-2 border-line-strong")
              }
            >
              {ok && <Icon name="check" size={15} strokeWidth={2.6} />}
            </span>
            <span className={"text-base " + (ok ? "font-bold" : "text-sub")}>{label}</span>
          </li>
        ))}
      </ol>

      {tabs.length > 1 && (
        <nav aria-label="Visit" className="flex gap-2 mb-6 border-b border-line">
          {tabs.map(([to, label]) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                "px-4 py-3 -mb-px text-lg border-b-4 " + (isActive ? "border-ink font-bold text-text" : "border-transparent text-sub hover:text-text")
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
      )}
      <Outlet context={{ visit, reload }} />
    </div>
  );
}

export default function VisitLayout() {
  const { user } = useAuth();
  const location = useLocation();
  const { visitId } = useParams();
  const [visit, setVisit] = useState(null);
  const [error, setError] = useState("");
  const last = useRef("");

  // Only re-render when something actually changed.
  const reload = useCallback(() => {
    return api
      .getVisit(visitId)
      .then((v) => {
        const key = JSON.stringify(v);
        if (key !== last.current) {
          last.current = key;
          setVisit(v);
        }
      })
      .catch((e) => setError(e.message));
  }, [visitId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Keep every screen up to date without reloading: what the other person did shows up by itself.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, 4000);
    return () => clearInterval(timer);
  }, [reload]);

  if (error) return <Notice tone="high">{error}</Notice>;
  if (!visit) return <Loading />;

  const status = visitStatus(visit.status, visit.progress.reviewed ? "reviewed" : visit.progress.capture, visit.report_status);
  if (user.role === "manager") return <ManagerVisit visit={visit} user={user} status={status} reload={reload} />;
  const locked = visit.status === "locked";
  const done = doneSteps(visit);
  const next = nextStep(visit, user);
  const onIt = next && next.to && location.pathname.endsWith("/" + next.to);

  return (
    <div>
      <Link to="/" className="inline-flex items-center gap-1.5 text-base text-sub hover:text-text mb-4">
        <Icon name="back" size={18} /> All visits
      </Link>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-6">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-3xl font-bold">{visit.company}</h1>
            <Pill tone={status.tone}>{status.label}</Pill>
          </div>
          <p className="text-sub text-lg mt-1">
            {VISIT_TYPES[visit.visit_type]} in {visit.location}, {formatDate(visit.visit_date)}
          </p>
        </div>
      </div>

      <AssignmentBar visit={visit} user={user} reload={reload} />
      {next && (
        <div className="mb-8">
          <NextStep text={next.text} action={onIt ? null : next.action} to={next.to ? "/visits/" + visit.visit_id + "/" + next.to : undefined} />
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)] gap-8">
        <nav aria-label="Visit steps" className="lg:sticky lg:top-24 self-start min-w-0">
          <div className="flex lg:flex-col gap-4 lg:gap-5 overflow-x-auto -mx-4 px-4 lg:mx-0 lg:px-0 pb-1">
            {PHASES.map(([phase, steps]) => (
              <div key={phase} className="shrink-0">
                <div className="text-sm font-bold text-sub px-3 mb-1">{phase} the visit</div>
                <ol className="flex lg:flex-col gap-1">
                  {steps.map(([to, label]) => (
                    <li key={to} className="shrink-0">
                      <NavLink
                        to={to}
                        className={({ isActive }) =>
                          "flex items-center gap-3 rounded-lg px-3 py-2.5 text-base whitespace-nowrap " +
                          (isActive ? "bg-white border border-line-strong font-bold text-text" : "text-sub hover:text-text border border-transparent")
                        }
                      >
                        <span
                          className={
                            "w-6 h-6 rounded-full grid place-items-center shrink-0 " +
                            (done[to] ? "bg-ok text-white" : "bg-white border-2 border-line-strong")
                          }
                        >
                          {done[to] && <Icon name="check" size={14} strokeWidth={2.6} />}
                        </span>
                        {label}
                      </NavLink>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </nav>

        <section className="min-w-0">
          <Outlet context={{ visit, reload }} />
        </section>
      </div>
    </div>
  );
}
