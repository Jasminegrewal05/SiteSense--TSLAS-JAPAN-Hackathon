import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { api } from "../api";
import { KINDS, MARK_STATUS, VISIT_TYPES } from "../constants";
import { formatDate, formatTime, midSentence } from "../format";
import Icon from "../components/Icon";
import Movement from "../components/Movement";
import { Wordmark } from "../components/AppShell";
import { Loading, Notice } from "../components/ui";

const MARK_STYLE = {
  pending: { ring: "border-line-strong bg-white text-transparent", icon: "check" },
  ok: { ring: "border-ok bg-ok text-white", icon: "check" },
  issue: { ring: "border-high bg-high text-white", icon: "alert" },
  not_visible: { ring: "border-nv bg-nv-bg text-nv", icon: "slash" },
};

const CHOICES = [
  { status: "ok", label: "Looks fine", active: "bg-ok text-white border-ok" },
  { status: "issue", label: "Issue found", active: "bg-high text-white border-high" },
  { status: "not_visible", label: "Could not see it", active: "bg-nv text-white border-nv" },
];

export function StatusDot({ status }) {
  const s = MARK_STYLE[status];
  return (
    <span className={"w-7 h-7 rounded-full border-2 grid place-items-center shrink-0 " + s.ring}>
      <Icon name={s.icon} size={15} strokeWidth={2.6} />
    </span>
  );
}

