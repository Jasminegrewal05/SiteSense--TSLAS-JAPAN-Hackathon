"""
Add an email + password account, or reset a password.

    python create_user.py someone@valuecreate.test "Full Name"

The email's domain (or the exact email) must be listed in config/access.json.
"""

import getpass
import sys

from dotenv import load_dotenv

load_dotenv()

import passwords  # noqa: E402
import storage  # noqa: E402
from auth import access_decision  # noqa: E402

if len(sys.argv) < 3:
    print('Usage: python create_user.py <email> "<Full Name>" [analyst|manager]')
    sys.exit(1)

email, name = sys.argv[1].strip().lower(), sys.argv[2].strip()
role = sys.argv[3].strip().lower() if len(sys.argv) > 3 else "analyst"
if role not in ("analyst", "manager"):
    print("Role must be analyst or manager.")
    sys.exit(1)
allowed, _ = access_decision(email)
if not allowed:
    print("Warning: " + email + " is not allowed by config/access.json, so it cannot sign in yet.")

password = getpass.getpass("Password (min 8 characters): ")
if len(password) < 8:
    print("Password too short.")
    sys.exit(1)

storage.ensure_dirs()
users = [u for u in storage.load_users() if u["email"] != email]
users.append({"email": email, "name": name, "password_hash": passwords.hash_password(password),
              "role": role, "created_at": storage.now_iso()})
storage.save_users(users)
print("Saved account for " + email)
