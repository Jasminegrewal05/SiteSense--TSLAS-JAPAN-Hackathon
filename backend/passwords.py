"""
Password hashing with PBKDF2-SHA256 (Python standard library, no extra package).
Stored format:  pbkdf2_sha256$<iterations>$<salt hex>$<hash hex>
"""

import hashlib
import hmac
import os

ITERATIONS = 200000


def hash_password(password):
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS)
    return "pbkdf2_sha256$" + str(ITERATIONS) + "$" + salt.hex() + "$" + digest.hex()


def verify_password(password, stored):
    try:
        algo, iterations, salt_hex, hash_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations)
        )
        return hmac.compare_digest(digest.hex(), hash_hex)
    except (ValueError, AttributeError):
        return False


# Used when the email is unknown, so a wrong email takes as long as a wrong password.
DUMMY_HASH = hash_password("not-a-real-password")
