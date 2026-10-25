import { useCallback, useEffect, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import { formatDateTime } from "../../format";
import { ClipPlayer } from "../../components/Clip";
import ReportBody from "../../components/ReportBody";
import { Button, ButtonLink, Loading, Modal, Notice, inputClass } from "../../components/ui";

const STATUS_TEXT = {
  draft: "Draft",
  submitted: "Waiting for approval",
  approved: "Approved and locked",
};

export default function Report() {
  const { visit, reload } = useOutletContext();
  const { user } = useAuth();
  const [rep, setRep] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [summary, setSummary] = useState("");
  const [followups, setFollowups] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [sendBack, setSendBack] = useState(false);
  const [approving, setApproving] = useState(false);
  const [note, setNote] = useState("");
  const [check, setCheck] = useState(null);
  const [clip, setClip] = useState(null);
  const isManager = user.role === "manager";

  const apply = (r) => {
    setRep(r);
    setSummary(r.summary || "");
    setFollowups(r.followups || []);
    setDirty(false);
  };
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const load = useCallback(
    () => api.getReport(visit.visit_id).then((r) => !dirtyRef.current && apply(r)).catch((e) => setError(e.message)),
    [visit.visit_id]
  );
  // Reload when the other person changes the report's status (no manual refresh needed).
  useEffect(() => {
    load();
  }, [load, visit.report_status]);

  async function run(key, fn) {
    setBusy(key);
    setError("");
    try {
      const r = await fn();
      if (r && r.visit) apply(r);
      await reload();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy("");
    }
  }

  if (!rep) return error ? <Notice tone="high">{error}</Notice> : <Loading />;

  if (!rep.built) {
    return (
      <div className="bg-white border border-line rounded-xl px-6 py-14 text-center">
        <h2 className="text-2xl font-bold">No report yet</h2>
        <p className="text-lg text-sub mt-2">The report is made from the findings you keep.</p>
        {!isManager && (
          <ButtonLink to="../findings" size="lg" className="mt-8">
            Go to findings
          </ButtonLink>
        )}
      </div>
    );
  }

  const editable = !isManager && rep.status !== "approved";
  const save = () => run("save", () => api.saveReport(visit.visit_id, summary, followups.filter((f) => f.trim())));

  return (
    <div className="space-y-6">
      <div className="bg-white border border-line rounded-xl px-5 py-4 flex flex-col md:flex-row md:items-center gap-4 md:justify-between">
        <div>
          <p className="text-xl font-bold">{STATUS_TEXT[rep.status]}</p>
          {rep.status === "submitted" && <p className="text-base text-sub">Sent on {formatDateTime(rep.submitted_at)}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={"/visits/" + visit.visit_id + "/report/print"}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center h-12 px-5 rounded-[10px] border border-line-strong bg-white text-base font-bold hover:bg-canvas"
          >
            Download PDF
          </a>
          {!isManager && rep.status === "draft" && (
            <Button
              size="lg"
              busy={busy === "submit"}
              disabled={rep.undecided > 0}
              onClick={async () => {
                if (dirty && !(await save())) return;
                run("submit", () => api.submitReport(visit.visit_id));
              }}
            >
              Send to manager
            </Button>
          )}
          {isManager && rep.status === "submitted" && (
            <>
              <Button size="lg" onClick={() => setApproving(true)}>
                Approve and lock
              </Button>
              <Button size="lg" variant="secondary" onClick={() => setSendBack(true)}>
                Send back
              </Button>
            </>
          )}
          {rep.status === "approved" && (
            <Button
              variant="secondary"
              busy={busy === "verify"}
              onClick={async () => {
                setBusy("verify");
                try {
                  setCheck(await api.verifyReport(visit.visit_id));
                } catch (e) {
                  setError(e.message);
                } finally {
                  setBusy("");
                }
              }}
            >
              Check nothing changed
            </Button>
          )}
        </div>
      </div>

      {rep.approval_note && rep.status === "approved" && (
        <Notice tone="ok">
          <b>Manager's comment:</b> {rep.approval_note}
        </Notice>
      )}
      {rep.review_note && rep.status === "draft" && (
        <Notice tone="high">
          <b>Sent back by your manager:</b> {rep.review_note}
        </Notice>
      )}
      {!isManager && rep.status === "draft" && rep.undecided > 0 && (
        <Notice tone="med">
          Decide on {rep.undecided} more finding{rep.undecided > 1 ? "s" : ""} before sending.{" "}
          <ButtonLink to="../findings" variant="secondary" size="sm" className="ml-2">
            Open findings
          </ButtonLink>
        </Notice>
      )}
      {check && (
        <Notice tone={check.ok ? "ok" : "high"}>
          {check.ok ? "Nothing has changed since the report was approved." : "The report has changed since it was approved."}
        </Notice>
      )}
      {error && <Notice tone="high">{error}</Notice>}

      {editable && (
        <div className="bg-white border border-line rounded-xl p-5 space-y-5">
          <label className="block">
            <span className="block text-lg font-bold mb-1.5">Your summary</span>
            <textarea
              rows={4}
              value={summary}
              maxLength={2000}
              onChange={(e) => {
                setSummary(e.target.value);
                setDirty(true);
              }}
              placeholder="In two or three sentences: what did you find, and what does it mean for the decision?"
              className={inputClass + " h-auto py-3 leading-relaxed"}
            />
          </label>
          <div>
            <span className="block text-lg font-bold mb-1.5">Questions for the company</span>
            <div className="space-y-2">
              {followups.map((q, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    value={q}
                    maxLength={300}
                    onChange={(e) => {
                      setFollowups(followups.map((x, j) => (j === i ? e.target.value : x)));
                      setDirty(true);
                    }}
                    className={inputClass}
                  />
                  <Button
                    variant="quiet"
                    onClick={() => {
                      setFollowups(followups.filter((_, j) => j !== i));
                      setDirty(true);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setFollowups([...followups, ""]);
                  setDirty(true);
                }}
              >
                Add a question
              </Button>
            </div>
          </div>
          {dirty && (
            <div className="flex justify-end">
              <Button busy={busy === "save"} onClick={save}>
                Save changes
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="bg-white border border-line rounded-xl px-6 py-6">
        <ReportBody rep={rep} onPlay={setClip} />
      </div>

      <ClipPlayer visitId={visit.visit_id} clip={clip} starts={rep.piece_starts} onClose={() => setClip(null)} />

      <Modal
        open={sendBack}
        onClose={() => setSendBack(false)}
        title="Send the report back"
        footer={
          <>
            <Button variant="quiet" onClick={() => setSendBack(false)}>
              Cancel
            </Button>
            <Button
              disabled={note.trim().length < 3}
              busy={busy === "back"}
              onClick={async () => {
                if (await run("back", () => api.reviewReport(visit.visit_id, false, note))) {
                  setSendBack(false);
                  setNote("");
                }
              }}
            >
              Send back
            </Button>
          </>
        }
      >
        <p className="text-base text-sub mb-3">What should the analyst change? They see this at the top of the report.</p>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} maxLength={500} className={inputClass + " h-auto py-3"} />
      </Modal>

      <Modal
        open={approving}
        onClose={() => setApproving(false)}
        title="Approve and lock the report"
        footer={
          <>
            <Button variant="quiet" onClick={() => setApproving(false)}>
              Cancel
            </Button>
            <Button
              busy={busy === "approve"}
              onClick={async () => {
                if (await run("approve", () => api.reviewReport(visit.visit_id, true, note))) {
                  setApproving(false);
                  setNote("");
                }
              }}
            >
              Approve and lock
            </Button>
          </>
        }
      >
        <p className="text-base text-sub mb-3">After this, nothing in the report can change. Add a comment (optional).</p>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={500} className={inputClass + " h-auto py-3"} />
      </Modal>
    </div>
  );
}
