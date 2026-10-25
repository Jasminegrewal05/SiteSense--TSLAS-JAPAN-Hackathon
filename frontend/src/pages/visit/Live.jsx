import { useEffect, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { api } from "../../api";
import Icon from "../../components/Icon";
import PhoneHandoff from "../../components/PhoneHandoff";
import { ButtonLink, Loading, Notice, Pill } from "../../components/ui";

const STATE = {
  recording: { label: "Recording", tone: "high" },
  paused: { label: "Privacy pause", tone: "neutral" },
  splitting: { label: "Reading the video", tone: "ink" },
  ending: { label: "Finishing", tone: "ink" },
  processing: { label: "Working out who said what", tone: "ink" },
  done: { label: "Processed", tone: "ok" },
  deleted: { label: "Deleted", tone: "neutral" },
  failed: { label: "Failed", tone: "high" },
};

const STEPS = [
  ["transcript", "Speech to text"],
  ["faces", "Faces and lips"],
  ["pictures", "Picture check"],
  ["blurred", "Blurred clip"],
  ["raw_deleted", "Unblurred deleted"],
];

function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function t(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function Step({ value }) {
  if (!value) return <span className="text-line-strong">-</span>;
  const good = value === "done" || /checked$/.test(value);
  const bad = /^failed|missing|no model/.test(value);
  return (
    <span className={"text-xs " + (good ? "text-ok font-semibold" : bad ? "text-high" : "text-sub")} title={value}>
      {good ? (value === "done" ? "Done" : value) : value}
    </span>
  );
}

function SystemCheck({ system }) {
  const rows = [
    ["ffmpeg (video tools)", system.ffmpeg ? "Installed" : "Missing: install ffmpeg", system.ffmpeg],
    ["Face finder", system.faces === "yunet" ? "Ready" : system.faces === "haar" ? "Basic (model file missing)" : "Missing", system.faces !== "missing"],
    ["Speech to text", system.speech === "ready" ? "Ready" : system.speech === "loading" ? "Loading the model..." : system.speech, system.speech === "ready"],
    ["Voice matching", system.voice_matching ? "Installed" : "Not installed (optional)", system.voice_matching],
    ["Picture check (AI)", system.picture_check ? "On, up to " + system.ai_budget + " pictures" : "Off (no AI key)", system.picture_check],
  ];
  const blockers = system.blockers || [];
  return (
    <>
      <ul className="text-sm divide-y divide-line">
        {rows.map(([name, text, ok]) => (
          <li key={name} className="flex justify-between gap-4 py-2">
            <span>{name}</span>
            <span className={ok ? "text-ok font-semibold" : "text-sub"}>{text}</span>
          </li>
        ))}
      </ul>
      {blockers.length > 0 ? (
        <Notice tone="high" className="mt-3">
          <b>Recording is blocked until this is fixed</b>, so no part of the visit is lost unanalysed:
          <ul className="list-disc pl-5 mt-1">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </Notice>
      ) : (
        <p className="text-sm text-ok font-semibold mt-3">Ready to record.</p>
      )}
    </>
  );
}

export default function Live() {
  const { visit, reload } = useOutletContext();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const lastState = useRef(null);
  const locked = visit.status === "locked";

  useEffect(() => {
    if (!locked) return;
    let stop = false;
    async function poll() {
      try {
        const d = await api.captureStatus(visit.visit_id);
        if (stop) return;
        setData(d);
        const state = d.session?.state;
        if (state !== lastState.current) {
          lastState.current = state;
          reload();
        }
      } catch (e) {
        if (!stop) setError(e.message);
      }
    }
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [visit.visit_id, locked, reload]);

  if (!locked) {
    return (
      <div className="bg-white border border-line rounded-lg px-6 py-12 text-center">
        <h2 className="text-lg font-bold">Lock the checklist first</h2>
        <p className="text-sub mt-1 mb-6">The visit is recorded against a locked checklist, so nothing changes mid-visit.</p>
        <ButtonLink to="../checklist">Go to checklist</ButtonLink>
      </div>
    );
  }
  if (error && !data) return <Notice tone="high">{error}</Notice>;
  if (!data) return <Loading />;

  const s = data.session;

  async function replay(file) {
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      await api.uploadReplay(visit.visit_id, file);
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  }

  if (!s) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-bold">Record the visit</h2>
          <p className="text-sub text-sm mt-1 max-w-2xl">
            Scan the code with the phone you'll carry. Then tap Start visit on the phone.
          </p>
        </div>
        <PhoneHandoff path={"/visits/" + visit.visit_id + "/capture"} visitId={visit.visit_id} title="Scan with the recording phone">
          No sign-in on the phone. Same wifi as this laptop.
        </PhoneHandoff>
        <div className="bg-white border border-line rounded-lg p-5">
          <h3 className="font-bold">Or process a video you already recorded</h3>
          <p className="text-sm text-sub mt-1 max-w-xl">
            A backup if wifi fails. It goes through the same steps.
          </p>
          <label className="inline-flex mt-4 h-10 px-4 items-center gap-2 rounded-md border border-line-strong bg-white text-sm font-semibold cursor-pointer hover:bg-canvas">
            <Icon name="upload" size={16} /> {uploading ? "Uploading..." : "Choose a video"}
            <input type="file" accept="video/*" className="hidden" disabled={uploading} onChange={(e) => replay(e.target.files[0])} />
          </label>
        </div>
        {error && <Notice tone="high">{error}</Notice>}
        <div className="bg-white border border-line rounded-lg p-5">
          <h3 className="font-bold mb-2">This laptop</h3>
          <SystemCheck system={data.system} />
        </div>
      </div>
    );
  }

  const state = STATE[s.state] || { label: s.state, tone: "neutral" };
  const chunks = s.chunks;
  const deleted = chunks.filter((c) => c.steps?.raw_deleted === "done").length;
  const last = chunks.length ? chunks[chunks.length - 1].end_ms / 1000 : 0;
  const live = data.live;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold">{s.replay ? "Recorded video" : "Live visit"}</h2>
          <Pill tone={state.tone}>{state.label}</Pill>
          <span className="text-base text-sub num">{t(last)} recorded</span>
        </div>
        {s.state === "done" && (
          <ButtonLink to="../review">
            Open the review
          </ButtonLink>
        )}
      </div>

      {s.error && <Notice tone="high">{s.error}</Notice>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-line border border-line rounded-lg overflow-hidden">
        {[
          ["Unblurred pieces deleted", deleted + " of " + chunks.length, mb(s.meters.raw_deleted_bytes) + " removed"],
          ["Blurred clips kept", s.state === "done" ? mb(s.meters.kept_bytes) : mb(s.meters.pending_bytes) + " so far",
            s.state === "done" ? (s.kept_pieces || []).length + " clips linked to evidence" : "decided after the visit"],
          ["Picture checks", s.meters.ai_calls + " of " + data.system.ai_budget, data.system.picture_check ? "only blurred pictures sent" : "off (no AI key)"],
          ["Marks", String(s.marks.length), s.pauses.length + " privacy pause" + (s.pauses.length === 1 ? "" : "s")],
        ].map(([label, value, sub]) => (
          <div key={label} className="bg-white p-4">
            <div className="text-sm text-sub">{label}</div>
            <div className="text-2xl font-bold num mt-1">{value}</div>
            <div className="text-sm text-sub mt-0.5">{sub}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-6">
        <section className="bg-white border border-line rounded-lg overflow-hidden">
          <h3 className="px-5 py-3.5 border-b border-line font-bold text-lg">Pieces from the phone</h3>
          <div className="overflow-x-auto max-h-[460px] overflow-y-auto">
            <table className="w-full text-base">
              <thead className="text-left text-sub sticky top-0 bg-white">
                <tr>
                  <th className="px-4 py-2 font-semibold">Time</th>
                  {STEPS.map(([k, label]) => (
                    <th key={k} className="px-3 py-2 font-semibold whitespace-nowrap">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {chunks.slice().reverse().map((c) => (
                  <tr key={c.index} className="border-t border-line">
                    <td className="px-4 py-2 num whitespace-nowrap">
                      {t(c.start_ms / 1000)} to {t(c.end_ms / 1000)}
                      {c.status === "failed" && <div className="text-xs text-high">{c.error}</div>}
                      {c.status !== "done" && c.status !== "failed" && <div className="text-xs text-sub">{c.status}</div>}
                    </td>
                    {STEPS.map(([k]) => (
                      <td key={k} className="px-3 py-2"><Step value={c.steps?.[k]} /></td>
                    ))}
                  </tr>
                ))}
                {chunks.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-sub">Waiting for the first piece...</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="bg-white border border-line rounded-lg overflow-hidden flex flex-col">
          <h3 className="px-5 py-3.5 border-b border-line font-bold text-lg">
            What was said so far <span className="text-sub font-normal text-base">(names are set after the visit)</span>
          </h3>
          <ol className="p-5 space-y-3 text-base max-h-[460px] overflow-y-auto">
            {live.transcript.length === 0 && <li className="text-sub">Nothing transcribed yet.</li>}
            {live.transcript.slice().reverse().map((l, i) => (
              <li key={i}>
                <div className="text-sm text-sub num">{t(l.time)}, {l.label}</div>
                <div>{l.text}</div>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {live.notes.length > 0 && (
        <section className="bg-white border border-line rounded-lg">
          <h3 className="px-5 py-3.5 border-b border-line font-bold text-lg">Picture checks</h3>
          <ul className="divide-y divide-line text-base">
            {live.notes.slice().reverse().map((n, i) => {
              const answered = Object.entries(n.answers).filter(([, a]) => a.means !== "unclear");
              return (
                <li key={i} className="px-5 py-3">
                  <span className="num text-sub mr-2">{t(n.time)}</span>
                  <span className="font-semibold">{n.area}</span>
                  {n.at_mark && <span className="ml-2 text-xs text-ink font-semibold">at a mark</span>}
                  <span className="text-sub">
                    {answered.length
                      ? ": " + answered.map(([id, a]) => id + " " + a.option.toLowerCase()).join("; ")
                      : ": nothing clearly visible for the checklist"}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {["recording", "paused"].includes(s.state) && live.not_discussed.length > 0 && (
        <p className="text-base text-sub">Not asked yet: {live.not_discussed.map((i) => i.id).join(", ")}</p>
      )}

      <p className="text-sm text-sub">
        <Icon name="lock" size={14} className="inline -mt-0.5 mr-1" />
        Every deletion is logged.{" "}
        <Link to="../details" className="underline">Activity log</Link>
      </p>
    </div>
  );
}
