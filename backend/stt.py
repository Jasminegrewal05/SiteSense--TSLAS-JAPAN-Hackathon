"""
Speech to text with faster-whisper, on the laptop. No audio leaves the machine.

The model downloads once on first use (about 145 MB for "base") and is cached.
WHISPER_MODEL can be a size ("tiny", "base", "small") or a local folder path.
"""

import threading

import settings

_model = None
_lock = threading.Lock()
_error = None
_loading = False


def available():
    try:
        import faster_whisper  # noqa: F401
        return True
    except ImportError:
        return False


def status():
    if not available():
        return "not installed"
    if _error:
        return "error: " + _error
    if _model is not None:
        return "ready"
    return "loading" if _loading else "not loaded"


def ready():
    return _model is not None


def warm_up():
    """Loads the model in the background when the server starts, so 'ready' really means ready."""
    if not available() or _model is not None:
        return

    def run():
        global _loading
        _loading = True
        try:
            _load()
        except Exception as e:
            print("speech model could not be loaded:", type(e).__name__, e)
        finally:
            _loading = False
    threading.Thread(target=run, name="sitesense-stt-warmup", daemon=True).start()


def _load():
    global _model, _error
    with _lock:
        if _model is None:
            from faster_whisper import WhisperModel
            try:
                _model = WhisperModel(settings.get("WHISPER_MODEL", "small"), device="cpu", compute_type="int8")
                _error = None
            except Exception as e:  # usually: no internet on first download
                _error = type(e).__name__
                raise
    return _model


def prompt_from_topics(words, limit=180):
    """A short hint for the model: the finance words this visit is about, so they are spelled right."""
    seen, out, size = set(), [], 0
    for w in words:
        w = w.strip().lower()
        if w and w not in seen and size + len(w) + 2 <= limit:
            seen.add(w)
            out.append(w)
            size += len(w) + 2
    hint = "Company site visit in English, with some Hindi words like theek hai, haan ji, nahi, lagbhag, shayad."
    return (hint + " Topics: " + ", ".join(out) + ".") if out else hint


def transcribe(wav, prompt=None):
    """wav: 16 kHz mono float32. Returns [{"start", "end", "text"}] in seconds from the start of wav.
    Raises if the model cannot be loaded, so the caller can mark the piece as not transcribed."""
    if wav is None or len(wav) < 16000 * 0.5:
        return []
    if not available():
        raise RuntimeError("speech to text is not installed")
    model = _load()
    language = settings.get("WHISPER_LANGUAGE", "en") or None
    segments, _ = model.transcribe(wav, language=language, vad_filter=True, beam_size=3,
                                   condition_on_previous_text=False, initial_prompt=prompt)
    out = []
    for s in segments:
        text = s.text.strip()
        if not text or _looks_invented(s, text):
            continue
        out.append({"start": round(float(s.start), 2), "end": round(float(s.end), 2), "text": text,
                    # how sure the model was of its words (0 = sure, more negative = less sure)
                    "logprob": round(float(getattr(s, "avg_logprob", 0.0) or 0.0), 3)})
    return out


def _looks_invented(s, text):
    """Speech models sometimes write a sentence where there was only silence or noise.
    Drop it when the model itself was unsure, or the text is one phrase repeated."""
    no_speech = getattr(s, "no_speech_prob", 0.0) or 0.0
    logprob = getattr(s, "avg_logprob", 0.0) or 0.0
    ratio = getattr(s, "compression_ratio", 1.0) or 1.0
    if no_speech > 0.6 and logprob < -0.7:
        return True
    if logprob < -1.2 or ratio > 2.4:
        return True
    parts = [p.strip().lower() for p in text.replace("!", ".").replace("?", ".").split(".") if p.strip()]
    if len(parts) >= 2 and len(set(parts)) == 1 and logprob < -0.5:
        return True  # "I'm too late. I'm too late."
    return False