export function MarkSheet({ item, onClose, onSave }) {
  const [status, setStatus] = useState(item.status === "pending" ? "" : item.status);
  const [note, setNote] = useState(item.note || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(nextStatus) {
    setBusy(true);
    setError("");
    try {
      await onSave(item.id, nextStatus, note);
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="absolute inset-0 bg-text/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={"Mark " + item.id}
        className="sheet-enter relative w-full max-w-lg bg-white rounded-t-2xl px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] max-h-[90vh] overflow-y-auto"
      >
        <div className="w-10 h-1 rounded-full bg-line-strong mx-auto mb-4" />
        <div className="text-xs text-sub">
          {item.area}, {KINDS[item.kind].toLowerCase()} <span className="num">({item.id})</span>
        </div>
        <p className="text-[17px] font-semibold leading-snug mt-1">{item.text}</p>
        {item.why && <p className="text-sm text-sub mt-2">Because {midSentence(item.why)}</p>}

        <div className="grid grid-cols-3 gap-2 mt-5">
          {CHOICES.map((c) => (
            <button
              key={c.status}
              onClick={() => setStatus(c.status)}
              aria-pressed={status === c.status}
              className={
                "min-h-14 rounded-lg border-2 px-2 text-sm font-semibold leading-tight transition-colors " +
                (status === c.status ? c.active : "border-line-strong bg-white text-text")
              }
            >
              {c.label}
            </button>
          ))}
        </div>

        <label className="block mt-4">
          <span className="text-sm font-semibold">Note</span>
          <textarea
            rows={3}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={status === "issue" ? "What did you see?" : "Optional"}
            className="mt-1.5 w-full rounded-md border border-line-strong px-3 py-2 text-[16px] focus:border-ink focus:outline-none focus:ring-2 focus:ring-ink-100"
          />
        </label>

        {error && <Notice tone="high" className="mt-3">{error}</Notice>}

        <div className="flex gap-2 mt-4">
          {item.status !== "pending" && (
            <button
              onClick={() => save("pending")}
              disabled={busy}
              className="h-12 px-4 rounded-lg text-sm font-semibold text-sub border border-line-strong"
            >
              Clear mark
            </button>
          )}
          <button
            onClick={() => save(status)}
            disabled={!status || busy}
            className="flex-1 h-12 rounded-lg bg-ink text-white font-semibold disabled:bg-line-strong"
          >
            {busy ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Brief() {
  const { visitId } = useParams();
  const { user } = useAuth();
  const paired = !!user?.device_visit;
  const [brief, setBrief] = useState(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState(null);
  const [showConsent, setShowConsent] = useState(true);
  const [showSignals, setShowSignals] = useState(false);

  useEffect(() => {
    api
      .getBrief(visitId)
      .then(setBrief)
      .catch((e) => setError(e.message));
  }, [visitId]);

  const coverage = useMemo(() => {
    if (!brief) return null;
    const c = { total: brief.items.length, ok: 0, issue: 0, not_visible: 0, pending: 0 };
    brief.items.forEach((i) => (c[i.status] += 1));
    c.checked = c.ok + c.issue;
    return c;
  }, [brief]);

  if (error) {
    return (
      <div className="max-w-lg mx-auto p-5">
        <Notice tone="high">{error}</Notice>
        <Link to={"/visits/" + visitId + "/checklist"} className="inline-block mt-4 text-ink font-semibold">
          Go to the checklist
        </Link>
      </div>
    );
  }
  if (!brief) return <Loading />;

  async function mark(itemId, status, note) {
    const updated = await api.markItem(visitId, itemId, status, note);
    setBrief((b) => ({ ...b, items: b.items.map((i) => (i.id === itemId ? updated : i)) }));
  }

  const v = brief.visit;
  const shown = brief.items.filter((i) => {
    if (filter === "all") return true;
    if (filter === "not_checked") return i.status === "pending" || i.status === "not_visible";
    return i.area === filter;
  });
  const pct = coverage.total ? (coverage.checked / coverage.total) * 100 : 0;
  const issuePct = coverage.total ? (coverage.issue / coverage.total) * 100 : 0;

  const tabs = [
    { key: "all", label: "All", count: brief.items.length },
    { key: "not_checked", label: "Not checked", count: coverage.pending + coverage.not_visible },
    ...brief.areas.map((a) => ({ key: a, label: a, count: brief.items.filter((i) => i.area === a).length })),
  ];

  return (
    <div className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-30 bg-ink text-white">
        <div className="max-w-lg mx-auto px-4 pt-3 pb-3">
          <div className="flex items-center justify-between">
            {paired ? (
              <Link to={"/visits/" + visitId + "/capture"} className="inline-flex items-center gap-1 text-base text-white/80">
                <Icon name="back" size={16} /> Recording
              </Link>
            ) : (
              <Link to={"/visits/" + visitId + "/checklist"} className="inline-flex items-center gap-1 text-base text-white/80">
                <Icon name="back" size={16} /> Checklist
              </Link>
            )}
            <Wordmark className="text-lg" />
          </div>
          <h1 className="text-xl font-bold mt-2 leading-tight">{v.company}</h1>
          <p className="text-sm text-white/75">
            {VISIT_TYPES[v.visit_type]} visit, {v.location}, {formatDate(v.visit_date)}
          </p>
          <div className="mt-3">
            <div className="h-2 rounded-full bg-white/20 overflow-hidden flex">
              <div className="h-full bg-white" style={{ width: pct - issuePct + "%" }} />
              <div className="h-full bg-[#f97066]" style={{ width: issuePct + "%" }} />
            </div>
            <p className="num text-sm mt-1.5 text-white/90">
              {coverage.checked} of {coverage.total} checked
              {coverage.issue > 0 && ", " + coverage.issue + " with issues"}
              {coverage.not_visible > 0 && ", " + coverage.not_visible + " could not see"}
            </p>
          </div>
        </div>
        <div className="max-w-lg mx-auto overflow-x-auto">
          <div className="flex gap-1.5 px-4 pb-3 w-max">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setFilter(t.key)}
                className={
                  "h-8 px-3 rounded-full text-sm whitespace-nowrap " +
                  (filter === t.key ? "bg-white text-ink font-semibold" : "bg-white/10 text-white/90")
                }
              >
                {t.label} <span className="num opacity-70">{t.count}</span>
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-4 space-y-3 pb-16">
        {filter === "all" && (
          <>
            <section className="bg-white rounded-lg border border-line">
              <button
                onClick={() => setShowConsent((s) => !s)}
                className="w-full flex items-center justify-between px-4 py-3 text-left"
                aria-expanded={showConsent}
              >
                <span className="font-semibold">Read this before recording</span>
                <Icon name="chevron" size={16} className={"text-sub transition-transform " + (showConsent ? "rotate-90" : "")} />
              </button>
              {showConsent && (
                <div className="px-4 pb-4">
                  <p className="text-[15px] leading-relaxed border-l-2 border-ink pl-3">{brief.consent_script}</p>
                  <p className="text-xs text-sub mt-2">Say it on camera so the consent is part of the record.</p>
                </div>
              )}
            </section>

            <section className="bg-white rounded-lg border border-line">
              <button
                onClick={() => setShowSignals((s) => !s)}
                className="w-full flex items-center justify-between px-4 py-3 text-left"
                aria-expanded={showSignals}
              >
                <span className="font-semibold">
                  What the numbers flagged <span className="text-sub font-normal num">({brief.signals.length})</span>
                </span>
                <Icon name="chevron" size={16} className={"text-sub transition-transform " + (showSignals ? "rotate-90" : "")} />
              </button>
              {showSignals && (
                <ul className="px-4 pb-4 space-y-4">
                  {brief.signals.map((s) => (
                    <li key={s.id}>
                      <div className="text-sm font-semibold flex items-center gap-2">
                        <span className={"w-2 h-2 rounded-full " + (s.severity === "high" ? "bg-high" : s.severity === "medium" ? "bg-med" : "bg-nv")} />
                        {s.signal}
                      </div>
                      <div className="flex flex-wrap gap-x-6 gap-y-2 mt-1.5 pl-4">
                        {s.figures.map((f) => (
                          <Movement key={f.label} label={f.label} previous={f.previous} current={f.current} />
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        {shown.length === 0 && (
          <p className="text-center text-sub py-10">
            {filter === "not_checked" ? "Everything on the list has been checked." : "No items here."}
          </p>
        )}

        <ul className="space-y-2">
          {shown.map((item) => (
            <li key={item.id}>
              <button
                onClick={() => setOpen(item)}
                className={
                  "w-full text-left bg-white rounded-lg border px-4 py-3.5 flex gap-3 items-start active:bg-canvas " +
                  (item.status === "issue" ? "border-high/40" : "border-line")
                }
              >
                <StatusDot status={item.status} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-xs text-sub">
                    <span className={item.kind === "ask" ? "text-ink font-semibold" : ""}>{KINDS[item.kind]}</span>
                    {filter === "all" || filter === "not_checked" ? <span>{item.area}</span> : null}
                    {item.priority === "high" && <span className="text-high font-semibold">High</span>}
                  </span>
                  <span className={"block text-[15px] leading-snug mt-0.5 " + (item.status === "ok" ? "text-sub" : "")}>
                    {item.text}
                  </span>
                  {item.status !== "pending" && (
                    <span className="block text-xs mt-1.5 text-sub">
                      {MARK_STATUS[item.status].label} at {formatTime(item.marked_at)}
                      {item.marked_by === "suggestion" ? " (accepted suggestion)" : ""}
                      {item.note ? ": " + item.note : ""}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </main>

      {open && <MarkSheet item={open} onClose={() => setOpen(null)} onSave={mark} />}
    </div>
  );
}
