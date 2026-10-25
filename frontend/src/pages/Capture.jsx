import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { api } from "../api";
import { VISIT_TYPES } from "../constants";
import { formatDate } from "../format";
import Icon from "../components/Icon";
import { Wordmark } from "../components/AppShell";
import { Loading, Notice } from "../components/ui";
import { MarkSheet, StatusDot } from "./Brief";

// The phone records 10-second pieces. Each piece is a complete file, so the laptop
// can process it on its own while the visit continues.
// The next piece starts OVERLAP_MS before the current one stops, so no word is lost in
// the gap between two recorders. The laptop removes words heard twice in the overlap.
const PIECE_MS = 10000;
const OVERLAP_MS = 500;
const VIDEO_TYPES = [
  ["video/webm;codecs=vp8,opus", ".webm"],
  ["video/webm", ".webm"],
  ["video/mp4;codecs=avc1,mp4a", ".mp4"],
  ["video/mp4", ".mp4"],
];
const AUDIO_TYPES = [
  ["audio/webm;codecs=opus", ".webm"],
  ["audio/webm", ".webm"],
  ["audio/mp4", ".mp4"],
];
const VOICE_SENTENCE =
  "I am visiting this company today to understand how the business runs, and I will keep short notes as we go.";

function pickType(list) {
  if (typeof MediaRecorder === "undefined") return null;
  for (const [mime, ext] of list) {
    if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  }
  return { mime: "", ext: list[0][1] };
}

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + rest : m + ":" + rest;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- voice sample

function VoiceSample() {
  const [info, setInfo] = useState(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.myVoice().then(setInfo).catch(() => {});
  }, []);

  async function record() {
    setError("");
    const type = pickType(AUDIO_TYPES);
    if (!type || !navigator.mediaDevices) {
      setError("This browser cannot record audio here.");
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone permission was not given.");
      return;
    }
    const parts = [];
    const rec = new MediaRecorder(stream, type.mime ? { mimeType: type.mime } : undefined);
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setBusy(true);
      try {
        setInfo(await api.saveVoice(new Blob(parts, { type: rec.mimeType || type.mime }), type.ext));
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
        setLeft(0);
      }
    };
    rec.start();
    for (let s = 8; s > 0; s--) {
      setLeft(s);
      await sleep(1000);
    }
    rec.stop();
  }

  if (!info) return null;
  return (
    <section className="rounded-xl bg-white/5 border border-white/10 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">1. Record your voice (8 seconds)</h2>
          <p className="text-base text-white/75 mt-0.5">
            {info.has_sample
              ? "Saved. SiteSense will know which voice is yours."
              : "So SiteSense knows which voice is yours. Done once."}
          </p>
        </div>
        {info.has_sample && <Icon name="check" size={20} className="text-[#6ce9a6] shrink-0" />}
      </div>
      {left > 0 ? (
        <div className="mt-3">
          <p className="text-[15px] leading-relaxed border-l-2 border-white/60 pl-3">{VOICE_SENTENCE}</p>
          <p className="text-sm text-white/70 mt-2 num">Recording, {left} s left. Read the sentence aloud.</p>
        </div>
      ) : (
        <button
          onClick={record}
          disabled={busy}
          className={
            "mt-3 h-12 px-5 rounded-xl text-base font-bold disabled:opacity-50 " +
            (info.has_sample ? "border-2 border-white/40" : "bg-white text-ink")
          }
        >
          {busy ? "Saving..." : info.has_sample ? "Record again" : "Record sample (8 s)"}
        </button>
      )}
      {!info.voice_matching_installed && (
        <p className="text-sm text-[#fec84b] mt-3">
          Voice matching is not installed on the laptop, so voices can't be told apart yet. On the laptop run:
          pip install -r requirements-voice.txt
        </p>
      )}
      {error && <p className="text-sm text-[#fda29b] mt-2">{error}</p>}
    </section>
  );
}

