import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import { AREAS, KINDS, MARK_STATUS, PRIORITIES } from "../../constants";
import { formatDateTime, midSentence, shortSource } from "../../format";
import Icon from "../../components/Icon";
import Movement from "../../components/Movement";
import PhoneHandoff from "../../components/PhoneHandoff";
import { Button, ButtonLink, Loading, Modal, Notice, Pill, inputClass } from "../../components/ui";

const SEVERITY = {
  high: { label: "High", bar: "bg-high", tone: "high" },
  medium: { label: "Medium", bar: "bg-med", tone: "med" },
  low: { label: "Low", bar: "bg-nv", tone: "neutral" },
};

const MARK_TONE = { pending: "neutral", ok: "ok", issue: "high", not_visible: "neutral" };

function SignalList({ checklist }) {
  const { signals, not_triggered, skipped, rules_checked } = checklist;
  return (
    <section>
      <div className="flex items-baseline justify-between gap-4 mb-3">
        <h2 className="text-lg font-bold">Warning signs in the numbers</h2>
        <span className="text-sm text-sub num">
          {signals.length} of {rules_checked} checks flagged
        </span>
      </div>
      {signals.length === 0 ? (
        <Notice tone="ok">None of the {rules_checked} checks found anything unusual. The checklist has general site checks only.</Notice>
      ) : (
        <div className="bg-white border border-line rounded-lg divide-y divide-line overflow-hidden">
          {signals.map((s) => {
            const sev = SEVERITY[s.severity];
            return (
              <div key={s.id} className="relative pl-5 pr-5 py-4">
                <span className={"absolute left-0 top-0 bottom-0 w-1 " + sev.bar} aria-hidden="true" />
                <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-6">
                  <div className="md:w-64 shrink-0">
                    <div className="font-semibold">{s.signal}</div>
                    <Pill tone={sev.tone} className="mt-1">
                      {sev.label}
                    </Pill>
                  </div>
                  <div className="flex flex-wrap gap-x-8 gap-y-3 flex-1">
                    {s.figures.map((f) => (
                      <Movement key={f.label} label={f.label} previous={f.previous} current={f.current} />
                    ))}
                  </div>
                </div>
                <div className="text-xs text-sub mt-2 md:ml-[17.5rem]">From {s.sources.map(shortSource).join("; ")}</div>
              </div>
            );
          })}
        </div>
      )}
      {(not_triggered.length > 0 || skipped.length > 0) && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-sub hover:text-text">What else was checked</summary>
          <div className="mt-2 space-y-2 text-sub">
            {not_triggered.length > 0 && (
              <p>
                <span className="font-semibold text-text">Nothing unusual: </span>
                {not_triggered.map((r) => r.signal.toLowerCase()).join("; ")}.
              </p>
            )}
            {skipped.length > 0 && (
              <p>
                <span className="font-semibold text-text">Could not check, numbers missing: </span>
                {skipped.map((r) => r.signal.toLowerCase() + " (needs " + r.needs.join(", ").toLowerCase() + ")").join("; ")}.
              </p>
            )}
          </div>
        </details>
      )}
    </section>
  );
}

function PlacesEditor({ visit, checklist, editable, onSaved }) {
  const [places, setPlaces] = useState(checklist.places || []);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);

  function change(list) {
    setPlaces(list);
    setDirty(true);
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const c = await api.savePlaces(visit.visit_id, places);
      setPlaces(c.places);
      setDirty(false);
      onSaved(c);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 className="text-xl font-bold">Places to see</h2>
      <p className="text-base text-sub mt-1 mb-3">
        The report shows how long you spent in each one, and which ones the company did not show you.
      </p>
      <ul className="bg-white border border-line rounded-xl divide-y divide-line">
        {places.map((p, i) => (
          <li key={i} className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
            <span className="font-bold text-lg sm:w-56 shrink-0">{p.name}</span>
            {editable ? (
              <input
                value={p.note}
                onChange={(e) => change(places.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))}
                placeholder="Why it matters (optional)"
                maxLength={200}
                className={inputClass + " flex-1"}
              />
            ) : (
              <span className="text-sub flex-1">{p.note}</span>
            )}
            {editable && (
              <Button variant="quiet" size="sm" onClick={() => change(places.filter((_, j) => j !== i))}>
                Remove
              </Button>
            )}
          </li>
        ))}
        {places.length === 0 && <li className="px-5 py-4 text-sub">No places yet.</li>}
      </ul>
      {editable && (
        <div className="mt-3 flex flex-col sm:flex-row gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Add a place, for example: Chakan warehouse"
            maxLength={80}
            className={inputClass + " sm:max-w-md"}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim().length > 1) {
                change([...places, { name: name.trim(), note: "" }]);
                setName("");
              }
            }}
          />
          <Button
            variant="secondary"
            disabled={name.trim().length < 2}
            onClick={() => {
              change([...places, { name: name.trim(), note: "" }]);
              setName("");
            }}
          >
            Add place
          </Button>
          {dirty && (
            <Button onClick={save} busy={busy}>
              Save places
            </Button>
          )}
        </div>
      )}
      {error && <Notice tone="high" className="mt-3">{error}</Notice>}
    </section>
  );
}

