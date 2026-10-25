import { PURPOSES, VISIT_TYPES } from "../constants";
import { formatDate, formatDateTime, shortSource } from "../format";
import { ClipButton, clock } from "./Clip";
import { Tag, VERDICT } from "./ui";

function minutes(sec) {
  const s = Math.round(sec);
  if (s < 60) return s + " s";
  return Math.floor(s / 60) + " min " + String(s % 60).padStart(2, "0") + " s";
}

// In the app a clip opens in the player; on paper it prints as a time.
function ClipRef({ clip, onPlay }) {
  if (!clip) return null;
  if (onPlay) return <ClipButton clip={clip} onPlay={onPlay} />;
  return <span className="num text-sm text-sub whitespace-nowrap">[clip {clock(clip.time)}]</span>;
}

function Finding({ f, onPlay }) {
  const said = f.said.lines.filter((s) => s.result !== "explanation" || f.said.status === "explanation");
  return (
    <li className="py-4 break-inside-avoid">
      <div className="flex flex-wrap items-center gap-3">
        <h4 className="text-lg font-bold">{f.title}</h4>
        <Tag verdict={f.verdict} />
      </div>
      <ul className="mt-2 space-y-1.5 text-base">
        <li>
          <span className="font-bold">Numbers: </span>
          {f.figures.map((x) => x.label + " " + (x.previous ? x.previous + " to " : "") + x.current).join("; ")}
          {f.sources.length > 0 && <span className="text-sub"> (from {[...new Set(f.sources.map(shortSource))].join("; ")})</span>}
        </li>
        {said.slice(0, 2).map((s, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2">
            <span>
              <span className="font-bold">Said: </span>
              {s.speaker_name}: "{s.text}"{s.detail ? " (" + s.detail + ")" : ""}
            </span>
            <ClipRef clip={s.clip} onPlay={onPlay} />
          </li>
        ))}
        {(f.seen.ticks.length > 0 || f.seen.votes.ok + f.seen.votes.issue > 0 || f.seen.not_shown.length > 0) && (
          <li className="flex flex-wrap items-center gap-2">
            <span>
              <span className="font-bold">Seen: </span>
              {[
                ...f.seen.ticks.map((t) => (t.status === "issue" ? "issue found" : "looks fine") + (t.note ? " (" + t.note + ")" : "")),
                f.seen.votes.ok + f.seen.votes.issue > 0 ? f.seen.votes.issue + " of " + (f.seen.votes.ok + f.seen.votes.issue) + " pictures show a problem" : null,
                f.seen.not_shown.length ? f.seen.not_shown.join(", ") + " not shown" : null,
              ].filter(Boolean).join("; ")}
            </span>
            {f.seen.clips.slice(0, 2).map((c, i) => (
              <ClipRef key={i} clip={c} onPlay={onPlay} />
            ))}
          </li>
        )}
        {f.note && (
          <li>
            <span className="font-bold">Analyst's note: </span>
            {f.note}
          </li>
        )}
      </ul>
    </li>
  );
}

function Block({ title, children }) {
  return (
    <section className="py-5 border-t border-line break-inside-avoid-page">
      <h3 className="text-xl font-bold mb-2">{title}</h3>
      {children}
    </section>
  );
}

