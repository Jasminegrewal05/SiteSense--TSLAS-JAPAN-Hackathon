import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import { MARK_STATUS } from "../../constants";
import { formatDateTime, shortSource } from "../../format";
import { ClipButton, ClipPlayer } from "../../components/Clip";
import { Button, ButtonLink, Loading, Notice, Tag, VERDICT, inputClass } from "../../components/ui";

const SAID_RESULT = {
  agrees: { text: "Matches the report", cls: "text-ok" },
  differs: { text: "Differs from the report", cls: "text-high" },
  explanation: { text: "", cls: "" },
};

const CONFIDENCE = { high: "High", medium: "Medium", low: "Low" };

function Column({ title, children }) {
  return (
    <div className="min-w-0">
      <h4 className="text-base font-bold text-sub mb-2">{title}</h4>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Card({ card, canDecide, onDecide, onPlay, busy }) {
  const [removing, setRemoving] = useState(false);
  const [note, setNote] = useState(card.note || "");
  const decided = card.decision;

  return (
    <article
      className={
        "bg-white rounded-xl border-2 " +
        (decided === "removed" ? "border-line opacity-60" : decided === "kept" ? "border-ok/50" : "border-line-strong")
      }
    >
      <header className="px-5 pt-5 pb-4 flex flex-col sm:flex-row sm:items-start gap-3 sm:justify-between">
        <div>
          <h3 className="text-xl font-bold">{card.title}</h3>
          <p className="text-base text-sub mt-1">{card.why}</p>
        </div>
        <Tag verdict={card.verdict} className="self-start" />
      </header>

      <div className="px-5 pb-5 grid md:grid-cols-3 gap-6 border-t border-line pt-4">
        <Column title="Said">
          {card.said.lines.length === 0 && <p className="text-sub">Not discussed</p>}
          {card.said.lines.map((s, i) => (
            <div key={i}>
              <p className="text-base leading-snug">"{s.text}"</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
                <span className="font-bold">{s.speaker_name}</span>
                {SAID_RESULT[s.result].text && (
                  <span className={"font-bold " + SAID_RESULT[s.result].cls}>{SAID_RESULT[s.result].text}</span>
                )}
                <ClipButton clip={s.clip} onPlay={onPlay} />
              </div>
              {s.detail && <p className="text-sm text-sub mt-0.5">{s.detail}</p>}
            </div>
          ))}
        </Column>

        <Column title="Numbers">
          {card.figures.map((f) => (
            <div key={f.label}>
              <div className="text-base">{f.label}</div>
              <div className="text-xl font-bold num">
                {f.previous ? f.previous + " to " : ""}
                {f.current}
              </div>
            </div>
          ))}
          {card.sources.length > 0 && <p className="text-sm text-sub break-words">From {[...new Set(card.sources.map(shortSource))].join("; ")}</p>}
        </Column>

        <Column title="Seen">
          {card.seen.ticks.map((tk) => (
            <div key={tk.id}>
              <p className="text-base leading-snug">{tk.text}</p>
              <p className={"text-sm font-bold mt-1 " + (tk.status === "issue" ? "text-high" : "text-ok")}>
                {MARK_STATUS[tk.status].label}
                {tk.note ? ": " + tk.note : ""}
                <span className="font-normal text-sub"> ({tk.by === "manual" ? "your tick" : "accepted suggestion"})</span>
              </p>
            </div>
          ))}
          {(card.seen.votes.ok > 0 || card.seen.votes.issue > 0) && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base">
                Pictures: {card.seen.votes.issue} show a problem, {card.seen.votes.ok} look fine
              </span>
              {card.seen.clips.map((c, i) => (
                <ClipButton key={i} clip={c} onPlay={onPlay} />
              ))}
            </div>
          )}
          {card.seen.not_shown.length > 0 && (
            <p className="text-base font-bold text-med">Not shown: {card.seen.not_shown.join(", ")}</p>
          )}
          {card.seen.status === "none" && card.seen.not_shown.length === 0 && <p className="text-sub">Nothing seen</p>}
        </Column>
      </div>

      {card.cues.length > 0 && (
        <div className="mx-5 mb-4 rounded-lg bg-canvas px-4 py-3">
          <p className="text-base font-bold">Worth a second look</p>
          {card.cues.map((q, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 mt-1">
              <span className="text-base">{q.text}</span>
              <ClipButton clip={q.clip} onPlay={onPlay} />
            </div>
          ))}
        </div>
      )}

      <footer className="px-5 py-4 border-t border-line flex flex-col lg:flex-row lg:items-center gap-3 lg:justify-between">
        <p className="text-base">
          <span className="font-bold">Confidence: {CONFIDENCE[card.confidence]}</span>
          <span className="text-sub"> ({card.reason})</span>
        </p>
        {decided ? (
          <div className="flex items-center gap-3">
            <span className={"text-lg font-bold " + (decided === "kept" ? "text-ok" : "text-sub")}>
              {decided === "kept" ? "Kept in the report" : "Removed: " + card.note}
            </span>
            {canDecide && (
              <Button variant="quiet" size="sm" onClick={() => onDecide(card.id, "undo")}>
                Undo
              </Button>
            )}
          </div>
        ) : canDecide ? (
          removing ? (
            <div className="flex flex-col sm:flex-row gap-2 w-full lg:w-auto">
              <input
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why remove it?"
                maxLength={500}
                className={inputClass + " sm:w-72"}
              />
              <Button disabled={note.trim().length < 3} busy={busy} onClick={() => onDecide(card.id, "remove", note)}>
                Remove
              </Button>
              <Button variant="quiet" onClick={() => setRemoving(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button size="lg" busy={busy} onClick={() => onDecide(card.id, "keep")}>
                Keep
              </Button>
              <Button size="lg" variant="secondary" onClick={() => setRemoving(true)}>
                Remove
              </Button>
            </div>
          )
        ) : (
          <span className="text-base text-sub">Not decided yet</span>
        )}
      </footer>
    </article>
  );
}

export default function Findings() {
  const { visit, reload } = useOutletContext();
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [clip, setClip] = useState(null);
  const isManager = user.role === "manager";

  const load = useCallback(() => api.getFindings(visit.visit_id).then(setData).catch((e) => setError(e.message)), [visit.visit_id]);
  useEffect(() => {
    load();
  }, [load, visit.report_status]);

  async function build() {
    setBusy("build");
    setError("");
    try {
      setData(await api.buildFindings(visit.visit_id));
      await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  async function decide(fid, action, note) {
    setBusy(fid);
    setError("");
    try {
      const card = await api.decideFinding(visit.visit_id, fid, action, note);
      setData((d) => ({ ...d, cards: d.cards.map((c) => (c.id === fid ? card : c)) }));
      reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  if (!data) return error ? <Notice tone="high">{error}</Notice> : <Loading />;

  const ready = visit.progress.checklist === "locked" && (data.review_finished || data.recording === "deleted" || !data.recording);
  const locked = data.report_status === "approved";
  const canDecide = !isManager && !locked;

  if (!data.built) {
    return (
      <div className="bg-white border border-line rounded-xl px-6 py-14 text-center">
        <h2 className="text-2xl font-bold">Findings</h2>
        <p className="text-lg text-sub mt-2 max-w-xl mx-auto">
          For each warning sign, see what was said, what the numbers say and what was seen, side by side.
        </p>
        {!ready ? (
          <p className="text-lg mt-6">Finish the Review step first.</p>
        ) : isManager ? (
          <p className="text-lg mt-6">The analyst has not built the findings yet.</p>
        ) : (
          <Button size="lg" className="mt-8" busy={busy === "build"} onClick={build}>
            Build findings
          </Button>
        )}
        {error && <Notice tone="high" className="mt-6 text-left">{error}</Notice>}
      </div>
    );
  }

  const counts = Object.keys(VERDICT).map((v) => [v, data.cards.filter((c) => c.verdict === v).length]);
  const left = data.cards.filter((c) => !c.decision).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center gap-4 md:justify-between">
        <div className="flex flex-wrap gap-2">
          {counts.filter(([, n]) => n > 0).map(([v, n]) => (
            <span key={v} className={"tag tag-" + v}>
              {n} {VERDICT[v]}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold">{left ? left + " left to decide" : "All decided"}</span>
          {canDecide && (
            <Button variant="secondary" size="sm" busy={busy === "build"} onClick={build}>
              Build again
            </Button>
          )}
        </div>
      </div>
      <p className="text-sm text-sub">Built {formatDateTime(data.built_at)}. Your decisions are kept when you build again.</p>

      {error && <Notice tone="high">{error}</Notice>}

      {data.cards.length === 0 && <Notice tone="ink">No warning signs fired in Phase 1, so there is nothing to compare.</Notice>}

      <div className="space-y-5">
        {data.cards.map((c) => (
          <Card key={c.id} card={c} canDecide={canDecide} onDecide={decide} onPlay={setClip} busy={busy === c.id} />
        ))}
      </div>

      {!left && data.cards.length > 0 && (
        <div className="flex justify-end">
          <ButtonLink to="../report" size="lg">
            Go to the report
          </ButtonLink>
        </div>
      )}

      <ClipPlayer visitId={visit.visit_id} clip={clip} starts={data.piece_starts} onClose={() => setClip(null)} />
    </div>
  );
}