function ItemRow({ item, editable, locked, onChange, onRemove }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);

  return (
    <li className="px-5 py-4 flex gap-4">
      <div className="w-16 shrink-0 pt-0.5">
        <span className={"text-xs font-semibold " + (item.kind === "ask" ? "text-ink" : "text-sub")}>{KINDS[item.kind]}</span>
        <div className="text-[11px] text-sub num mt-0.5">{item.id}</div>
      </div>
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="space-y-2">
            <textarea
              rows={3}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className={inputClass + " h-auto py-2"}
              autoFocus
            />
            <div className="flex gap-2">
              <Button
                className="h-8 px-3"
                disabled={draft.trim().length < 3}
                onClick={() => {
                  onChange({ ...item, text: draft.trim() });
                  setEditing(false);
                }}
              >
                Done
              </Button>
              <Button
                variant="quiet"
                className="h-8 px-3"
                onClick={() => {
                  setDraft(item.text);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <p className="leading-relaxed">{item.text}</p>
        )}
        {item.why && (
          <p className="text-xs text-sub mt-1.5">
            Because {midSentence(item.why)}
            {item.sources.length > 0 && <span> ({item.sources.map(shortSource).join("; ")})</span>}
          </p>
        )}
        {item.origin === "analyst" && <p className="text-xs text-ink mt-1.5">Added by you</p>}
        {item.origin === "baseline" && !item.why && <p className="text-xs text-sub mt-1.5">Standard check for this visit type</p>}
        {locked && item.status !== "pending" && (
          <div className="mt-2 text-xs">
            <Pill tone={MARK_TONE[item.status]}>{MARK_STATUS[item.status].label}</Pill>
            {item.note && <span className="ml-2 text-text">{item.note}</span>}
            <span className="ml-2 text-sub">
              {item.marked_by === "manual" ? "marked by hand" : "accepted suggestion"}, {formatDateTime(item.marked_at)}
            </span>
          </div>
        )}
      </div>
      <div className="shrink-0 flex flex-col items-end gap-2">
        {editable ? (
          <>
            <select
              value={item.priority}
              onChange={(e) => onChange({ ...item, priority: e.target.value })}
              className="h-8 rounded-md border border-line-strong bg-white px-2 text-xs"
              aria-label="Priority"
            >
              {Object.entries(PRIORITIES).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <div className="flex">
              <button
                onClick={() => setEditing(true)}
                className="h-8 w-8 grid place-items-center rounded-md text-sub hover:text-text hover:bg-canvas"
                aria-label="Edit item"
              >
                <Icon name="edit" size={16} />
              </button>
              <button
                onClick={onRemove}
                className="h-8 w-8 grid place-items-center rounded-md text-sub hover:text-high hover:bg-high-bg"
                aria-label="Remove item"
              >
                <Icon name="trash" size={16} />
              </button>
            </div>
          </>
        ) : (
          <span className={"text-xs font-semibold " + (item.priority === "high" ? "text-high" : item.priority === "medium" ? "text-med" : "text-sub")}>
            {PRIORITIES[item.priority]}
          </span>
        )}
      </div>
    </li>
  );
}

