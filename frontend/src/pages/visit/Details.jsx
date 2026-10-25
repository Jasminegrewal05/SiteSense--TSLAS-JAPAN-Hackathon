import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import VisitForm from "../../components/VisitForm";
import { Notice } from "../../components/ui";
import { formatDateTime } from "../../format";

const ACTION_TEXT = {
  visit_created: "Created the visit",
  details_edited: "Edited visit details",
  doc_uploaded: "Uploaded",
  doc_removed: "Removed",
  doc_opened: "Opened",
  numbers_read: "Read numbers from the documents",
  number_edited: "Changed a number",
  numbers_confirmed: "Confirmed the numbers",
  checklist_built: "Built the checklist",
  item_edited: "Edited a checklist item",
  item_added: "Added a checklist item",
  item_removed: "Removed a checklist item",
  visit_accepted: "Accepted the visit",
  visit_declined: "Declined the visit",
  visit_reassigned: "Reassigned the visit",
  checklist_locked: "Locked the checklist",
  checklist_submitted: "Submitted the checklist for approval",
  checklist_approved: "Approved the checklist",
  checklist_sent_back: "Sent the checklist back",
  approval_reset: "Edited after submitting, so approval was reset",
  item_marked: "Marked an item",
  recording_started: "Started recording the visit",
  recording_ended: "Ended the recording",
  privacy_pause_on: "Privacy pause on",
  privacy_pause_off: "Privacy pause off",
  replay_uploaded: "Uploaded a recorded video",
  visit_processed: "Recording processed",
  speakers_named: "Named the speakers",
  consent_confirmed: "Confirmed consent",
  recording_deleted_no_consent: "Deleted the recording (no consent)",
  suggestion_accepted: "Accepted a suggestion for",
  suggestion_dismissed: "Dismissed a suggestion for",
  review_finished: "Finished and locked the review",
  evidence_verified: "Checked the evidence fingerprint",
  legal_hold_on: "Put the visit on legal hold",
  legal_hold_off: "Removed the legal hold",
  places_edited: "Edited the places to see",
  findings_built: "Built the findings",
  finding_kept: "Kept a finding",
  finding_removed: "Removed a finding",
  finding_undone: "Undid a finding decision",
  report_edited: "Edited the report",
  report_submitted: "Sent the report to the manager",
  report_back_to_draft: "Report went back to draft",
  report_sent_back: "Sent the report back",
  report_approved: "Approved and locked the report",
  report_verified: "Checked the report fingerprint",
};

function describe(e) {
  const base = ACTION_TEXT[e.action] || e.action;
  if (e.file) return base + " " + e.file;
  if (e.metric) return base + ": " + e.metric;
  if (e.item) return base + " " + e.item + (e.status ? " as " + e.status.replace("_", " ") : "");
  return base;
}

export default function Details() {
  const { visit, reload } = useOutletContext();
  const { user } = useAuth();
  const [saved, setSaved] = useState(false);
  const [events, setEvents] = useState([]);
  const locked = visit.status === "locked";

  useEffect(() => {
    api.activity(visit.visit_id).then((d) => setEvents(d.events)).catch(() => {});
  }, [visit.visit_id, visit.updated_at]);

  async function save(data) {
    setSaved(false);
    await api.updateVisit(visit.visit_id, data);
    await reload();
    setSaved(true);
  }

  const initial = {
    company: visit.company,
    sector: visit.sector,
    visit_type: visit.visit_type,
    visit_date: visit.visit_date,
    location: visit.location,
    purpose: visit.purpose,
    guided_tour: visit.guided_tour,
    people: visit.people,
    notes: visit.notes,
  };

  return (
    <div className="grid xl:grid-cols-[1fr_280px] gap-8">
      <div className="space-y-4">
        {saved && <Notice tone="ok">Changes saved.</Notice>}
        {visit.progress.checklist === "draft" && !locked && (
          <Notice tone="ink">If you change the visit type or tour setting, rebuild the checklist so it matches.</Notice>
        )}
        <VisitForm
          key={visit.updated_at}
          initial={initial}
          analyst={{ name: visit.analyst_name, email: visit.analyst_email }}
          onSubmit={save}
          submitLabel="Save changes"
          readOnly={locked || user.role !== "manager"}
        />
      </div>

      <aside>
        <h2 className="font-bold mb-3">Activity</h2>
        <ol className="space-y-3 text-sm border-l border-line pl-4">
          {events.slice(0, 25).map((e, i) => (
            <li key={i}>
              <div>{describe(e)}</div>
              <div className="text-xs text-sub num">{formatDateTime(e.time)}</div>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
