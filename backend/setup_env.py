"""
Creates backend/.env from .env.example and fills in fresh secrets.
Run once:  python setup_env.py
It never overwrites an existing .env.
"""

import secrets
from pathlib import Path

from cryptography.fernet import Fernet

here = Path(__file__).resolve().parent
env_path = here / ".env"
example_path = here / ".env.example"

if env_path.exists():
    print(".env already exists. Nothing changed.")
else:
    lines = []
    for line in example_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("SESSION_SECRET="):
            line = "SESSION_SECRET=" + secrets.token_hex(32)
        elif line.startswith("FILE_ENCRYPTION_KEY="):
            line = "FILE_ENCRYPTION_KEY=" + Fernet.generate_key().decode()
        lines.append(line)
    env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("Created .env with a new SESSION_SECRET and FILE_ENCRYPTION_KEY.")
