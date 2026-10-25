import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import { KINDS, MARK_STATUS } from "../../constants";
import { formatDateTime } from "../../format";
import Icon from "../../components/Icon";
import { Button, ButtonLink, Loading, Modal, Notice, Pill, inputClass } from "../../components/ui";

function t(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

const SURE = {
  high: { label: "Sure", tone: "ok" },
  medium: { label: "Likely", tone: "ink" },
  low: { label: "Unsure who", tone: "med" },
  unsure: { label: "Unsure", tone: "neutral" },
};

const CLAIM_SURE = {
  high: "seen saying it",
  medium: "matched by voice",
  low: "speaker not confirmed",
};

const CUE_LABEL = { no_number: "No number given", long_pause: "Long pause", vague: "Hedging words" };

// One transcript line: shows when the words may be wrong, and lets the analyst correct them.
function LineText({ line, quote, canFix, onFix, play }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(line.text);
  const [busy, setBusy] = useState(false);
  if (editing) {
    return (
      <div className="flex flex-col sm:flex-row gap-2 my-1">
        <input value={text} onChange={(e) => setText(e.target.value)} className={inputClass} autoFocus maxLength={1000} />
        <Button
          size="sm"
          busy={busy}
          disabled={!text.trim()}
          onClick={async () => {
            setBusy(true);
            if (await onFix(line.id, text)) setEditing(false);
            setBusy(false);
          }}
        >
          Save
        </Button>
        <Button size="sm" variant="quiet" onClick={() => setEditing(false)}>Cancel</Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>{quote ? '"' + line.text + '"' : line.text}</span>
      {line.unclear && <span className="text-sm font-bold text-med">Words may be wrong</span>}
      {line.original && <span className="text-sm text-sub">(corrected; heard as "{line.original}")</span>}
      {canFix && (line.unclear || !quote) && (
        <>
          {line.unclear && play}
          <button onClick={() => setEditing(true)} className="text-sm font-bold text-ink underline">
            Fix
          </button>
        </>
      )}
    </div>
  );
}

function minutes(sec) {
  const s = Math.round(sec);
  if (s < 60) return s + " s";
  return Math.floor(s / 60) + " min " + String(s % 60).padStart(2, "0") + " s";
}

function Section({ title, sub, children, aside }) {
  return (
    <section>
      <div className="flex items-baseline justify-between gap-4 mb-3">
        <div>
          <h2 className="text-xl font-bold">{title}</h2>
          {sub && <p className="text-base text-sub mt-0.5 max-w-2xl">{sub}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export default function Review() {
  const { visit, reload } = useOutletContext();
  const { user } = useAuth();
  const isManager = user.role === "manager";
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [names, setNames] = useState({});
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState("");
  const [player, setPlayer] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [check, setCheck] = useState(null);
  const videoRef = useRef(null);
  const state = visit.progress.capture;

  const load = useCallback(() => {
    return api
      .getReview(visit.visit_id)
      .then((d) => {
        setData(d);
        setNames(Object.fromEntries(d.people.map((p) => [p.id, p.name || ""])));
      })
      .catch((e) => setError(e.message));
  }, [visit.visit_id]);

  useEffect(() => {
    if (state === "done" || state === "deleted") load();
  }, [state, load]);

  // While the laptop is still processing, check again every few seconds.
  useEffect(() => {
    if (!state || state === "done" || state === "deleted" || state === "failed") return;
    const timer = setInterval(reload, 3000);
    return () => clearInterval(timer);
  }, [state, reload]);

  const speakerName = useMemo(() => {
    const map = { analyst: data?.analyst_name || "You", unknown: "Unknown speaker" };
    (data?.people || []).forEach((p) => (map[p.id] = names[p.id] || p.label));
    return (id) => (id ? map[id] || id : "Unsure who");
  }, [data, names]);

  if (!state) {
    return (
      <div className="bg-white border border-line rounded-lg px-6 py-12 text-center">
        <h2 className="text-lg font-bold">Nothing to review yet</h2>
        <p className="text-sub mt-1 mb-6">Record the visit first.</p>
        <ButtonLink to="../live">Go to the visit</ButtonLink>
      </div>
    );
  }
  if (state !== "done" && state !== "deleted") {
    return (
      <div className="bg-white border border-line rounded-lg px-6 py-12 text-center">
        <h2 className="text-lg font-bold">{state === "failed" ? "Processing failed" : "Still processing"}</h2>
        <p className="text-sub mt-1">
          {state === "failed" ? "See the Visit step for details." : "The review opens when the laptop has finished. This page checks every few seconds."}
        </p>
      </div>
    );
  }
  if (error && !data) return <Notice tone="high">{error}</Notice>;
  if (!data) return <Loading />;

  if (data.state === "deleted") {
    return <Notice tone="ink">The recording of this visit was deleted. The audit log keeps a record of the deletion.</Notice>;
  }

  const pieces = data.pieces;
  const kept = new Set(data.kept_pieces);
  const lines = data.transcript.lines;
  const lineById = Object.fromEntries(lines.map((l) => [l.id, l]));

  function play(piece, time) {
    if (!kept.has(piece)) return;
    const start = pieces[String(piece)]?.start || 0;
    setPlayer({ piece, offset: Math.max(0, time - start - 1), time });
  }

  function PlayButton({ piece, time }) {
    if (!kept.has(piece)) return null;
    return (
      <button
        onClick={() => play(piece, time)}
        className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-line-strong bg-white text-sm font-bold text-ink hover:bg-ink-50 shrink-0"
        aria-label={"Play clip at " + t(time)}
        title="Play the blurred clip"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1l7 4-7 4z" fill="currentColor" /></svg>
        <span className="num">{t(time)}</span>
      </button>
    );
  }

  async function decide(sid, action) {
    setError("");
    setBusy(sid);
    try {
      const sg = await api.decideSuggestion(visit.visit_id, sid, action);
      setData((d) => ({ ...d, suggestions: d.suggestions.map((x) => (x.id === sid ? sg : x)) }));
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  async function fixLine(lineId, text) {
    setError("");
    try {
      await api.fixLine(visit.visit_id, lineId, text);
      await load();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    }
  }

  async function saveNames() {
    setBusy("names");
    try {
      await api.namePeople(visit.visit_id, names);
      setSaved("names");
      setTimeout(() => setSaved(""), 2500);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  async function consent(action) {
    setBusy("consent");
    setError("");
    try {
      await api.consentDecision(visit.visit_id, action);
      setConfirmDelete(false);
      await reload();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  async function finish() {
    setBusy("finish");
    try {
      await api.finishReview(visit.visit_id);
      await reload();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  async function verify() {
    setBusy("verify");
    setError("");
    try {
      setCheck(await api.verifyEvidence(visit.visit_id));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  async function toggleHold() {
    setBusy("hold");
    setError("");
    try {
      const on = !data.legal_hold;
      const reason = on ? window.prompt("Reason for the legal hold (for the audit log):", "") ?? null : "";
      if (reason === null) return;
      await api.setLegalHold(visit.visit_id, on, reason);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  const closed = !!data.reviewed_at;
  const c = data.consent || { status: "not_found" };
  const consentOk = c.status === "found" || c.confirmed_by;
  const open = data.suggestions.filter((s) => !s.decision);
  const peopleOptions = data.visit_people.map((p) => p.name + (p.role ? ", " + p.role : ""));

  return (
    <div className="space-y-10">
      {data.reviewed_at && (
        <Notice tone="ok">Review finished on {formatDateTime(data.reviewed_at)}. It is locked and fingerprinted; see the bottom of this page.</Notice>
      )}

      {data.not_analysed.length > 0 && (
        <Section
          title="Not analysed: please listen"
          sub="Speech to text failed for these pieces, even when tried again after the visit. Their blurred clips were kept, never deleted, so nothing said here is lost."
        >
          <ul className="bg-white border border-high/40 rounded-lg divide-y divide-line text-sm">
            {data.not_analysed.map((p) => (
              <li key={p} className="px-5 py-3 flex items-center gap-3">
                <PlayButton piece={p} time={pieces[String(p)]?.start || 0} />
                <span>Piece {p + 1}, from <span className="num">{t(pieces[String(p)]?.start || 0)}</span> to{" "}
                  <span className="num">{t(pieces[String(p)]?.end || 0)}</span></span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {data.lost_pieces.length > 0 && (
        <Notice tone="med">
          {data.lost_pieces.length} piece(s) could not be processed at all ({data.lost_pieces.map((p) => t(pieces[String(p)]?.start || 0)).join(", ")}).
          Their unblurred video was still deleted, because faces are never kept unblurred. See the Visit step for the error.
        </Notice>
      )}

      {/* 1. consent */}
      <Section title="Consent">
        <div className={"bg-white border rounded-lg p-5 " + (consentOk ? "border-line" : "border-high/40")}>
          {c.status === "found" ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <Pill tone="ok">Consent found</Pill>
              <span>Asked at <span className="num">{t(c.asked_at)}</span>, answered at <span className="num">{t(c.answered_at)}</span>.</span>
              <PlayButton piece={lineById[c.ask_line]?.piece} time={c.asked_at} />
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-3">
                <Pill tone="high">{c.status === "asked_no_reply" ? "Reply not detected" : "Consent not found"}</Pill>
                {c.asked_at !== undefined && (
                  <>
                    <span>The consent line was read at <span className="num">{t(c.asked_at)}</span>, but no clear yes was heard.</span>
                    <PlayButton piece={lineById[c.ask_line]?.piece} time={c.asked_at} />
                  </>
                )}
              </div>
              {c.confirmed_by || closed ? (
                <p className="text-ok font-semibold">{c.confirmed_by ? "Confirmed by you on " + formatDateTime(c.confirmed_at) + "." : "Review finished."}</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => consent("confirm")} busy={busy === "consent"}>
                    Consent was given
                  </Button>
                  <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                    Delete the whole recording
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </Section>

      {/* 2. people */}
      <Section title="Who spoke" sub="Check the names. Names from your Asking now taps are filled in.">
        {data.people.length === 0 ? (
          <p className="text-sm text-sub">No one from the company was seen speaking on camera.</p>
        ) : (
          <div className="bg-white border border-line rounded-lg divide-y divide-line">
            {data.people.map((p) => (
              <div key={p.id} className="p-5 grid md:grid-cols-[1fr_260px] gap-4">
                <div className="min-w-0">
                  <div className="text-lg font-bold">
                    {names[p.id] || p.label}{" "}
                    <span className="text-sub font-normal text-base">
                      {p.lines} lines, {p.kind === "voice" ? "heard, not seen on camera" : "seen speaking " + p.seen + " times"}
                      {p.named_by === "asking_now" ? ", named from Asking now" : ""}
                    </span>
                  </div>
                  <ul className="mt-2 space-y-1.5 text-base">
                    {p.quotes.map((q, i) => (
                      <li key={i} className="flex gap-2 items-start">
                        <PlayButton piece={q.piece} time={q.time} />
                        <span className="pt-1">"{q.text}"</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <label className="text-base font-bold block mb-1.5" htmlFor={"name-" + p.id}>Who is this?</label>
                  <input
                    id={"name-" + p.id}
                    list="visit-people"
                    value={names[p.id] || ""}
                    onChange={(e) => setNames({ ...names, [p.id]: e.target.value })}
                    disabled={closed}
                    className={inputClass}
                    placeholder="Name and role"
                  />
                </div>
              </div>
            ))}
            <div className="px-5 py-3 flex items-center justify-end gap-3">
              {saved === "names" && <span className="text-sm text-ok">Names saved.</span>}
              {!closed && <Button variant="secondary" onClick={saveNames} busy={busy === "names"}>Save names</Button>}
            </div>
          </div>
        )}
        <datalist id="visit-people">
          {peopleOptions.map((o) => <option key={o} value={o} />)}
        </datalist>
      </Section>

      {/* 3. suggestions */}
      <Section
        title="Suggested ticks"
        sub="You decide. A tick you made by hand is never replaced."
        aside={<span className="text-sm text-sub num">{open.length} to decide</span>}
      >
        {data.suggestions.length === 0 ? (
          <p className="text-sm text-sub">No suggestions for this visit.</p>
        ) : (
          <div className="bg-white border border-line rounded-lg divide-y divide-line">
            {data.suggestions.map((sg) => {
              const item = data.items[sg.item];
              const hand = item?.marked_by === "manual";
              return (
                <div key={sg.id} className="p-5 flex flex-col md:flex-row gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-sub">
                      {item.area}, {KINDS[item.kind].toLowerCase()} <span className="num">({sg.item})</span>
                    </div>
                    <p className="mt-0.5">{item.text}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                      <Pill tone={sg.status === "issue" ? "high" : "ok"}>{MARK_STATUS[sg.status].label}</Pill>
                      <span className="text-sub">{sg.text}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {sg.evidence.map((e, i) => <PlayButton key={i} piece={e.piece} time={e.time} />)}
                    </div>
                    {hand && !sg.decision && (
                      <p className="text-xs text-sub mt-2">
                        You marked this by hand during the visit: {MARK_STATUS[item.status].label.toLowerCase()}
                        {item.note ? " (" + item.note + ")" : ""}.
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 flex md:flex-col gap-2 md:w-36">
                    {sg.decision || closed ? (
                      <Pill tone={sg.decision === "accepted" ? "ok" : "neutral"} className="self-start">
                        {sg.decision === "accepted" ? "Accepted" : sg.decision ? "Dismissed" : "Not decided"}
                      </Pill>
                    ) : (
                      <>
                        <Button className="h-9" onClick={() => decide(sg.id, "accept")} busy={busy === sg.id} disabled={hand}>
                          Accept
                        </Button>
                        <Button variant="secondary" className="h-9" onClick={() => decide(sg.id, "dismiss")}>
                          Dismiss
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* 4. claims */}
      <Section
        title="What the company said"
        sub="Compared with the numbers in Findings."
      >
        {data.claims.length === 0 ? (
          <p className="text-sm text-sub">No statements about checklist topics were found.</p>
        ) : (
          <ul className="bg-white border border-line rounded-lg divide-y divide-line">
            {data.claims.map((cl) => (
              <li key={cl.id} className="px-5 py-3 flex gap-3 items-start">
                <PlayButton piece={cl.piece} time={cl.time} />
                <div className="min-w-0 flex-1 pt-0.5">
                  <LineText
                    line={{ ...(lineById[cl.line] || {}), id: cl.line, text: cl.text, unclear: cl.unclear }}
                    quote
                    canFix={!closed && !isManager}
                    onFix={fixLine}
                  />
                  <div className="text-xs text-sub mt-1 flex flex-wrap gap-x-3">
                    <span className="font-semibold text-text">{speakerName(cl.speaker)}</span>
                    <span>{CLAIM_SURE[cl.sure]}</span>
                    <span className="num">about {cl.items.join(", ")}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* 5. cues */}
      <Section
        title="Worth a second look"
        sub="Neutral cues only. You decide what they mean."
      >
        {data.cues.length === 0 ? (
          <p className="text-sm text-sub">No cues for this visit.</p>
        ) : (
          <ul className="bg-white border border-line rounded-lg divide-y divide-line">
            {data.cues.map((q) => (
              <li key={q.id} className="px-5 py-3 flex gap-3 items-start">
                <PlayButton piece={q.piece} time={q.time} />
                <div className="pt-0.5">
                  <span className="text-xs font-semibold text-med mr-2">{CUE_LABEL[q.type]}</span>
                  <span>{q.text}</span>
                  {lineById[q.line] && <p className="text-xs text-sub mt-1">"{lineById[q.line].text}"</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* 6. not discussed */}
      {data.not_discussed.length > 0 && (
        <Section title="Questions that never came up" sub="These go into the report as not checked.">
          <ul className="bg-white border border-line rounded-lg divide-y divide-line text-sm">
            {data.not_discussed.map((id) => (
              <li key={id} className="px-5 py-3 flex gap-3">
                <span className="num text-sub w-20 shrink-0">{id}</span>
                <span>{data.items[id]?.text}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* 7. transcript */}
      {data.places.places.length > 0 && (
        <Section title="Places" sub="Time spent in each place on your list.">
          <ul className="bg-white border border-line rounded-xl divide-y divide-line">
            {data.places.places.map((pl) => (
              <li key={pl.name} className="px-5 py-3.5 flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="text-lg font-bold w-48 shrink-0">{pl.name}</span>
                {pl.seconds > 0 ? (
                  <>
                    <span className="num text-lg">{minutes(pl.seconds)}</span>
                    <PlayButton piece={pl.piece} time={pl.first} />
                  </>
                ) : (
                  <span className="tag tag-not_shown">Not shown</span>
                )}
                {(pl.reasons || []).map((r) => (
                  <span key={r.line} className="basis-full text-base text-sub flex items-start gap-2">
                    <PlayButton piece={r.piece} time={r.time} /> <span className="pt-1">Reason given: "{r.text}"</span>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Transcript">
        <details className="bg-white border border-line rounded-xl">
          <summary className="px-5 py-4 cursor-pointer text-base font-bold">Show the conversation ({lines.length} lines)</summary>
          <ol className="divide-y divide-line">
            {lines.reduce((turns, l) => {
              const last = turns[turns.length - 1];
              if (last && last.speaker === l.speaker) last.lines.push(l);
              else turns.push({ speaker: l.speaker, lines: [l] });
              return turns;
            }, []).map((turn, i) => (
              <li key={i} className="px-5 py-3.5 grid sm:grid-cols-[180px_1fr] gap-x-4 gap-y-1">
                <div>
                  <div className={"font-bold " + (turn.speaker === "analyst" ? "text-ink" : "")}>{speakerName(turn.speaker)}</div>
                  <div className="text-sm text-sub num">
                    {t(turn.lines[0].time)} <Pill tone={SURE[turn.lines[0].sure].tone} className="ml-1">{SURE[turn.lines[0].sure].label}</Pill>
                  </div>
                </div>
                <div className="space-y-1 text-base leading-relaxed">
                  {turn.lines.map((l) => (
                    <LineText
                      key={l.id}
                      line={l}
                      canFix={!closed && !isManager}
                      onFix={fixLine}
                      play={<PlayButton piece={l.piece} time={l.time} />}
                    />
                  ))}
                </div>
              </li>
            ))}
          </ol>
        </details>
      </Section>

      {error && <Notice tone="high">{error}</Notice>}

      <div className="border-t border-line pt-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <p className="text-base text-sub">
          <Icon name="lock" size={15} className="inline -mt-0.5 mr-1" />
          Kept for this visit: {(data.meters.kept_bytes / (1024 * 1024)).toFixed(1)} MB of blurred clips. Unblurred video removed:{" "}
          {(data.meters.raw_deleted_bytes / (1024 * 1024)).toFixed(1)} MB.
        </p>
        {!data.reviewed_at && (
          <Button size="lg" onClick={finish} busy={busy === "finish"} disabled={!consentOk}>
            Finish and lock review
          </Button>
        )}
      </div>

      <div className="bg-white border border-line rounded-lg p-5 grid md:grid-cols-2 gap-6 text-sm">
        <div>
          <h3 className="text-lg font-bold">Evidence fingerprint</h3>
          {data.fingerprint ? (
            <>
              <p className="text-sub mt-1">If any clip or file is changed later, this code no longer matches.</p>
              <p className="num text-xs mt-2 break-all bg-canvas rounded px-2 py-1.5">{data.fingerprint}</p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={verify} busy={busy === "verify"}>Check nothing changed</Button>
              {check && (
                <p className={"mt-2 font-semibold " + (check.ok ? "text-ok" : "text-high")}>
                  {check.ok
                    ? "All " + check.checked_files + " files match the fingerprint."
                    : "Changed since locking: " + [...check.changed, ...check.added].join(", ")}
                </p>
              )}
            </>
          ) : (
            <p className="text-sub mt-1">Made when you finish and lock the review.</p>
          )}
        </div>
        <div>
          <h3 className="text-lg font-bold">Legal hold {data.legal_hold && <Pill tone="high">On</Pill>}</h3>
          <p className="text-sub mt-1">Turn on during a dispute or audit. Nothing can then delete this visit's clips.</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={toggleHold} busy={busy === "hold"}>
            {data.legal_hold ? "Remove legal hold" : "Put on legal hold"}
          </Button>
        </div>
      </div>

      <Modal
        open={!!player}
        onClose={() => setPlayer(null)}
        title={player ? "Clip at " + t(player.time) + " (faces blurred)" : ""}
        footer={<Button variant="secondary" onClick={() => setPlayer(null)}>Close</Button>}
      >
        {player && (
          <video
            ref={videoRef}
            key={player.piece + "-" + player.time}
            src={api.clipUrl(visit.visit_id, player.piece)}
            controls
            autoPlay
            playsInline
            className="w-full rounded-md bg-black"
            onLoadedMetadata={(e) => (e.currentTarget.currentTime = player.offset)}
          />
        )}
      </Modal>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete the whole recording?"
        footer={
          <>
            <Button variant="quiet" onClick={() => setConfirmDelete(false)}>Keep it</Button>
            <Button variant="danger" onClick={() => consent("delete_all")} busy={busy === "consent"}>Delete everything</Button>
          </>
        }
      >
        <p className="text-sm text-sub">
          All clips, the transcript and the findings from this visit will be deleted. This cannot be undone. The audit log
          records that you deleted it.
        </p>
      </Modal>
    </div>
  );
}
