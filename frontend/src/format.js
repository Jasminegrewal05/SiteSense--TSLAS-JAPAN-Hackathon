export function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d)) return value;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d)) return value;
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d)) return value;
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

export function fileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// Formats a metric value for display, by unit
export function formatMetric(value, unit) {
  if (value === null || value === undefined || value === "") return "";
  const v = Number(value);
  if (isNaN(v)) return String(value);
  if (unit === "cr") return "Rs " + v.toLocaleString("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " cr";
  if (unit === "lakh") return "Rs " + v.toFixed(1) + " lakh";
  if (unit === "pct") return trim(v) + "%";
  if (unit === "pts") return trim(v) + " pts";
  if (unit === "days") return Math.round(v) + " days";
  if (unit === "ratio") return v.toFixed(2) + "x";
  if (unit === "count") return Math.round(v).toLocaleString("en-IN");
  return String(v);
}

function trim(v) {
  return Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1);
}

export function changeText(entry) {
  if (!entry || entry.change === null || entry.change === undefined) return "";
  if (entry.unit === "pct" || entry.unit === "pts") {
    const c = entry.change;
    return (c > 0 ? "+" : "") + trim(c) + " pts";
  }
  if (entry.change_pct === null || entry.change_pct === undefined) return "";
  const p = entry.change_pct;
  return (p > 0 ? "+" : "") + trim(p) + "%";
}

// "file.xlsx, sheet Financials, row 9" -> "Excel, row 9"
// "file.pdf, page 4"                    -> "Annual report, p. 4"
export function shortSource(src) {
  if (!src) return "";
  let m = src.match(/\.xlsx, sheet .*?, row (\d+)$/);
  if (m) return "Excel, row " + m[1];
  m = src.match(/\.pdf, page (\d+)$/);
  if (m) return "Annual report, p. " + m[1];
  return src;
}

// Lowercase the first letter for use mid-sentence, but leave acronyms like EBITDA alone.
export function midSentence(text) {
  if (!text) return "";
  if (text.length > 1 && text[1] === text[1].toLowerCase()) {
    return text[0].toLowerCase() + text.slice(1);
  }
  return text;
}