function AddItem({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ area: "Management questions", kind: "ask", text: "", priority: "medium" });
  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Icon name="plus" size={16} /> Add your own item
      </Button>
    );
  }
  return (
    <div className="bg-white border border-line rounded-lg p-5 space-y-3">
      <h3 className="font-bold">New item</h3>
      <div className="grid sm:grid-cols-3 gap-3">
        <select value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} className={inputClass} aria-label="Area">
          {AREAS.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className={inputClass} aria-label="Type">
          {Object.entries(KINDS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className={inputClass} aria-label="Priority">
          {Object.entries(PRIORITIES).map(([k, l]) => (
            <option key={k} value={k}>
              {l} priority
            </option>
          ))}
        </select>
      </div>
      <textarea
        rows={2}
        value={form.text}
        onChange={(e) => setForm({ ...form, text: e.target.value })}
        className={inputClass + " h-auto py-2"}
        placeholder="What should you look for or ask?"
      />
      <div className="flex gap-2">
        <Button
          disabled={form.text.trim().length < 3}
          onClick={() => {
            onAdd({ ...form, text: form.text.trim() });
            setForm({ ...form, text: "" });
            setOpen(false);
          }}
        >
          Add item
        </Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export default function Checklist() {
  const { visit, reload } = useOutletContext();
  const { user } = useAuth();
  const isManager = user.role === "manager";
  const [sendBack, setSendBack] = useState(false);
  const [approving, setApproving] = useState(false);
  const [note, setNote] = useState("");
  const [checklist, setChecklist] = useState(null);
  const [items, setItems] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [confirmLock, setConfirmLock] = useState(false);

  useEffect(() => {
    if (!visit.progress.checklist) {
      setChecklist(false);
      return;
    }
    api
      .getChecklist(visit.visit_id)
      .then((c) => {
        setChecklist(c);
        setItems(c.items);
        setDirty(false);
      })
      .catch((e) => setError(e.message));
  }, [visit.visit_id, visit.progress.checklist]);

  const grouped = useMemo(() => {
    return AREAS.map((area) => ({ area, items: items.filter((i) => i.area === area) })).filter((g) => g.items.length);
  }, [items]);

  if (error && !checklist) return <Notice tone="high">{error}</Notice>;
  if (checklist === null) return <Loading />;
  if (checklist === false) {
    return (
      <div className="bg-white border border-line rounded-lg px-6 py-12 text-center">
        <h2 className="text-lg font-bold">No checklist yet</h2>
        <p className="text-sub mt-1 mb-6">Confirm the numbers, then build the checklist from them.</p>
        <ButtonLink to="../numbers">Go to numbers</ButtonLink>
      </div>
    );
  }

  const locked = checklist.status === "locked";
  const editable = !locked && !isManager;
  const status = checklist.status; // draft, submitted, approved, locked

  function update(next) {
    setItems((list) => list.map((i) => (i.id === next.id ? next : i)));
    setDirty(true);
  }

  function remove(id) {
    setItems((list) => list.filter((i) => i.id !== id));
    setDirty(true);
  }

  function add(form) {
    // Temporary id; the backend assigns the real one on save.
    setItems((list) => [...list, { ...form, id: "new-" + Date.now(), origin: "analyst", sources: [], status: "pending" }]);
    setDirty(true);
  }

  async function save() {
    setError("");
    setBusy("save");
    try {
      const payload = items.map((i) => ({
        id: i.id.startsWith("new-") ? null : i.id,
        area: i.area,
        kind: i.kind,
        text: i.text,
        priority: i.priority,
      }));
      const c = await api.saveChecklist(visit.visit_id, payload);
      setChecklist(c);
      setItems(c.items);
      setDirty(false);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy("");
    }
  }

  async function submitForApproval() {
    setError("");
    setBusy("submit");
    try {
      if (dirty && !(await save())) return;
      const c = await api.submitChecklist(visit.visit_id);
      setChecklist(c);
      await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  async function reviewIt(approve) {
    setError("");
    setBusy(approve ? "approve" : "back");
    try {
      const c = await api.reviewChecklist(visit.visit_id, approve, note);
      setChecklist(c);
      setSendBack(false);
      setApproving(false);
      setNote("");
      await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  async function lock() {
    setError("");
    setBusy("lock");
    try {
      if (dirty && !(await save())) return;
      const c = await api.lockChecklist(visit.visit_id);
      setChecklist(c);
      setItems(c.items);
      setConfirmLock(false);
      await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  const coverage = visit.progress.coverage;
  const notChecked = items.filter((i) => i.status === "pending" || i.status === "not_visible");

  return (
    <div className="space-y-8 pb-24">
      {status === "draft" && checklist.review_note && !isManager && (
        <Notice tone="high">
          <b>Sent back by your manager:</b> {checklist.review_note}
        </Notice>
      )}
      {status !== "draft" && checklist.approval_note && (
        <Notice tone="ok">
          <b>Manager's comment:</b> {checklist.approval_note}
        </Notice>
      )}
      {visit.progress.checklist_outdated && (
        <Notice tone="med">The numbers or visit details changed after this checklist was built. Build it again from the Numbers step.</Notice>
      )}

      {locked && (
        <>
          <Notice tone="ok">Locked on {formatDateTime(checklist.locked_at)}.</Notice>
          {!isManager && (
            <PhoneHandoff path={"/visits/" + visit.visit_id + "/capture"} visitId={visit.visit_id} title="Scan with the recording phone">
              No sign-in on the phone. Same wifi as this laptop.
            </PhoneHandoff>
          )}
        </>
      )}

      <SignalList checklist={checklist} />

      <section>
        <div className="flex items-baseline justify-between gap-4 mb-3">
          <h2 className="text-lg font-bold">Checklist</h2>
          <span className="text-sm text-sub num">
            {locked && coverage
              ? coverage.checked + " of " + coverage.total + " checked"
              : items.length + " items for a " + checklist.visit_type + " visit"}
          </span>
        </div>
        <div className="space-y-5">
          {grouped.map((g) => (
            <div key={g.area} className="bg-white border border-line rounded-lg overflow-hidden">
              <h3 className="px-5 py-3 border-b border-line bg-canvas/60 font-semibold text-sm">
                {g.area} <span className="text-sub font-normal num">({g.items.length})</span>
              </h3>
              <ul className="divide-y divide-line">
                {g.items.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    editable={editable}
                    locked={locked}
                    onChange={update}
                    onRemove={() => remove(item.id)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
        {editable && (
          <div className="mt-5">
            <AddItem onAdd={add} />
          </div>
        )}
      </section>

      <PlacesEditor
        visit={visit}
        checklist={checklist}
        editable={editable}
        onSaved={(c) => {
          setChecklist(c);
          reload();
        }}
      />

      {locked && notChecked.length > 0 && (
        <section>
          <h2 className="text-lg font-bold mb-1">Not checked</h2>
          <p className="text-sm text-sub mb-3">These go into the report as not checked.</p>
          <ul className="bg-white border border-line rounded-lg divide-y divide-line text-sm">
            {notChecked.map((i) => (
              <li key={i.id} className="px-5 py-3 flex gap-3">
                <span className="num text-sub w-14 shrink-0">{i.id}</span>
                <span className="flex-1">{i.text}</span>
                <span className="text-xs text-sub shrink-0">{MARK_STATUS[i.status].short}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <Notice tone="high">{error}</Notice>}



      {editable && (
        <div className="fixed bottom-0 inset-x-0 z-20 bg-white/95 backdrop-blur border-t border-line">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-end gap-3">
            <span className="text-sm text-sub mr-auto">{dirty ? "You have unsaved changes." : "All changes saved."}</span>
            <Button variant="secondary" onClick={save} disabled={!dirty} busy={busy === "save"}>
              Save changes
            </Button>
            {status === "draft" && (
              <Button onClick={submitForApproval} busy={busy === "submit"}>
                Submit for approval
              </Button>
            )}
            {status === "submitted" && <span className="text-sm font-semibold">Waiting for a manager to approve</span>}
            {status === "approved" && (
              <Button onClick={() => setConfirmLock(true)} disabled={dirty}>
                <Icon name="lock" size={16} /> Lock for visit
              </Button>
            )}
          </div>
        </div>
      )}

      {isManager && status === "submitted" && (
        <div className="fixed bottom-0 inset-x-0 z-20 bg-white/95 backdrop-blur border-t border-line">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-end gap-3">
            <span className="text-base font-bold mr-auto">Read the checklist, then decide.</span>
            <Button variant="secondary" size="lg" onClick={() => setSendBack(true)}>
              Send back
            </Button>
            <Button size="lg" onClick={() => setApproving(true)}>
              Approve
            </Button>
          </div>
        </div>
      )}

      <Modal
        open={sendBack}
        onClose={() => setSendBack(false)}
        title="Send back to the analyst"
        footer={
          <>
            <Button variant="quiet" onClick={() => setSendBack(false)}>
              Cancel
            </Button>
            <Button onClick={() => reviewIt(false)} busy={busy === "back"} disabled={!note.trim()}>
              Send back
            </Button>
          </>
        }
      >
        <p className="text-base text-sub mb-3">What should the analyst change? They see this at the top of the checklist.</p>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} maxLength={500} className={inputClass + " h-auto py-3"} placeholder="For example: add a question on the new term loan." />
      </Modal>

      <Modal
        open={approving}
        onClose={() => setApproving(false)}
        title="Approve the checklist"
        footer={
          <>
            <Button variant="quiet" onClick={() => setApproving(false)}>
              Cancel
            </Button>
            <Button onClick={() => reviewIt(true)} busy={busy === "approve"}>
              Approve
            </Button>
          </>
        }
      >
        <p className="text-base text-sub mb-3">Add a comment for the analyst (optional).</p>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={500} className={inputClass + " h-auto py-3"} placeholder="For example: spend extra time in the warehouse." />
      </Modal>

      <Modal
        open={confirmLock}
        onClose={() => setConfirmLock(false)}
        title="Lock this checklist?"
        footer={
          <>
            <Button variant="quiet" onClick={() => setConfirmLock(false)}>
              Keep editing
            </Button>
            <Button onClick={lock} busy={busy === "lock"}>
              Lock for visit
            </Button>
          </>
        }
      >
        <p className="text-sm text-sub leading-relaxed">
          After locking, the items, numbers and documents can't be changed. You can still tick items during the visit.
        </p>
      </Modal>
    </div>
  );
}