export default function ReportBody({ rep, onPlay }) {
  const v = rep.visit;
  const order = ["differs", "not_shown", "supported", "unchecked"];
  const rec = rep.recording;
  const places = rep.places?.places || [];

  return (
    <div>
      <header className="pb-5">
        <h2 className="text-3xl font-bold">{v.company}</h2>
        <p className="text-lg text-sub mt-1">
          {VISIT_TYPES[v.visit_type]} visit in {v.location}, {formatDate(v.visit_date)}. {PURPOSES[v.purpose]}.
        </p>
        <p className="text-base mt-2">
          Analyst: <b>{v.analyst_name}</b>
          {rep.approved_by && (
            <>
              . Approved by <b>{rep.approved_by}</b> on {formatDateTime(rep.approved_at)}
            </>
          )}
          .
        </p>
      </header>

      <Block title="Summary">
        <div className="flex flex-wrap gap-2 mb-3">
          {order.filter((k) => rep.counts[k]).map((k) => (
            <span key={k} className={"tag tag-" + k}>
              {rep.counts[k]} {VERDICT[k]}
            </span>
          ))}
        </div>
        {rep.summary ? <p className="text-lg leading-relaxed max-w-3xl whitespace-pre-line">{rep.summary}</p> : <p className="text-sub">No summary written yet.</p>}
      </Block>

      {order.map((k) => {
        const list = rep.findings.filter((f) => f.verdict === k);
        if (!list.length) return null;
        return (
          <Block key={k} title={VERDICT[k]}>
            <ul className="divide-y divide-line">
              {list.map((f) => (
                <Finding key={f.id} f={f} onPlay={onPlay} />
              ))}
            </ul>
          </Block>
        );
      })}

      {places.length > 0 && (
        <Block title="Places">
          <table className="w-full text-base">
            <tbody>
              {places.map((p) => (
                <tr key={p.name} className="border-t border-line first:border-t-0">
                  <td className="py-2.5 pr-4 font-bold">{p.name}</td>
                  <td className="py-2.5 pr-4 num">{p.seconds > 0 ? minutes(p.seconds) : <span className="tag tag-not_shown">Not shown</span>}</td>
                  <td className="py-2.5 text-sub">
                    {(p.reasons || []).map((r) => 'Reason given: "' + r.text + '"').join(" ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Block>
      )}

      {rep.could_not_check.length > 0 && (
        <Block title="Could not check">
          <ul className="list-disc pl-6 space-y-1 text-base">
            {rep.could_not_check.map((c, i) => (
              <li key={i}>{c.text}</li>
            ))}
          </ul>
        </Block>
      )}

      {rep.other_observations.length > 0 && (
        <Block title="Other observations">
          <ul className="list-disc pl-6 space-y-1 text-base">
            {rep.other_observations.map((o, i) => (
              <li key={i}>
                {o.text} <b className={o.status === "issue" ? "text-high" : "text-ok"}>{o.status === "issue" ? "Issue found" : "Looks fine"}</b>
                {o.note ? ": " + o.note : ""}
              </li>
            ))}
          </ul>
        </Block>
      )}

      {rep.followups.length > 0 && (
        <Block title="Questions for the company">
          <ol className="list-decimal pl-6 space-y-1.5 text-base">
            {rep.followups.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ol>
        </Block>
      )}

      {rep.nothing_unusual.length > 0 && (
        <Block title="Nothing unusual">
          <p className="text-base">{rep.nothing_unusual.length} other checks found nothing unusual: {rep.nothing_unusual.join("; ").toLowerCase()}.</p>
        </Block>
      )}

      <Block title="How this visit was recorded">
        {rec.state === "done" ? (
          <ul className="list-disc pl-6 space-y-1 text-base">
            <li>
              {rec.minutes < 1 ? "Less than a minute" : rec.minutes === 1 ? "1 minute" : rec.minutes + " minutes"} recorded.{" "}
              {rec.consent_at !== null ? "Consent given at " + clock(rec.consent_at) + " in the recording." : rec.consent_confirmed_by_hand ? "Consent confirmed by the analyst." : ""}
            </li>
            <li>
              Faces blurred before saving. {rec.raw_deleted_mb} MB of unblurred video deleted; {rec.kept_mb} MB of blurred clips kept.
            </li>
            <li>{rec.picture_checks} blurred pictures checked by AI with fixed answers. No other AI was used.</li>
            <li>Warning-sign thresholds are starting values, not calibrated on real data.</li>
            {rec.evidence_fingerprint && <li className="break-all">Evidence fingerprint: <span className="num">{rec.evidence_fingerprint}</span></li>}
          </ul>
        ) : rec.state === "deleted" ? (
          <p className="text-base">The recording was deleted because consent was not confirmed. Findings come from the analyst's own ticks.</p>
        ) : (
          <p className="text-base">This visit was not recorded. Findings come from the analyst's own ticks.</p>
        )}
        {rep.fingerprint && (
          <p className="text-base mt-2 break-all">
            Report fingerprint: <span className="num">{rep.fingerprint}</span>
          </p>
        )}
      </Block>
    </div>
  );
}
