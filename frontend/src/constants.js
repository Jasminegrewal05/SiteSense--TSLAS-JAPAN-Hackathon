export const VISIT_TYPES = {
  plant: "Plant",
  warehouse: "Warehouse",
  office: "Office",
  store: "Store",
};

export const SECTORS = {
  manufacturing: "Manufacturing",
  distribution: "Distribution and logistics",
  retail: "Retail",
  services: "Services",
};

export const PURPOSES = {
  credit: "Credit review",
  investment: "Investment due diligence",
  compliance: "Risk and compliance check",
};

export const AREAS = [
  "Production floor",
  "Warehouse",
  "Dispatch",
  "Store floor",
  "Office",
  "Management questions",
  "General",
];

export const UNITS = {
  crore: "Rs crore",
  lakh: "Rs lakh",
  million: "Rs million",
  rupees: "Rupees",
};

export const KINDS = {
  look_for: "Look for",
  ask: "Ask",
};

export const PRIORITIES = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const VISIT_STATUS = {
  draft: { label: "Draft", tone: "neutral" },
  assigned: { label: "Waiting for analyst", tone: "med" },
  declined: { label: "Declined, reassign", tone: "high" },
  checklist_ready: { label: "Checklist ready", tone: "ink" },
  submitted: { label: "Waiting for approval", tone: "med" },
  approved: { label: "Approved", tone: "ok" },
  locked: { label: "Locked for visit", tone: "ok" },
};

// Status pill once the visit has been recorded (Phase 2)
export const REPORT_STATUS = {
  draft: { label: "Report in progress", tone: "ink" },
  sent_back: { label: "Report sent back", tone: "high" },
  submitted: { label: "Report waiting for approval", tone: "med" },
  approved: { label: "Closed", tone: "ok" },
};

export function visitStatus(status, capture, report) {
  if (report && REPORT_STATUS[report]) return REPORT_STATUS[report];
  if (status === "locked" && capture) {
    if (capture === "reviewed") return { label: "Reviewed", tone: "ok" };
    if (capture === "done") return { label: "Ready to review", tone: "med" };
    if (capture === "recording" || capture === "paused") return { label: "Recording", tone: "high" };
    if (capture === "deleted") return { label: "Recording deleted", tone: "neutral" };
    if (capture === "failed") return { label: "Processing failed", tone: "high" };
    return { label: "Processing", tone: "ink" };
  }
  return VISIT_STATUS[status] || VISIT_STATUS.draft;
}

export const MARK_STATUS = {
  pending: { label: "Not checked", short: "Not checked" },
  ok: { label: "Looks fine", short: "Fine" },
  issue: { label: "Issue found", short: "Issue" },
  not_visible: { label: "Could not see it", short: "Could not see" },
};

export const METHOD_LABELS = {
  excel: "Excel sheet",
  pdf: "Annual report",
  ai: "AI, checked on page",
  excel_ai: "AI found the row, code read the cells",
  analyst: "Entered by you",
};
