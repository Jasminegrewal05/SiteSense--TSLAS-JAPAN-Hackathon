"""
The background worker. Each 10-second piece from the phone goes through:

  1. decrypt into a temporary folder
  2. sound     -> speech to text, loudness, voice prints
  3. video     -> faces followed frame to frame, mouth movement (who on camera is speaking)
  4. blur      -> every face blurred ONCE (boxes carried across frames)
  5. pictures  -> one sharp, new-looking BLURRED frame every 5 s; checked again for faces,
                  and only then sent to the vision AI
  6. clip      -> the same blurred frames saved encrypted as a "pending" clip (with sound)
  7. the unblurred piece and the temporary folder are DELETED, and both deletions are logged

Unblurred video exists only in memory and in the temporary folder for those seconds.
If speech to text fails, the piece is marked "speech failed": the blurred clip keeps the
sound, so speech to text is tried again after the visit, and the clip is never thrown away
unanalysed. After the visit ends, analysis.finalize() decides which blurred clips are kept.
"""

import queue
import tempfile
import threading
import time
import traceback
from pathlib import Path

import numpy as np

import capture_store as cs
import media
import settings
import stt
import vision
import voice
from checklist import AREAS

CLIP_FPS = 10
ANALYSIS_FPS = 10         # mouth movement is checked on every frame
WIDTH = 480
PICTURE_EVERY = 5          # seconds
MIN_SHARPNESS = 40.0
MIN_CHANGE = 6.0           # skip pictures that look the same as the last one sent

JOBS = queue.Queue()
_started = False


def ai_budget():
    return settings.get_int("CAPTURE_AI_BUDGET", 80)


def enqueue_chunk(visit_id, index):
    JOBS.put(("chunk", visit_id, index))


def enqueue_finalize(visit_id, delay=0):
    if delay:
        # Wait without blocking the worker, so pieces still in the queue keep being processed.
        threading.Timer(delay, lambda: JOBS.put(("finalize", visit_id, None))).start()
    else:
        JOBS.put(("finalize", visit_id, None))


def visit_prompt(visit_id):
    """Topic words from this visit's checklist, given to speech to text as a hint."""
    import storage
    cl = storage.read_json(storage.visit_path(visit_id, "checklist.json")) or {"items": []}
    words = [w for it in cl["items"] for w in (it.get("topics") or [])]
    return stt.prompt_from_topics(words)


def start_worker():
    global _started
    if _started:
        return
    _started = True
    stt.warm_up()
    threading.Thread(target=_loop, name="sitesense-worker", daemon=True).start()
    _recover()


def _loop():
    import analysis  # imported here to avoid a circular import
    while True:
        kind, visit_id, index = JOBS.get()
        try:
            if kind == "chunk":
                process_chunk(visit_id, index)
            else:
                analysis.finalize(visit_id)
        except Exception as e:
            traceback.print_exc()
            message = type(e).__name__ + ": " + str(e)[:200]
            if kind == "chunk":
                def fail(s, message=message):
                    c = s["chunks"][str(index)]
                    c["status"] = "failed"
                    c["error"] = message
                cs.update_session(visit_id, fail)
            else:
                cs.update_session(visit_id, lambda s, message=message: s.update(state="failed", error=message))
        finally:
            JOBS.task_done()


def _recover():
    """After a restart: process pieces that arrived but were not finished."""
    import storage
    if not storage.VISITS_DIR.exists():
        return
    for vdir in storage.VISITS_DIR.iterdir():
        # A crash in the middle of a piece can leave a temporary folder with DECRYPTED video.
        # Delete every one at start-up, and log it.
        cap = vdir / "capture"
        if cap.exists():
            for tmp in cap.glob("ss_*"):
                if tmp.is_dir():
                    cs.delete_dir(vdir.name, tmp, "temporary folder left by a crash or restart")
        s = storage.read_json(vdir / "capture" / "session.json")
        if not s:
            continue
        for key, c in sorted(s.get("chunks", {}).items(), key=lambda kv: int(kv[0])):
            if c["status"] in ("queued", "processing"):
                enqueue_chunk(vdir.name, int(key))
        if s.get("state") in ("ending", "processing"):
            enqueue_finalize(vdir.name)


def _set_chunk(visit_id, index, **fields):
    def apply(s):
        c = s["chunks"][str(index)]
        steps = fields.pop("steps", None)
        c.update(fields)
        if steps:
            c.setdefault("steps", {}).update(steps)
    cs.update_session(visit_id, apply)


def _live_labels(segment, analyst_print):
    """Quick first-pass label shown during the visit. The final one is decided after the visit."""
    lip = segment.get("lip") or {}
    sim = voice.similarity(segment.get("embedding"), (analyst_print or {}).get("embedding"))
    if segment["end"] - segment["start"] < 1.5:
        return "Not sure yet"
    if sim is not None and sim >= 0.78:
        return "Analyst"
    if lip.get("track"):
        return "Person on camera"
    return "Not sure yet"


