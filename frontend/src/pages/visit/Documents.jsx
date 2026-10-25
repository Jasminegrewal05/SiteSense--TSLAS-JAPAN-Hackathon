import { useRef, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { api } from "../../api";
import { fileSize, formatDateTime } from "../../format";
import Icon from "../../components/Icon";
import { UNITS } from "../../constants";
import { Button, Notice, inputClass } from "../../components/ui";

const TYPE_LABEL = {
  financials_excel: "Financials sheet",
  annual_report: "Annual report",
  other: "Other",
};

export default function Documents() {
  const { visit, reload } = useOutletContext();
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const [uploading, setUploading] = useState([]);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [unit, setUnit] = useState("crore");
  const [reading, setReading] = useState(false);
  const locked = visit.status === "locked";
  const p = visit.progress;

  async function upload(files) {
    setError("");
    const list = Array.from(files);
    setUploading(list.map((f) => f.name));
    for (const file of list) {
      try {
        await api.uploadDoc(visit.visit_id, file, unit);
      } catch (e) {
        setError(file.name + ": " + e.message);
      }
    }
    setUploading([]);
    await reload();
  }

  async function remove(docId) {
    setError("");
    try {
      await api.removeDoc(visit.visit_id, docId);
      await reload();
    } catch (e) {
      setError(e.message);
    }
  }

  async function readNumbers() {
    setError("");
    setReading(true);
    try {
      await api.readNumbers(visit.visit_id);
      await reload();
      navigate("../numbers");
    } catch (e) {
      setError(e.message);
      setReading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold">Documents</h2>
        <p className="text-sub text-sm mt-1 max-w-2xl">
          The company's Excel sheets and annual report, in any layout.
        </p>
      </div>

      {!locked && (
        <label className="flex items-center gap-3 text-sm">
          <span className="font-semibold">Money figures in these files are in</span>
          <select value={unit} onChange={(e) => setUnit(e.target.value)} className={inputClass + " w-40"}>
            {Object.entries(UNITS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <span className="text-sub">Choose before uploading. Converted to Rs crore.</span>
        </label>
      )}

      {!locked && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            upload(e.dataTransfer.files);
          }}
          className={
            "rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors " +
            (dragging ? "border-ink bg-ink-50" : "border-line-strong bg-white")
          }
        >
          <Icon name="upload" size={28} className="mx-auto text-sub" />
          <p className="mt-3 font-semibold">Drop files here</p>
          <p className="text-sm text-sub mt-1">PDF or Excel (.xlsx), up to 15 MB each</p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button variant="secondary" onClick={() => inputRef.current.click()}>
              Choose files
            </Button>
            <a
              href={api.templateUrl}
              className="inline-flex items-center gap-2 h-10 px-4 rounded-md text-sm font-semibold text-ink hover:bg-ink-50"
            >
              <Icon name="download" size={16} /> Download Excel sheet
            </a>
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".pdf,.xlsx"
            className="hidden"
            onChange={(e) => {
              upload(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      )}

      {error && <Notice tone="high">{error}</Notice>}
      {uploading.length > 0 && <Notice tone="ink">Uploading {uploading.join(", ")}...</Notice>}

      {visit.docs.length > 0 && (
        <div className="bg-white border border-line rounded-lg divide-y divide-line">
          {visit.docs.map((d) => (
            <div key={d.doc_id} className="flex items-center gap-4 px-5 py-4">
              <div
                className={
                  "w-10 h-10 rounded-md grid place-items-center text-xs font-bold shrink-0 " +
                  (d.ext === ".pdf" ? "bg-high-bg text-high" : "bg-ok-bg text-ok")
                }
              >
                {d.ext === ".pdf" ? "PDF" : "XLS"}
              </div>
              <div className="min-w-0 flex-1">
                <a
                  href={api.docUrl(visit.visit_id, d.doc_id)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold hover:underline break-all"
                >
                  {d.filename}
                </a>
                <div className="text-xs text-sub num mt-0.5">
                  {TYPE_LABEL[d.doc_type]}, {fileSize(d.size)}, added {formatDateTime(d.uploaded_at)}
                </div>
              </div>
              {!locked && (
                <button
                  onClick={() => remove(d.doc_id)}
                  className="h-9 w-9 grid place-items-center rounded-md text-sub hover:text-high hover:bg-high-bg"
                  aria-label={"Remove " + d.filename}
                >
                  <Icon name="trash" size={17} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-sub">
        <Icon name="lock" size={13} className="inline -mt-0.5 mr-1" />
        Files are encrypted on disk and only visible to you.
      </p>

      {visit.docs.length > 0 && !locked && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-line pt-6">
          <p className="text-sm text-sub">
            {p.numbers_outdated
              ? "Documents changed since the numbers were read. Read them again."
              : p.numbers_read
                ? "Numbers already read. Read again if you added files."
                : "When all files are here, read the numbers."}
          </p>
          <Button onClick={readNumbers} busy={reading}>
            Read numbers
          </Button>
        </div>
      )}
    </div>
  );
}
