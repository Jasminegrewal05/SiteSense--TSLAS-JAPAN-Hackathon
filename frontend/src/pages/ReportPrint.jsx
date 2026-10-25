import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import ReportBody from "../components/ReportBody";
import { Loading } from "../components/ui";

// A clean page for the browser's "Save as PDF".
export default function ReportPrint() {
  const { visitId } = useParams();
  const [rep, setRep] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.getReport(visitId).then(setRep).catch((e) => setError(e.message));
  }, [visitId]);

  useEffect(() => {
    if (rep) {
      document.title = "SiteSense report - " + rep.visit.company;
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [rep]);

  if (error) return <p className="p-8 text-high">{error}</p>;
  if (!rep) return <Loading />;

  return (
    <div className="bg-white min-h-screen">
      <div className="max-w-3xl mx-auto px-8 py-10 print:p-0">
        <div className="flex items-center justify-between mb-6 print:mb-4">
          <span className="text-xl font-bold text-ink">SiteSense site visit report</span>
          <button onClick={() => window.print()} className="print:hidden h-11 px-4 rounded-lg bg-ink text-white font-bold">
            Save as PDF
          </button>
        </div>
        {rep.status !== "approved" && (
          <p className="mb-4 rounded-lg border-2 border-med px-4 py-2 font-bold text-med">Draft: not approved yet</p>
        )}
        <ReportBody rep={rep} />
      </div>
    </div>
  );
}