def process_chunk(visit_id, index):
    session = cs.load_session(visit_id)
    chunk = session["chunks"][str(index)]
    if chunk["status"] == "done":
        return
    _set_chunk(visit_id, index, status="processing")
    start_s = chunk["start_ms"] / 1000.0
    raw_enc = cs.path(visit_id, "raw/" + chunk["file"])
    tmp = Path(tempfile.mkdtemp(prefix="ss_", dir=cs.cap_dir(visit_id)))
    import storage
    try:
        src = tmp / ("piece" + chunk["ext"])
        src.write_bytes(storage.read_encrypted(raw_enc))

        # ---- sound ----
        wav = media.decode_audio(src)
        speech_failed = False
        try:
            segments = stt.transcribe(wav, visit_prompt(visit_id))
            speech_step = "done"
        except Exception as e:
            # e.g. the speech model is missing. The blurred clip keeps the sound, so this piece
            # is transcribed again after the visit and is never deleted unanalysed.
            print("speech to text failed:", type(e).__name__, e)
            segments, speech_step, speech_failed = [], "failed, retried after the visit", True
        _set_chunk(visit_id, index, steps={"transcript": speech_step}, speech_failed=speech_failed)

        # ---- video ----
        frames, w, h = media.decode_frames(src, CLIP_FPS, WIDTH)
        step = CLIP_FPS // ANALYSIS_FPS
        analysis_frames = frames[::step]
        tracks = media.face_tracks(analysis_frames)
        env = media.envelope(wav, ANALYSIS_FPS, len(analysis_frames))

        analyst = voice.load_print(session["analyst_email"])
        for seg in segments:
            a0, a1 = int(seg["start"] * media.SAMPLE_RATE), int(seg["end"] * media.SAMPLE_RATE)
            part = wav[a0:a1]
            seg["loudness_db"] = round(media.loudness_db(part), 2)
            seg["embedding"] = voice.embed(part)
            seg["lip"] = media.speaking_track(tracks, env, ANALYSIS_FPS, seg["start"], seg["end"])
        # A "sentence" heard in near silence is noise the speech model turned into words: drop it.
        segments = [seg for seg in segments if seg["loudness_db"] > -50]
        _set_chunk(visit_id, index, steps={"faces": "done" if media.finder().ok else "no model"},
                   faces_seen=len(tracks))

        # ---- blur every face, once; the clip and the AI pictures both use these frames ----
        blurred, _ = media.blurred_frames(frames)

        # ---- pictures for the AI (blurred, and checked again for faces) ----
        notes = _picture_checks(visit_id, index, start_s, blurred, session)
        _set_chunk(visit_id, index, steps={"pictures": notes})

        # ---- blurred clip ----
        clip_tmp = tmp / "clip.mp4"
        clip_bytes = media.encode_clip(blurred, CLIP_FPS, src, clip_tmp) if blurred else 0
        if clip_bytes:
            storage.write_encrypted(cs.path(visit_id, "pending/" + _clip_name(index)), clip_tmp.read_bytes())
        _set_chunk(visit_id, index, steps={"blurred": "done" if clip_bytes else "no video"},
                   clip_bytes=clip_bytes)

        # ---- working data for the after-visit analysis (voice prints stay encrypted) ----
        cs.write_secret_json(visit_id, "analysis/piece_" + str(index).zfill(4) + ".json", {
            "index": index,
            "start": start_s,
            "segments": segments,
            "tracks": [{"id": t["id"],
                        "first": t["boxes"][min(t["boxes"])], "last": t["boxes"][max(t["boxes"])],
                        "first_frame": min(t["boxes"]), "last_frame": max(t["boxes"]),
                        "frames": len(t["boxes"])} for t in tracks],
            "frames": len(analysis_frames),
        })

        live = [{
            "time": round(start_s + s["start"], 2), "end": round(start_s + s["end"], 2),
            "text": s["text"], "label": _live_labels(s, analyst), "piece": index,
        } for s in segments]

        with cs.lock_for(visit_id):
            lines = cs.read(visit_id, "transcript_live.json", [])
            lines.extend(live)
            lines.sort(key=lambda l: l["time"])
            cs.write(visit_id, "transcript_live.json", lines)
    finally:
        # ---- the unblurred piece is deleted, always ----
        freed = cs.delete_file(visit_id, raw_enc, "unblurred piece " + str(index))
        cs.delete_dir(visit_id, tmp, "temporary work folder for piece " + str(index))

    def done(s):
        c = s["chunks"][str(index)]
        c["status"] = "done"
        c["processed_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        c.setdefault("steps", {})["raw_deleted"] = "done"
        s["meters"]["raw_deleted_bytes"] += freed
        s["meters"]["pending_bytes"] += c.get("clip_bytes", 0)
    cs.update_session(visit_id, done)


def _clip_name(index):
    return "piece_" + str(index).zfill(4) + ".mp4.enc"


def _picture_checks(visit_id, index, start_s, frames, session):
    """
    Up to 2 pictures per piece, plus one at each mark. `frames` are ALREADY BLURRED.
    Before a picture leaves the laptop, the face finder looks at it once more; if it still
    sees a face, that spot is blurred again, and if a face is still found, the picture is skipped.
    Returns a short status word.
    """
    if not frames:
        return "no video"
    if not vision.configured():
        return "skipped (no AI key)"
    if not media.finder().ok:
        return "skipped (no face finder, so pictures are never sent)"

    import storage
    checklist = storage.read_json(storage.visit_path(visit_id, "checklist.json"))
    questions = vision.questions_for(checklist["items"])
    if not questions:
        return "no questions"

    end_s = start_s + len(frames) / float(CLIP_FPS)
    mark_times = [m["t"] for m in session.get("marks", []) if start_s <= m["t"] < end_s]
    wanted = [(t, False) for t in range(0, int(len(frames) / CLIP_FPS), PICTURE_EVERY)]
    wanted += [(t - start_s, True) for t in mark_times]

    sent = skipped = 0
    last_thumb = None
    with cs.lock_for(visit_id):
        last = cs.load_session(visit_id).get("last_picture_thumb")
    if last:
        last_thumb = np.asarray(last, dtype=np.float32)

    for offset, forced in wanted:
        i = min(len(frames) - 1, int(offset * CLIP_FPS))
        frame = frames[i]
        used = cs.load_session(visit_id)["meters"]["ai_calls"]
        if used >= ai_budget():
            return "budget used up"
        if not forced:
            if media.sharpness(frame) < MIN_SHARPNESS:
                continue
            if media.change(media.thumb(frame), last_thumb) < MIN_CHANGE:
                continue
        safe = media.safe_for_ai(frame)
        if safe is None:
            skipped += 1
            continue
        try:
            result = vision.check(media.jpeg(safe), questions, AREAS)
        except Exception as e:
            def count_error(s):
                s["meters"]["ai_errors"] = s["meters"].get("ai_errors", 0) + 1
            cs.update_session(visit_id, count_error)
            print("picture check failed:", type(e).__name__, e)
            continue
        last_thumb = media.thumb(frame)
        sent += 1
        note = {
            "time": round(start_s + offset, 2),
            "piece": index,
            "at_mark": forced,
            "area": result["area"],
            "answers": result["answers"],
        }

        def save(s):
            s["meters"]["ai_calls"] += 1
            s["last_picture_thumb"] = [[round(float(v), 1) for v in row] for row in last_thumb.tolist()]
        cs.update_session(visit_id, save)
        with cs.lock_for(visit_id):
            notes = cs.read(visit_id, "scene_notes.json", [])
            notes.append(note)
            cs.write(visit_id, "scene_notes.json", notes)
    return str(sent) + " checked" + (", " + str(skipped) + " skipped (face still visible)" if skipped else "")


def retry_speech(visit_id, index):
    """
    After the visit: speech to text again for a piece where it failed, using the sound inside
    the BLURRED clip (the unblurred piece is already gone). Faces in that clip are blurred, so
    'who on camera spoke' cannot be checked again: those lines rely on voice and loudness only.
    Returns True if the piece now has a transcript.
    """
    import storage
    clip = cs.path(visit_id, "pending/" + _clip_name(index))
    if not clip.exists() or not stt.ready():
        return False
    session = cs.load_session(visit_id)
    chunk = session["chunks"][str(index)]
    tmp = Path(tempfile.mkdtemp(prefix="ss_retry_", dir=cs.cap_dir(visit_id)))
    try:
        src = tmp / "clip.mp4"
        src.write_bytes(storage.read_encrypted(clip))
        wav = media.decode_audio(src)
        segments = stt.transcribe(wav, visit_prompt(visit_id))
        for seg in segments:
            part = wav[int(seg["start"] * media.SAMPLE_RATE):int(seg["end"] * media.SAMPLE_RATE)]
            seg["loudness_db"] = round(media.loudness_db(part), 2)
            seg["embedding"] = voice.embed(part)
            seg["lip"] = None
        name = "analysis/piece_" + str(index).zfill(4) + ".json"
        data = cs.read_secret_json(visit_id, name) or {
            "index": index, "start": chunk["start_ms"] / 1000.0, "tracks": [], "frames": 0}
        data["segments"] = segments
        data["retried"] = True
        cs.write_secret_json(visit_id, name, data)
    except Exception as e:
        print("speech retry failed:", type(e).__name__, e)
        return False
    finally:
        cs.delete_dir(visit_id, tmp, "temporary folder for the speech retry of piece " + str(index))
    _set_chunk(visit_id, index, speech_failed=False, steps={"transcript": "done on retry (from the blurred clip)"})
    return True
