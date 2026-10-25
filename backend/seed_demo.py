"""
Sets up the demo:
  - two demo analyst accounts on the fictional domain valuecreate.test
  - one finished past visit (Kaveri Logistics) so the home page has history

Run from the backend folder, after setup_env.py:
    python seed_demo.py

Safe to run again: accounts are only created if missing, and the sample
visit is only added if no visit for Kaveri exists yet.
"""

from datetime import date, timedelta

from dotenv import load_dotenv

load_dotenv()

import checklist  # noqa: E402
import docs  # noqa: E402
import extract  # noqa: E402
import passwords  # noqa: E402
import storage  # noqa: E402
import visits  # noqa: E402

DEMO_PASSWORD = "SiteSense@2026"
ACCOUNTS = [
    ("aarav.mehta@valuecreate.test", "Aarav Mehta", "analyst"),
    ("neha.kapoor@valuecreate.test", "Neha Kapoor", "analyst"),
    ("rohan.verma@valuecreate.test", "Rohan Verma", "manager"),
]


def seed_users():
    users = storage.load_users()
    existing = {u["email"] for u in users}
    for email, name, role in ACCOUNTS:
        if email not in existing:
            users.append({
                "email": email,
                "name": name,
                "password_hash": passwords.hash_password(DEMO_PASSWORD),
                "role": role,
                "created_at": storage.now_iso(),
            })
            print("created account", email)
    storage.save_users(users)


def seed_past_visit():
    user = {"email": ACCOUNTS[0][0], "name": ACCOUNTS[0][1], "role": "analyst"}
    manager = {"email": ACCOUNTS[2][0], "name": ACCOUNTS[2][1], "role": "manager"}
    if any(v["company"].startswith("Kaveri") for v in storage.list_visits_for_user(user["email"])):
        print("sample visit already exists")
        return

    data = visits.VisitIn(
        company="Kaveri Logistics Private Limited",
        sector="distribution",
        visit_type="warehouse",
        visit_date=date.today() - timedelta(days=12),
        analyst_email=user["email"],
        location="Bhiwandi, Maharashtra",
        purpose="credit",
        guided_tour=True,
        people=[{"name": "R. Iyer", "role": "Finance head"}, {"name": "S. Patil", "role": "Warehouse manager"}],
        notes="Annual credit review for working capital limit renewal.",
    )
    visit = visits.create_visit(manager, data, user, accepted=True)
    path = storage.DEMO_DIR / "Kaveri_Logistics_Financials_FY26.xlsx"
    docs.add_document(visit, user, path.name, path.read_bytes())
    raw = extract.run_extraction(visit)
    extract.confirm_metrics(visit, user, {k: {"current": m["current"], "previous": m["previous"]}
                                          for k, m in raw["metrics"].items()})
    built = checklist.generate(visit, user)
    checklist.lock(visit, user, skip_approval=True)  # old sample visit

    # Mark a few items as if the visit happened
    marks = ["ok", "issue", "ok", "not_visible"]
    notes = ["", "Most goods waiting at the bays are for two small distributors, not the large customers named in the report.",
             "", "Dispatch register was not shared on the day."]
    for item, status, note in zip(built["items"], marks, notes):
        checklist.mark_item(visit, user, item["id"], status, note)
    print("created sample visit", visit["visit_id"])


if __name__ == "__main__":
    storage.ensure_dirs()
    seed_users()
    seed_past_visit()
    print("\nDemo accounts (password " + DEMO_PASSWORD + "):")
    for email, name, role in ACCOUNTS:
        print("  " + email + "  (" + role + ")")