function OtherName({ onPick, label }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="h-14 rounded-xl border-2 border-dashed border-line-strong text-left px-4 text-lg text-sub">
        {label}
      </button>
    );
  }
  return (
    <div className="flex gap-2">
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={80}
        placeholder="Type a name"
        className="flex-1 h-14 rounded-xl border-2 border-line-strong px-4 text-lg"
      />
      <button disabled={text.trim().length < 2} onClick={() => onPick(text.trim())} className="h-14 px-5 rounded-xl bg-ink text-white text-lg font-bold disabled:opacity-40">
        Save
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- page

export default function Capture() {
  const { visitId } = useParams();
  const { user } = useAuth();
  const paired = !!user?.device_visit; // a phone paired by QR: it can only record this visit
  const [phase, setPhase] = useState("loading"); // loading, ready, recording, ending, finished, blocked
  const [status, setStatus] = useState(null);
  const [brief, setBrief] = useState(null);
  const [error, setError] = useState("");
  const [netError, setNetError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [sent, setSent] = useState(0);
  const [waiting, setWaiting] = useState(0);
  const [marks, setMarks] = useState(0);
  const [flash, setFlash] = useState(false);
  const [sheet, setSheet] = useState(null); // "checklist" | "end"
  const [openItem, setOpenItem] = useState(null);
  const [notDiscussed, setNotDiscussed] = useState([]);
  const [notShown, setNotShown] = useState([]);
  const [place, setPlace] = useState("");
  const [asking, setAsking] = useState("");
  const [toast, setToast] = useState("");
  const [replayBusy, setReplayBusy] = useState(false);

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recRef = useRef(null);
  const timerRef = useRef(null);
  const indexRef = useRef(0);
  const clockStartRef = useRef(0);
  const keepGoingRef = useRef(false);
  const pausedRef = useRef(false);
  const queueRef = useRef([]);
  const uploadingRef = useRef(false);
  const typeRef = useRef(null);
  const wakeRef = useRef(null);

  const secure = typeof window !== "undefined" && window.isSecureContext && !!navigator.mediaDevices;
  const now = () => Date.now() - clockStartRef.current;

  // ---- load ----
  useEffect(() => {
    Promise.all([api.captureStatus(visitId), api.getBrief(visitId)])
      .then(([st, br]) => {
        setStatus(st);
        setBrief(br);
        const state = st.session?.state;
        if (state && !["recording", "paused"].includes(state)) setPhase("finished");
        else setPhase("ready");
      })
      .catch((e) => {
        setError(e.message);
        setPhase("blocked");
      });
  }, [visitId]);

  // ---- clock ----
  useEffect(() => {
    if (phase !== "recording") return;
    const t = setInterval(() => setElapsed(now()), 500);
    return () => clearInterval(t);
  }, [phase]);

  // ---- show the camera ----
  useEffect(() => {
    if (phase === "recording" && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [phase]);

  // ---- warn before leaving, stop the camera when the page closes ----
  useEffect(() => {
    const warn = (e) => {
      if (keepGoingRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      keepGoingRef.current = false;
      clearTimeout(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // ---- uploads: kept in a queue on the phone until the laptop has them ----
  function enqueue(piece) {
    queueRef.current.push(piece);
    setWaiting(queueRef.current.length);
    pump();
  }

  async function pump() {
    if (uploadingRef.current) return;
    uploadingRef.current = true;
    while (queueRef.current.length) {
      const piece = queueRef.current[0];
      try {
        await api.uploadPiece(visitId, piece);
        queueRef.current.shift();
        setSent((n) => n + 1);
        setNetError("");
      } catch (e) {
        if (e.status === 409 || e.status === 413) {
          queueRef.current.shift(); // the laptop will never accept it; do not block the rest
        } else {
          setNetError("Cannot reach the laptop. Pieces stay on this phone and are sent when it is back.");
          await sleep(3000);
        }
      }
      setWaiting(queueRef.current.length);
    }
    uploadingRef.current = false;
  }

  // ---- recording, one 10-second piece at a time ----
  // Returns true if a new piece started recording.
  function startPiece() {
    if (!keepGoingRef.current || pausedRef.current || !streamRef.current) return false;
    const type = typeRef.current;
    let rec;
    try {
      try {
        rec = new MediaRecorder(
          streamRef.current,
          type.mime ? { mimeType: type.mime, videoBitsPerSecond: 1200000, audioBitsPerSecond: 64000 } : undefined
        );
      } catch {
        rec = new MediaRecorder(streamRef.current);
      }
      rec.start();
    } catch {
      return false; // this phone cannot run two recorders at once: the caller falls back to one after the other
    }
    const parts = [];
    const index = indexRef.current++;
    const startMs = now();
    let handedOver = false; // true once the next piece is already recording
    let timer = null;
    rec.ondataavailable = (e) => e.data && e.data.size && parts.push(e.data);
    rec.onstop = () => {
      clearTimeout(timer);
      const blob = new Blob(parts, { type: rec.mimeType || type.mime });
      if (blob.size > 0) enqueue({ index, startMs, endMs: now(), blob, ext: type.ext });
      if (!handedOver) startPiece(); // stopped early, or the overlap was not possible
    };
    recRef.current = rec;
    timer = setTimeout(() => {
      if (rec.state !== "recording") return;
      // Start the next piece first, then stop this one a moment later.
      handedOver = startPiece();
      setTimeout(() => rec.state === "recording" && rec.stop(), handedOver ? OVERLAP_MS : 0);
    }, PIECE_MS);
    timerRef.current = timer;
    return true;
  }

  async function start() {
    setError("");
    typeRef.current = pickType(VIDEO_TYPES);
    if (!typeRef.current) {
      setError("This browser cannot record video. Use Chrome on Android or Safari on iPhone.");
      return;
    }
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      setError("Camera or microphone permission was not given. Allow both in the browser settings.");
      return;
    }
    try {
      const res = await api.captureStart(visitId);
      const st = await api.captureStatus(visitId);
      const chunks = st.session?.chunks || [];
      indexRef.current = chunks.length ? Math.max(...chunks.map((c) => c.index)) + 1 : 0;
      const resumeAt = res.resumed && chunks.length ? Math.max(...chunks.map((c) => c.end_ms)) + 1000 : 0;
      clockStartRef.current = Date.now() - resumeAt;
      setMarks(st.session?.marks?.length || 0);
      setStatus(st);
    } catch (e) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      setError(e.message);
      return;
    }
    try {
      wakeRef.current = await navigator.wakeLock?.request("screen");
    } catch {
      wakeRef.current = null; // screen may dim; recording continues while the page is open
    }
    keepGoingRef.current = true;
    pausedRef.current = false;
    setPaused(false);
    setPhase("recording");
    if (!startPiece()) setError("The phone could not start recording. Close other camera apps and try again.");
  }

  async function mark() {
    const t = now() / 1000;
    navigator.vibrate?.(60);
    setFlash(true);
    setTimeout(() => setFlash(false), 500);
    try {
      const r = await api.captureMark(visitId, t);
      setMarks(r.marks);
    } catch (e) {
      setNetError(e.message);
    }
  }

  function say(text) {
    setToast(text);
    setTimeout(() => setToast(""), 1800);
  }

  async function nowIn(name) {
    const t = now() / 1000;
    setSheet(null);
    setPlace(name);
    navigator.vibrate?.(40);
    say("Now in: " + name);
    try {
      await api.capturePlace(visitId, t, name);
    } catch (e) {
      setNetError(e.message);
    }
  }

  async function askingNow(name) {
    const t = now() / 1000;
    setSheet(null);
    setAsking(name);
    navigator.vibrate?.(40);
    say("Asking " + name);
    try {
      await api.captureAsking(visitId, t, name);
    } catch (e) {
      setNetError(e.message);
    }
  }

  async function togglePause() {
    const t = now() / 1000;
    if (!pausedRef.current) {
      pausedRef.current = true;
      setPaused(true);
      if (recRef.current?.state === "recording") recRef.current.stop();
    } else {
      pausedRef.current = false;
      setPaused(false);
      startPiece();
    }
    try {
      await api.capturePause(visitId, pausedRef.current, t);
    } catch (e) {
      setNetError(e.message);
    }
  }

  async function openEnd() {
    setSheet("end");
    try {
      const st = await api.captureStatus(visitId);
      setNotDiscussed(st.live?.not_discussed || []);
      setNotShown(st.live?.not_shown || []);
    } catch {
      setNotDiscussed([]);
      setNotShown([]);
    }
  }

  async function end() {
    setSheet(null);
    setPhase("ending");
    keepGoingRef.current = false;
    if (recRef.current?.state === "recording") recRef.current.stop();
    await sleep(OVERLAP_MS + 400); // a piece in its overlap stops by itself; wait for it
    for (let i = 0; i < 600 && (queueRef.current.length || uploadingRef.current); i++) {
      await sleep(500);
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    try {
      wakeRef.current?.release();
    } catch {
      /* ignore */
    }
    try {
      await api.captureEnd(visitId);
      setPhase("finished");
    } catch (e) {
      setError(e.message);
      setPhase("finished");
    }
  }

  async function recordWithCameraApp(file) {
    if (!file) return;
    setReplayBusy(true);
    setError("");
    try {
      await api.uploadReplay(visitId, file);
      setPhase("finished");
    } catch (e) {
      setError(e.message);
    } finally {
      setReplayBusy(false);
    }
  }

  async function markItem(itemId, statusValue, note) {
    const updated = await api.markItem(visitId, itemId, statusValue, note);
    setBrief((b) => ({ ...b, items: b.items.map((i) => (i.id === itemId ? updated : i)) }));
  }

  // ---------------------------------------------------------------- views

  if (phase === "loading") return <Loading />;

  const v = brief?.visit;
  const shell = (children) => (
    <div className="min-h-screen bg-[#171b45] text-white">
      <div className="max-w-lg mx-auto px-4 pt-4 pb-10">
        <div className="flex items-center justify-between mb-5">
          {paired ? (
            <span className="text-base text-white/75">Paired to record this visit</span>
          ) : (
            <Link to={"/visits/" + visitId + "/live"} className="inline-flex items-center gap-1 text-base text-white/75">
              <Icon name="back" size={16} /> Visit
            </Link>
          )}
          <Wordmark className="text-lg" />
        </div>
        {children}
      </div>
    </div>
  );

  if (phase === "blocked") {
    return shell(
      <Notice tone="high" className="bg-white">
        {error}
      </Notice>
    );
  }

  if (phase === "finished" || phase === "ending") {
    return shell(
      <div className="text-center pt-16">
        <div className="w-14 h-14 rounded-full bg-white/10 grid place-items-center mx-auto">
          <Icon name="check" size={28} />
        </div>
        <h1 className="text-2xl font-bold mt-5">
          {phase === "ending" ? "Sending the last pieces..." : "Visit recorded"}
        </h1>
        <p className="text-white/75 mt-2 max-w-xs mx-auto">
          {phase === "ending"
            ? waiting + " piece" + (waiting === 1 ? "" : "s") + " left to send. Keep this page open."
            : "Open the review on the laptop."}
        </p>
        {error && <p className="text-[#fda29b] mt-4">{error}</p>}
        {phase === "finished" && !paired && (
          <Link
            to={"/visits/" + visitId + "/review"}
            className="inline-flex mt-8 h-14 px-7 items-center rounded-xl bg-white text-ink text-lg font-bold"
          >
            Open the review
          </Link>
        )}
      </div>
    );
  }

  if (phase === "ready") {
    return shell(
      <div className="space-y-4">
        <div>
          <h1 className="text-3xl font-bold leading-tight">{v.company}</h1>
          <p className="text-white/75 text-lg">
            {VISIT_TYPES[v.visit_type]} visit, {v.location}, {formatDate(v.visit_date)}
          </p>
        </div>

        {!secure ? (
          <section className="rounded-xl bg-[#fef3f2] text-[#912018] p-4 text-sm">
            <p className="font-semibold">Live recording needs a secure (https) page.</p>
            <p className="mt-1">
              Open this page with https:// in the address, or record with the phone's camera app and upload the video
              below.
            </p>
          </section>
        ) : (
          <VoiceSample />
        )}

        <section className="rounded-xl bg-white/5 border border-white/10 p-4">
          <h2 className="text-lg font-bold">2. Tap Start, then read this aloud</h2>
          <p className="text-lg leading-relaxed mt-2 border-l-4 border-white/60 pl-3">{brief.consent_script}</p>
        </section>

        {error && <p className="text-[#fda29b]">{error}</p>}

        {!status?.session && status?.system?.blockers?.length > 0 && (
          <p className="text-[#fda29b] text-sm">
            The laptop is not ready yet: {status.system.blockers.join(" ")} Check the Visit step on the laptop.
          </p>
        )}

        {secure && (
          <button onClick={start} className="w-full h-16 rounded-xl bg-white text-ink text-xl font-bold">
            {status?.session ? "Continue recording" : "Start visit"}
          </button>
        )}

        {!status?.session && (
          <label className="block text-center text-base text-white/80 underline pt-2 cursor-pointer">
            {replayBusy ? "Uploading the video..." : "Or record with the camera app and upload"}
            <input
              type="file"
              accept="video/*"
              capture="environment"
              className="hidden"
              disabled={replayBusy}
              onChange={(e) => recordWithCameraApp(e.target.files[0])}
            />
          </label>
        )}
      </div>
    );
  }

  // ---- recording ----
  const done = brief.items.filter((i) => i.status !== "pending").length;
  return (
    <div className="fixed inset-0 bg-black text-white flex flex-col">
      <div className="relative flex-1 min-h-0">
        <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 w-full h-full object-cover" />
        {paused && (
          <div className="absolute inset-0 bg-black/80 grid place-items-center text-center px-6">
            <div>
              <p className="text-xl font-bold">Privacy pause</p>
              <p className="text-white/75 mt-1">Nothing is being recorded.</p>
            </div>
          </div>
        )}
        {flash && <div className="absolute inset-0 border-[6px] border-white pointer-events-none" />}
        <div className="absolute top-0 inset-x-0 p-3 flex items-center justify-between bg-gradient-to-b from-black/70 to-transparent">
          <span className="inline-flex items-center gap-2 text-sm font-semibold">
            <span className={"w-2.5 h-2.5 rounded-full " + (paused ? "bg-white/50" : "bg-[#f04438] animate-pulse")} />
            <span className="num">{paused ? "Paused" : "REC " + clock(elapsed)}</span>
          </span>
          <span className="text-sm text-white/85 num">
            {sent} sent{waiting ? ", " + waiting + " waiting" : ""}
          </span>
        </div>
        {(place || asking) && (
          <div className="absolute top-12 left-3 flex flex-col gap-1.5 items-start">
            {place && <span className="rounded-lg bg-black/60 px-3 py-1.5 text-base font-bold">In: {place}</span>}
            {asking && <span className="rounded-lg bg-black/60 px-3 py-1.5 text-base">Asking: {asking}</span>}
          </div>
        )}
        {toast && (
          <div className="absolute inset-x-0 bottom-6 grid place-items-center pointer-events-none">
            <span className="rounded-xl bg-white text-ink px-5 py-3 text-lg font-bold">{toast}</span>
          </div>
        )}
        {netError && (
          <div className="absolute top-12 inset-x-3 rounded-lg bg-[#b42318] px-3 py-2 text-sm">{netError}</div>
        )}
      </div>

      <div className="bg-[#171b45] px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setSheet("asking")}
            disabled={paused}
            className="h-16 rounded-xl bg-white text-ink text-lg font-bold disabled:opacity-40"
          >
            Asking now
          </button>
          <button
            onClick={() => setSheet("place")}
            disabled={paused}
            className="h-16 rounded-xl bg-white text-ink text-lg font-bold disabled:opacity-40"
          >
            Now in
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2 mt-2">
          <button onClick={mark} disabled={paused} className="h-14 rounded-xl bg-white/15 text-base font-bold disabled:opacity-40">
            Mark{marks ? " " + marks : ""}
          </button>
          <button
            onClick={togglePause}
            className={"h-14 rounded-xl text-base font-bold " + (paused ? "bg-white text-ink" : "bg-white/15")}
          >
            {paused ? "Resume" : "Pause"}
          </button>
          <button onClick={() => setSheet("checklist")} className="h-14 rounded-xl bg-white/15 text-base font-bold">
            List <span className="num text-white/70">{done}/{brief.items.length}</span>
          </button>
        </div>
        <button onClick={openEnd} className="w-full h-12 mt-2 rounded-xl border-2 border-white/40 text-base font-bold">
          End visit
        </button>
      </div>

      {sheet === "checklist" && (
        <div className="fixed inset-0 z-40 flex items-end">
          <div className="absolute inset-0 bg-black/50" onClick={() => setSheet(null)} />
          <div className="sheet-enter relative w-full bg-canvas text-text rounded-t-2xl max-h-[80vh] overflow-y-auto">
            <div className="sticky top-0 bg-canvas px-4 pt-3 pb-2 border-b border-line flex items-center justify-between">
              <span className="text-xl font-bold">Checklist</span>
              <button onClick={() => setSheet(null)} className="h-11 px-3 text-base font-bold text-ink">
                Close
              </button>
            </div>
            <ul className="p-3 space-y-2">
              {brief.items.map((item) => (
                <li key={item.id}>
                  <button
                    onClick={() => setOpenItem(item)}
                    className="w-full text-left bg-white rounded-lg border border-line px-3 py-3 flex gap-3 items-start"
                  >
                    <StatusDot status={item.status} />
                    <span className="min-w-0">
                      <span className="block text-sm text-sub">{item.area}</span>
                      <span className="block text-base leading-snug">{item.text}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {(sheet === "asking" || sheet === "place") && (
        <div className="fixed inset-0 z-40 flex items-end">
          <div className="absolute inset-0 bg-black/50" onClick={() => setSheet(null)} />
          <div className="sheet-enter relative w-full bg-white text-text rounded-t-2xl px-4 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xl font-bold">{sheet === "asking" ? "Who are you asking?" : "Where are you now?"}</h2>
              <button onClick={() => setSheet(null)} className="h-11 px-3 text-base font-bold text-ink">Close</button>
            </div>
            <div className="grid gap-2">
              {(sheet === "asking"
                ? (v.people || []).map((p) => p.name + (p.role ? ", " + p.role : ""))
                : (brief.places || []).map((p) => p.name)
              ).map((name) => (
                <button
                  key={name}
                  onClick={() => (sheet === "asking" ? askingNow(name) : nowIn(name))}
                  className={
                    "h-14 rounded-xl border-2 text-left px-4 text-lg font-bold " +
                    ((sheet === "asking" ? asking : place) === name ? "border-ink bg-ink-50" : "border-line")
                  }
                >
                  {name}
                </button>
              ))}
              <OtherName onPick={(name) => (sheet === "asking" ? askingNow(name) : nowIn(name))} label={sheet === "asking" ? "Someone else" : "Another place"} />
            </div>
          </div>
        </div>
      )}

      {sheet === "end" && (
        <div className="fixed inset-0 z-40 flex items-end">
          <div className="absolute inset-0 bg-black/50" onClick={() => setSheet(null)} />
          <div className="sheet-enter relative w-full bg-white text-text rounded-t-2xl px-5 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] max-h-[85vh] overflow-y-auto">
            <h2 className="text-xl font-bold">End the visit?</h2>
            {notShown.length > 0 && (
              <div className="mt-3 rounded-lg bg-med-bg text-med px-3 py-2.5">
                <p className="font-bold">Not shown yet: {notShown.join(", ")}</p>
                <p className="text-sm mt-0.5">You can still ask to see them.</p>
              </div>
            )}
            {notDiscussed.length > 0 ? (
              <>
                <p className="text-base font-bold mt-3">Not asked yet:</p>
                <ul className="mt-3 space-y-2">
                  {notDiscussed.map((i) => (
                    <li key={i.id} className="text-base border-l-4 border-high pl-3">
                      {i.text}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-base text-sub mt-2">All high-priority questions have come up.</p>
            )}
            <div className="grid grid-cols-2 gap-2 mt-5">
              <button onClick={() => setSheet(null)} className="h-14 rounded-xl border-2 border-line-strong text-lg font-bold">
                Keep recording
              </button>
              <button onClick={end} className="h-14 rounded-xl bg-ink text-white text-lg font-bold">
                End visit
              </button>
            </div>
          </div>
        </div>
      )}

      {openItem && <MarkSheet item={openItem} onClose={() => setOpenItem(null)} onSave={markItem} />}
    </div>
  );
}
