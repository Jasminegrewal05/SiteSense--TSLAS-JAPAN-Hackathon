import { useState } from "react";
import { PURPOSES, SECTORS, VISIT_TYPES } from "../constants";
import Icon from "./Icon";
import { Button, Field, Notice, inputClass } from "./ui";

export const EMPTY_VISIT = {
  company: "",
  sector: "manufacturing",
  visit_type: "plant",
  visit_date: "",
  location: "",
  purpose: "investment",
  guided_tour: true,
  people: [],
  notes: "",
};

function Choice({ name, value, options, onChange, disabled }) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup">
      {Object.entries(options).map(([key, label]) => {
        const active = value === key;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(name, key)}
            className={
              "h-9 px-3.5 rounded-md border text-sm transition-colors " +
              (active
                ? "border-ink bg-ink-50 text-ink font-semibold"
                : "border-line-strong bg-white text-text hover:border-sub") +
              (disabled ? " opacity-60 cursor-not-allowed" : "")
            }
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// A new visit must be today or later. A date that is already saved may stay as it is.
function minVisitDate(current) {
  const d = new Date();
  const today = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  return current && current < today ? current : today;
}

export default function VisitForm({ initial, analyst, analystPicker, onSubmit, submitLabel, readOnly = false }) {
  const [form, setForm] = useState({ ...EMPTY_VISIT, ...initial });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function set(name, value) {
    setForm((f) => ({ ...f, [name]: value }));
  }

  function setPerson(i, field, value) {
    setForm((f) => ({
      ...f,
      people: f.people.map((p, idx) => (idx === i ? { ...p, [field]: value } : p)),
    }));
  }

  async function submit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const people = form.people.filter((p) => p.name.trim());
      await onSubmit({ ...form, people });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-8">
      <section className="bg-white border border-line rounded-lg p-5 sm:p-6 space-y-5">
        <h2 className="font-bold">Company and visit</h2>
        <Field label="Company name">
          <input
            required
            minLength={2}
            disabled={readOnly}
            value={form.company}
            onChange={(e) => set("company", e.target.value)}
            className={inputClass}
            placeholder="As written in its filings"
          />
        </Field>
        <Field label="Sector">
          <Choice name="sector" value={form.sector} options={SECTORS} onChange={set} disabled={readOnly} />
        </Field>
        <Field label="What are you visiting?" hint="The checklist only includes checks that make sense at this kind of site.">
          <Choice name="visit_type" value={form.visit_type} options={VISIT_TYPES} onChange={set} disabled={readOnly} />
        </Field>
        <div className="grid sm:grid-cols-2 gap-5">
          <Field label="Visit date">
            <input
              type="date"
              required
              disabled={readOnly}
              value={form.visit_date}
              min={minVisitDate(form.visit_date)}
              onChange={(e) => set("visit_date", e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Location">
            <input
              required
              minLength={2}
              disabled={readOnly}
              value={form.location}
              onChange={(e) => set("location", e.target.value)}
              className={inputClass}
              placeholder="City, state"
            />
          </Field>
        </div>
        <Field label="Purpose of the visit">
          <Choice name="purpose" value={form.purpose} options={PURPOSES} onChange={set} disabled={readOnly} />
        </Field>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            disabled={readOnly}
            checked={form.guided_tour}
            onChange={(e) => set("guided_tour", e.target.checked)}
            className="mt-1 w-4 h-4 accent-ink"
          />
          <span>
            <span className="block text-sm font-semibold">The company will lead the tour</span>
            <span className="block text-xs text-sub">
              Areas on a planned route may be prepared in advance. SiteSense adds a check for an unplanned area.
            </span>
          </span>
        </label>
      </section>

      <section className="bg-white border border-line rounded-lg p-5 sm:p-6 space-y-4">
        <div>
          <h2 className="font-bold">People you expect to meet</h2>
          <p className="text-sm text-sub">Optional. Shown on the phone when you tap "Asking now".</p>
        </div>
        {form.people.map((p, i) => (
          <div key={i} className="flex gap-2 items-start">
            <input
              aria-label="Name"
              disabled={readOnly}
              value={p.name}
              onChange={(e) => setPerson(i, "name", e.target.value)}
              className={inputClass}
              placeholder="Name"
            />
            <input
              aria-label="Role"
              disabled={readOnly}
              value={p.role}
              onChange={(e) => setPerson(i, "role", e.target.value)}
              className={inputClass}
              placeholder="Role, for example CFO"
            />
            {!readOnly && (
              <button
                type="button"
                onClick={() => set("people", form.people.filter((_, idx) => idx !== i))}
                className="h-10 w-10 shrink-0 grid place-items-center rounded-md text-sub hover:text-high hover:bg-high-bg"
                aria-label="Remove person"
              >
                <Icon name="x" size={16} />
              </button>
            )}
          </div>
        ))}
        {!readOnly && form.people.length < 10 && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => set("people", [...form.people, { name: "", role: "" }])}
          >
            <Icon name="plus" size={16} /> Add a person
          </Button>
        )}
      </section>

      <section className="bg-white border border-line rounded-lg p-5 sm:p-6 space-y-5">
        <h2 className="font-bold">Analyst</h2>
        {analystPicker || (
          <div className="text-sm">
            <div className="font-semibold">{analyst?.name || "Not assigned"}</div>
            <div className="text-sub">{analyst?.email}</div>
          </div>
        )}
        <Field label="Notes" hint="Optional.">
          <textarea
            rows={3}
            maxLength={1000}
            disabled={readOnly}
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            className={inputClass + " h-auto py-2"}
          />
        </Field>
      </section>

      {error && <Notice tone="high">{error}</Notice>}
      {!readOnly && (
        <div className="flex justify-end">
          <Button type="submit" busy={busy}>
            {submitLabel}
          </Button>
        </div>
      )}
    </form>
  );
}
