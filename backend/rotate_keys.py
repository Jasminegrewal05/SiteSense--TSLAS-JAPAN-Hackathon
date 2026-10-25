"""
Rotate the file-encryption key.

  1. python rotate_keys.py --new-key     prints a fresh key
  2. In .env: put the CURRENT FILE_ENCRYPTION_KEY into FILE_ENCRYPTION_KEYS_OLD,
     then paste the new key as FILE_ENCRYPTION_KEY
  3. python rotate_keys.py               re-encrypts every stored file with the new key
  4. Once it reports 0 failures, you can remove the old key from FILE_ENCRYPTION_KEYS_OLD

Safe to stop and run again: files already on the new key are skipped.
"""

import sys

from dotenv import load_dotenv

load_dotenv()

from cryptography.fernet import Fernet  # noqa: E402

import storage  # noqa: E402

if "--new-key" in sys.argv:
    print(Fernet.generate_key().decode())
    sys.exit(0)

changed = skipped = failed = 0
for path in sorted(storage.DATA_DIR.rglob("*")):
    if not path.is_file() or path.suffix == ".tmp":
        continue
    with open(path, "rb") as f:
        if f.read(6) != b"gAAAAA":  # every Fernet token starts like this; plain files do not
            continue
    try:
        if storage.reencrypt_file(path):
            changed += 1
        else:
            skipped += 1
    except Exception as e:  # not an encrypted file, or no key can open it
        failed += 1
        print("could not rotate", path.relative_to(storage.DATA_DIR), "-", type(e).__name__)
print("re-encrypted:", changed, " already current:", skipped, " failed:", failed)
