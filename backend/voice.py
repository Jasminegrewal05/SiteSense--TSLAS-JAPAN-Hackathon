"""
Voice prints: is this sentence the analyst's voice, or someone else's?

Uses Resemblyzer (optional, needs PyTorch: pip install -r requirements-voice.txt).
Without it, SiteSense still works: the analyst is found by loudness (the mic is on
the analyst) and people on camera by lip movement.

The analyst records a short voice sample once. Only the voice print (256 numbers)
is stored, never the recording. Voice prints of the visited company's people exist
only while a visit is processed and are deleted afterwards.
"""

import hashlib
import json
import threading

import numpy as np
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

import media
import storage
from auth import get_current_user

router = APIRouter(prefix="/api/voice", tags=["voice"])

MIN_SECONDS = 1.5
_encoder = None
_lock = threading.Lock()


def available():
    try:
        import resemblyzer  # noqa: F401
        return True
    except ImportError:
        return False


def _get_encoder():
    global _encoder
    with _lock:
        if _encoder is None:
            from resemblyzer import VoiceEncoder
            _encoder = VoiceEncoder("cpu", verbose=False)
    return _encoder


def embed(wav):
    """Voice print of a piece of 16 kHz audio, or None if too short or not available."""
    if not available() or wav is None or len(wav) < media.SAMPLE_RATE * MIN_SECONDS:
        return None
    from resemblyzer import preprocess_wav
    processed = preprocess_wav(wav, source_sr=media.SAMPLE_RATE)
    if len(processed) < media.SAMPLE_RATE * 1.0:
        return None
    vec = _get_encoder().embed_utterance(processed)
    return [round(float(v), 5) for v in vec]


def similarity(a, b):
    if a is None or b is None:
        return None
    a, b = np.asarray(a, dtype=np.float32), np.asarray(b, dtype=np.float32)
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(np.dot(a, b) / denom) if denom else None


def mean_vector(vectors):
    vectors = [v for v in vectors if v is not None]
    if not vectors:
        return None
    m = np.mean(np.asarray(vectors, dtype=np.float32), axis=0)
    return [round(float(v), 5) for v in m]


# ---------- the analyst's own voice print ----------

def _print_path(email):
    name = hashlib.sha256(email.encode("utf-8")).hexdigest()[:24]
    return storage.DATA_DIR / "voiceprints" / (name + ".json")


def load_print(email):
    """The analyst's voice print is encrypted on disk. An older plain file is still read."""
    p = _print_path(email)
    if not p.exists():
        return None
    raw = p.read_bytes()
    if raw[:1] == b"{":
        return json.loads(raw.decode("utf-8"))
    return json.loads(storage.read_encrypted(p).decode("utf-8"))


def _save_print(email, record):
    storage.write_encrypted(_print_path(email), json.dumps(record).encode("utf-8"))


@router.get("")
def my_voice(user=Depends(get_current_user)):
    p = load_print(user["email"])
    return {
        "has_sample": p is not None,
        "recorded_at": p["recorded_at"] if p else None,
        "has_voice_print": bool(p and p.get("embedding")),
        "voice_matching_installed": available(),
    }


@router.post("")
async def save_my_voice(file: UploadFile = File(...), user=Depends(get_current_user)):
    if not media.ffmpeg_ok():
        raise HTTPException(500, "ffmpeg is not installed on this laptop.")
    content = await file.read(20 * 1024 * 1024)
    tmp = storage.DATA_DIR / "voiceprints" / "tmp_upload"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_bytes(content)
    try:
        wav = media.decode_audio(tmp)
    except RuntimeError:
        raise HTTPException(400, "Could not read that recording. Try again.")
    finally:
        tmp.unlink(missing_ok=True)  # the recording itself is never kept
    if len(wav) < media.SAMPLE_RATE * 4:
        raise HTTPException(400, "The sample is too short. Read the full sentence (about 8 seconds).")
    if media.loudness_db(wav) < -50:
        raise HTTPException(400, "The sample is almost silent. Check the microphone and try again.")
    record = {
        "recorded_at": storage.now_iso(),
        "loudness_db": round(media.loudness_db(wav), 2),
        "embedding": embed(wav),
    }
    _save_print(user["email"], record)
    storage.append_auth_log(user["email"], "voice_sample_saved")
    return my_voice(user)


@router.delete("")
def delete_my_voice(user=Depends(get_current_user)):
    _print_path(user["email"]).unlink(missing_ok=True)
    storage.append_auth_log(user["email"], "voice_sample_deleted")
    return my_voice(user)
