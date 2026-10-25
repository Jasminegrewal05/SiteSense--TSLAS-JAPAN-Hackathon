// Every call to the backend goes through here.
// The session cookie is sent automatically because we stay on one origin.

async function request(path, { method = "GET", body, form } = {}) {
  const options = { method, credentials: "same-origin", headers: {} };
  if (form) {
    options.body = form; // browser sets the multipart header itself
  } else if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const res = await fetch("/api" + path, options);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    let message = "Something went wrong (" + res.status + ").";
    if (data && typeof data.detail === "string") {
      message = data.detail;
    } else if (data && Array.isArray(data.detail)) {
      // FastAPI validation errors
      message = data.detail.map((d) => d.msg).join(" ");
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  authConfig: () => request("/auth/config"),
  me: () => request("/auth/me"),
  loginWithPassword: (email, password) =>
    request("/auth/password", { method: "POST", body: { email, password } }),
  loginWithGoogle: (credential) =>
    request("/auth/google", { method: "POST", body: { credential } }),
  logout: () => request("/auth/logout", { method: "POST" }),
  network: () => request("/network"),

  listVisits: () => request("/visits"),
  createVisit: (data) => request("/visits", { method: "POST", body: data }),
  getVisit: (id) => request("/visits/" + id),
  updateVisit: (id, data) => request("/visits/" + id, { method: "PUT", body: data }),
  activity: (id) => request("/visits/" + id + "/activity"),

  analysts: () => request("/visits/analysts"),
  acceptVisit: (id) => request("/visits/" + id + "/accept", { method: "POST" }),
  declineVisit: (id, reason) => request("/visits/" + id + "/decline", { method: "POST", body: { reason } }),
  reassignVisit: (id, analyst_email) =>
    request("/visits/" + id + "/reassign", { method: "POST", body: { analyst_email } }),
  uploadDoc: (id, file, unit = "crore") => {
    const form = new FormData();
    form.append("file", file);
    form.append("unit", unit);
    return request("/visits/" + id + "/docs", { method: "POST", form });
  },
  removeDoc: (id, docId) => request("/visits/" + id + "/docs/" + docId, { method: "DELETE" }),
  docUrl: (id, docId) => "/api/visits/" + id + "/docs/" + docId + "/file",
  templateUrl: "/api/template",

  readNumbers: (id) => request("/visits/" + id + "/extract", { method: "POST" }),
  getMetrics: (id) => request("/visits/" + id + "/metrics"),
  confirmMetrics: (id, metrics) =>
    request("/visits/" + id + "/metrics", { method: "PUT", body: { metrics } }),

  buildChecklist: (id) => request("/visits/" + id + "/checklist/generate", { method: "POST" }),
  getChecklist: (id) => request("/visits/" + id + "/checklist"),
  saveChecklist: (id, items) =>
    request("/visits/" + id + "/checklist", { method: "PUT", body: { items } }),
  savePlaces: (id, places) =>
    request("/visits/" + id + "/checklist/places", { method: "PUT", body: { places } }),
  lockChecklist: (id) => request("/visits/" + id + "/checklist/lock", { method: "POST" }),
  submitChecklist: (id) => request("/visits/" + id + "/checklist/submit", { method: "POST" }),
  reviewChecklist: (id, approve, note = "") =>
    request("/visits/" + id + "/checklist/review", { method: "POST", body: { approve, note } }),
  markItem: (id, itemId, status, note) =>
    request("/visits/" + id + "/checklist/items/" + itemId + "/mark", {
      method: "PUT",
      body: { status, note },
    }),
  getBrief: (id) => request("/visits/" + id + "/brief"),

  // Phase 2: the analyst's own voice sample
  myVoice: () => request("/voice"),
  saveVoice: (blob, ext) => {
    const form = new FormData();
    form.append("file", blob, "voice" + ext);
    return request("/voice", { method: "POST", form });
  },
  deleteVoice: () => request("/voice", { method: "DELETE" }),

  // Phase 2: recording the visit
  captureStatus: (id) => request("/visits/" + id + "/capture"),
  pairCode: (id) => request("/visits/" + id + "/capture/pair-code", { method: "POST" }),
  pairPhone: (code) => request("/auth/pair", { method: "POST", body: { code } }),
  captureStart: (id) => request("/visits/" + id + "/capture/start", { method: "POST" }),
  uploadPiece: (id, piece) => {
    const form = new FormData();
    form.append("file", piece.blob, "piece_" + piece.index + piece.ext);
    form.append("index", String(piece.index));
    form.append("start_ms", String(Math.round(piece.startMs)));
    form.append("end_ms", String(Math.round(piece.endMs)));
    return request("/visits/" + id + "/capture/chunks", { method: "POST", form });
  },
  captureMark: (id, t) => request("/visits/" + id + "/capture/mark", { method: "POST", body: { t } }),
  captureAsking: (id, t, name) => request("/visits/" + id + "/capture/asking", { method: "POST", body: { t, name } }),
  capturePlace: (id, t, place) => request("/visits/" + id + "/capture/place", { method: "POST", body: { t, place } }),
  capturePause: (id, paused, t) =>
    request("/visits/" + id + "/capture/pause", { method: "POST", body: { paused, t } }),
  captureEnd: (id) => request("/visits/" + id + "/capture/end", { method: "POST" }),
  uploadReplay: (id, file) => {
    const form = new FormData();
    form.append("file", file);
    return request("/visits/" + id + "/capture/replay", { method: "POST", form });
  },
  clipUrl: (id, piece) => "/api/visits/" + id + "/capture/clips/" + piece,

  // Phase 2: review after the visit
  getReview: (id) => request("/visits/" + id + "/capture/review"),
  namePeople: (id, names) =>
    request("/visits/" + id + "/capture/review/people", { method: "PUT", body: { names } }),
  consentDecision: (id, action) =>
    request("/visits/" + id + "/capture/review/consent", { method: "POST", body: { action } }),
  decideSuggestion: (id, sid, action) =>
    request("/visits/" + id + "/capture/review/suggestions/" + sid, { method: "POST", body: { action } }),
  fixLine: (id, lineId, text) =>
    request("/visits/" + id + "/capture/review/lines/" + lineId, { method: "PUT", body: { text } }),
  finishReview: (id) => request("/visits/" + id + "/capture/review/finish", { method: "POST" }),
  // Phase 3: after the visit
  buildFindings: (id) => request("/visits/" + id + "/findings/build", { method: "POST" }),
  getFindings: (id) => request("/visits/" + id + "/findings"),
  decideFinding: (id, fid, action, note = "") =>
    request("/visits/" + id + "/findings/" + fid, { method: "POST", body: { action, note } }),
  getReport: (id) => request("/visits/" + id + "/report"),
  saveReport: (id, summary, followups) =>
    request("/visits/" + id + "/report", { method: "PUT", body: { summary, followups } }),
  submitReport: (id) => request("/visits/" + id + "/report/submit", { method: "POST" }),
  reviewReport: (id, approve, note = "") =>
    request("/visits/" + id + "/report/review", { method: "POST", body: { approve, note } }),
  verifyReport: (id) => request("/visits/" + id + "/report/verify"),
  verifyEvidence: (id) => request("/visits/" + id + "/capture/review/verify"),
  setLegalHold: (id, on, reason = "") =>
    request("/visits/" + id + "/legal-hold", { method: "PUT", body: { on, reason } }),
};
