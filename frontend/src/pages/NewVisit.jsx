import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../AuthContext";
import Icon from "../components/Icon";
import VisitForm from "../components/VisitForm";
import { Field, Notice, PageHeading, inputClass } from "../components/ui";

export default function NewVisit() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [analysts, setAnalysts] = useState(null);
  const [analystEmail, setAnalystEmail] = useState("");

  useEffect(() => {
    if (user.role === "manager") api.analysts().then((d) => setAnalysts(d.analysts)).catch(() => setAnalysts([]));
  }, [user.role]);

  if (user.role !== "manager") {
    return <Notice tone="ink">Only a manager can create a visit. Ask your manager to assign one to you.</Notice>;
  }

  async function create(data) {
    if (!analystEmail) throw new Error("Pick the analyst who will do this visit.");
    const visit = await api.createVisit({ ...data, analyst_email: analystEmail });
    navigate("/visits/" + visit.visit_id + "/details");
  }

  const picker = (
    <Field label="Assign to analyst" hint="They must accept before they can start.">
      <select required value={analystEmail} onChange={(e) => setAnalystEmail(e.target.value)} className={inputClass}>
        <option value="">{analysts === null ? "Loading..." : "Choose an analyst"}</option>
        {(analysts || []).map((a) => (
          <option key={a.email} value={a.email}>
            {a.name} ({a.email})
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <div className="max-w-3xl">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-sub hover:text-text mb-4">
        <Icon name="back" size={16} /> Visits
      </Link>
      <PageHeading title="New visit" sub="Fill in the visit and assign it to an analyst." />
      <VisitForm analystPicker={picker} onSubmit={create} submitLabel="Create and assign" />
    </div>
  );
}
