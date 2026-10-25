import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { api } from "../../api";
import { METHOD_LABELS } from "../../constants";
import { changeText, formatDateTime, formatMetric, shortSource } from "../../format";
import { Button, ButtonLink, Loading, Notice } from "../../components/ui";

const RATIO_ORDER = [
  "inventory_days",
  "receivable_days",
  "ebitda_margin",
  "debt_to_equity",
  "capex_to_revenue",
  "revenue_per_employee",
];

function toInput(v) {
  return v === null || v === undefined ? "" : String(v);
}

function toNumber(s) {
  const t = String(s).replace(/,/g, "").trim();
  if (t === "") return null;
  const n = Number(t);
  return isNaN(n) ? NaN : n;
}

export default function Numbers() {
  const { visit, reload } = useOutletContext();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [values, setValues] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const locked = visit.status === "locked";

  useEffect(() => {
    api
      .getMetrics(visit.visit_id)
      .then((d) => {
        setData(d);
        // Start from the confirmed numbers if they are newer than the last reading.
        const useConfirmed = d.confirmed && d.raw && d.confirmed.confirmed_at >= d.raw.extracted_at;
        const src = useConfirmed ? d.confirmed.metrics : d.raw ? d.raw.metrics : {};
        const v = {};
        Object.entries(src).forEach(([k, m]) => {
          v[k] = { current: toInput(m.current), previous: toInput(m.previous) };
        });
        setValues(v);
      })
      .catch((e) => setError(e.message));
  }, [visit.visit_id]);

  const dirty = useMemo(() => {
    if (!data || !data.confirmed) return true;
    return Object.entries(values).some(([k, v]) => {
      const c = data.confirmed.metrics[k];
      return toNumber(v.current) !== c.current || toNumber(v.previous) !== c.previous;
    });
  }, [values, data]);

  if (error && !data) return <Notice tone="high">{error}</Notice>;
  if (!data) return <Loading />;

  if (!data.raw) {
    return (
      <div className="bg-white border border-line rounded-lg px-6 py-12 text-center">
        <h2 className="text-lg font-bold">No numbers yet</h2>
        <p className="text-sub mt-1 mb-6">Upload the company's documents, then read the numbers from them.</p>
        <ButtonLink to="../documents">Go to documents</ButtonLink>
      </div>
    );
  }

  const raw = data.raw;
  const confirmedFresh = data.confirmed && !dirty;

  function set(key, field, value) {
    setValues((v) => ({ ...v, [key]: { ...v[key], [field]: value } }));
  }

  async function confirm() {
    setError("");
    const payload = {};
    for (const [k, v] of Object.entries(values)) {
      const cur = toNumber(v.current);
      const prev = toNumber(v.previous);
      if (Number.isNaN(cur) || Number.isNaN(prev)) {
        setError(raw.metrics[k].label + " is not a valid number.");
        return;
      }
      payload[k] = { current: cur, previous: prev };
    }
    setBusy("confirm");
    try {
      const confirmed = await api.confirmMetrics(visit.visit_id, payload);
      setData((d) => ({ ...d, confirmed }));
      await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  async function build() {
    setError("");
    setBusy("build");
    try {
      await api.buildChecklist(visit.visit_id);
      await reload();
      navigate("../checklist");
    } catch (e) {
      setError(e.message);
      setBusy("");
    }
  }

  const keys = Object.keys(raw.metrics);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold">Numbers</h2>
        <p className="text-sub text-sm mt-1 max-w-2xl">
          Check each number against its source. Amounts are in Rs crore.
        </p>
      </div>

      {visit.progress.numbers_outdated && (
        <Notice tone="med">
          Documents changed after these numbers were read. <Link to="../documents" className="underline font-semibold">Read them again</Link>.
        </Notice>
      )}
      {raw.conflicts.length > 0 && !locked && (
        <Notice tone="med">
          {raw.conflicts.length === 1 ? "One number differs" : raw.conflicts.length + " numbers differ"} between your
          documents. Pick the right one below.
        </Notice>
      )}

      <div className="bg-white border border-line rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-sub border-b border-line">
              <tr>
                <th className="px-4 py-3 font-semibold">Item</th>
                <th className="px-4 py-3 font-semibold text-right w-36">This year</th>
                <th className="px-4 py-3 font-semibold text-right w-36">Last year</th>
                <th className="px-4 py-3 font-semibold">Read from</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const m = raw.metrics[k];
                const v = values[k] || { current: "", previous: "" };
                const confirmedEntry = data.confirmed?.metrics[k];
                const missing = m.current === null && m.previous === null;
                const changed = toNumber(v.current) !== m.current || toNumber(v.previous) !== m.previous;
                const others = m.candidates.slice(1);
                return (
                  <tr
                    key={k}
                    className={
                      "border-t border-line align-top " +
                      (m.conflict ? "bg-med-bg/60" : missing ? "bg-high-bg/40" : "")
                    }
                  >
                    <td className="px-4 py-3">
                      <div className="font-semibold">{m.label}</div>
                      {m.conflict && (
                        <div className="mt-2 space-y-1.5">
                          {others.map((c, i) => (
                            <div key={i} className="text-xs text-med">
                              <span title={c.source}>{shortSource(c.source)}</span> says{" "}
                              <span className="num font-semibold">
                                {c.current} / {c.previous}
                              </span>
                              {!locked && (
                                <button
                                  onClick={() =>
                                    setValues((vals) => ({
                                      ...vals,
                                      [k]: { current: toInput(c.current), previous: toInput(c.previous) },
                                    }))
                                  }
                                  className="ml-2 font-semibold underline"
                                >
                                  Use this
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    {["current", "previous"].map((field) => (
                      <td key={field} className="px-4 py-2">
                        <input
                          inputMode="decimal"
                          disabled={locked}
                          value={v[field]}
                          onChange={(e) => set(k, field, e.target.value)}
                          aria-label={m.label + (field === "current" ? " this year" : " last year")}
                          className={
                            "num w-full h-9 rounded-md border px-2.5 text-right bg-white " +
                            "focus:border-ink focus:outline-none focus:ring-2 focus:ring-ink-100 disabled:bg-transparent disabled:border-transparent " +
                            (missing && v[field] === "" ? "border-high/40" : "border-line-strong")
                          }
                          placeholder="-"
                        />
                      </td>
                    ))}
                    <td className="px-4 py-3 text-xs">
                      {missing && !changed ? (
                        <span className="text-high">
                          Not found. Type it in, or leave it empty and checks that need it are skipped.
                        </span>
                      ) : changed ? (
                        <span className="text-ink font-semibold">Changed by you</span>
                      ) : (
                        <>
                          {(() => {
                            const src = (confirmedFresh && confirmedEntry?.source) || m.source;
                            const method = (confirmedFresh && confirmedEntry?.method) || m.method;
                            return (
                              <div className="font-semibold" title={src}>
                                {method === "analyst" ? METHOD_LABELS.analyst : shortSource(src)}
                              </div>
                            );
                          })()}
                          {!m.conflict && others.length > 0 && (
                            <div className="text-ok mt-0.5" title={others.map((o) => o.source).join("; ")}>
                              Matches {others.map((o) => shortSource(o.source).replace("Excel", "Excel sheet")).join(", ")}
                            </div>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer text-sub hover:text-text">How these numbers were read</summary>
        <ul className="mt-2 ml-5 list-disc text-sub space-y-1">
          {raw.log.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
          <li>Read on {formatDateTime(raw.extracted_at)}.</li>
        </ul>
      </details>

      {error && <Notice tone="high">{error}</Notice>}

      {!locked && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-line pt-6">
          <p className="text-sm text-sub">
            {confirmedFresh
              ? "Confirmed on " + formatDateTime(data.confirmed.confirmed_at) + "."
              : "Confirm the numbers to calculate the ratios."}
          </p>
          <Button onClick={confirm} busy={busy === "confirm"} variant={confirmedFresh ? "secondary" : "primary"} disabled={confirmedFresh}>
            {confirmedFresh ? "Numbers confirmed" : "Confirm numbers"}
          </Button>
        </div>
      )}

      {confirmedFresh && (
        <>
          <div>
            <h3 className="font-bold mt-4">Ratios</h3>
            <p className="text-sm text-sub">Worked out from the numbers above.</p>
          </div>
          <div className="bg-white border border-line rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-sub border-b border-line">
                <tr>
                  <th className="px-4 py-3 font-semibold">Ratio</th>
                  <th className="px-4 py-3 font-semibold text-right">Last year</th>
                  <th className="px-4 py-3 font-semibold text-right">This year</th>
                  <th className="px-4 py-3 font-semibold text-right">Change</th>
                </tr>
              </thead>
              <tbody>
                {RATIO_ORDER.map((k) => {
                  const r = data.confirmed.derived[k];
                  return (
                    <tr key={k} className="border-t border-line">
                      <td className="px-4 py-3">{r.label}</td>
                      <td className="px-4 py-3 text-right num text-sub">{formatMetric(r.previous, r.unit) || "-"}</td>
                      <td className="px-4 py-3 text-right num font-semibold">{formatMetric(r.current, r.unit) || "-"}</td>
                      <td className="px-4 py-3 text-right num">{changeText(r) || "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {!locked && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2">
              <p className="text-sm text-sub max-w-lg">
                {visit.progress.checklist
                  ? "Building again replaces the current checklist, including any edits you made to it."
                  : "SiteSense checks these numbers against its warning-sign rules and builds your checklist."}
              </p>
              <Button onClick={build} busy={busy === "build"}>
                {visit.progress.checklist ? "Build checklist again" : "Build checklist"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
