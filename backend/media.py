"""
Video and audio helpers for Phase 2.  Everything here runs on the laptop.

  - ffmpeg: decode frames and audio, encode the blurred clip
  - faces:  find faces with OpenCV's YuNet model (models/ folder)
  - blur:   hide every face in a frame before anything is saved or sent to AI
  - lips:   how much the mouth area moves, to tell who on camera is speaking
  - sharpness / change: to skip blurry or repeated pictures
"""

import json
import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
MODEL_PATH = Path(__file__).resolve().parent / "models" / "face_detection_yunet_2023mar.onnx"

SAMPLE_RATE = 16000


def ffmpeg_ok():
    return FFMPEG is not None and FFPROBE is not None


def _run(cmd, input_bytes=None):
    proc = subprocess.run(cmd, input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "ignore")[-400:]
        raise RuntimeError("ffmpeg failed: " + tail)
    return proc.stdout


# ---------- probing and decoding ----------

def probe(path):
    """Returns {"duration", "width", "height", "has_video", "has_audio"} (display size, after rotation)."""
    out = _run([FFPROBE, "-v", "error", "-show_entries",
                "format=duration:stream=codec_type,width,height:stream_side_data=rotation:stream_tags=rotate",
                "-of", "json", str(path)])
    info = json.loads(out or b"{}")
    result = {"duration": None, "width": None, "height": None, "has_video": False, "has_audio": False}
    try:
        result["duration"] = float(info.get("format", {}).get("duration"))
    except (TypeError, ValueError):
        pass
    for s in info.get("streams", []):
        if s.get("codec_type") == "audio":
            result["has_audio"] = True
        if s.get("codec_type") == "video" and not result["has_video"]:
            result["has_video"] = True
            w, h = s.get("width"), s.get("height")
            rotation = 0
            for sd in s.get("side_data_list", []) or []:
                if "rotation" in sd:
                    rotation = int(sd["rotation"])
            if "rotate" in (s.get("tags") or {}):
                rotation = int(s["tags"]["rotate"])
            if abs(rotation) % 180 == 90:
                w, h = h, w
            result["width"], result["height"] = w, h
    return result


def decode_frames(path, fps, width):
    """All frames at `fps`, scaled to `width` (height keeps the aspect ratio). Returns (frames, w, h)."""
    info = probe(path)
    if not info["has_video"] or not info["width"]:
        return [], 0, 0
    w = width
    h = int(round(info["height"] * width / info["width"] / 2.0)) * 2
    raw = _run([FFMPEG, "-v", "error", "-i", str(path), "-vf",
                "fps=" + str(fps) + ",scale=" + str(w) + ":" + str(h),
                "-f", "rawvideo", "-pix_fmt", "bgr24", "-"])
    size = w * h * 3
    count = len(raw) // size
    frames = [np.frombuffer(raw[i * size:(i + 1) * size], dtype=np.uint8).reshape(h, w, 3).copy()
              for i in range(count)]
    return frames, w, h


def decode_audio(path):
    """Mono 16 kHz float32 audio in the range -1..1. Empty array if there is no sound."""
    info = probe(path)
    if not info["has_audio"]:
        return np.zeros(0, dtype=np.float32)
    raw = _run([FFMPEG, "-v", "error", "-i", str(path), "-vn", "-ac", "1",
                "-ar", str(SAMPLE_RATE), "-f", "s16le", "-"])
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def split_video(path, out_dir, seconds=10):
    """Cuts a long video into pieces of exactly `seconds` (the last one may be shorter)."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    total = probe(path)["duration"] or 0.0
    pieces, start, n = [], 0.0, 0
    while start < total - 0.3:
        out = out_dir / ("piece_" + str(n).zfill(4) + ".mp4")
        _run([FFMPEG, "-v", "error", "-y", "-ss", format(start, ".3f"), "-i", str(path),
              "-t", str(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
              "-c:a", "aac", "-b:a", "96k", str(out)])
        pieces.append(out)
        start += seconds
        n += 1
    return pieces


# ---------- audio measures ----------

def loudness_db(wav):
    if wav is None or len(wav) == 0:
        return -120.0
    rms = float(np.sqrt(np.mean(np.square(wav))))
    return 20.0 * np.log10(rms + 1e-9)


def envelope(wav, fps, count):
    """Loudness of the sound for each video frame (same timing as frames at `fps`)."""
    hop = SAMPLE_RATE // fps
    out = np.zeros(count, dtype=np.float32)
    for i in range(count):
        part = wav[i * hop:(i + 1) * hop]
        if len(part):
            out[i] = float(np.sqrt(np.mean(np.square(part))))
    return out


# ---------- faces ----------

class FaceFinder:
    """YuNet face detector. Falls back to OpenCV's built-in Haar detector if the model is missing."""

    def __init__(self):
        self.kind = None
        self._yunet = None
        self._haar = []
        if MODEL_PATH.exists() and hasattr(cv2, "FaceDetectorYN"):
            try:
                self._yunet = cv2.FaceDetectorYN.create(str(MODEL_PATH), "", (320, 320), 0.5, 0.3, 50)
                self.kind = "yunet"
            except cv2.error:
                self._yunet = None
        if self._yunet is None:
            for name in ("haarcascade_frontalface_default.xml", "haarcascade_profileface.xml"):
                for folder in (MODEL_PATH.parent, Path(cv2.data.haarcascades) if hasattr(cv2, "data") else MODEL_PATH.parent):
                    if (folder / name).exists():
                        c = cv2.CascadeClassifier(str(folder / name))
                        if not c.empty():
                            self._haar.append(c)
                            break
            self.kind = "haar" if self._haar else None

    @property
    def ok(self):
        return self.kind is not None

    def detect(self, frame, min_score=0.5):
        """Returns a list of faces: {"box": (x, y, w, h), "score": s, "mouth": ((x, y), (x, y)) or None}."""
        h, w = frame.shape[:2]
        faces = []
        if self._yunet is not None:
            self._yunet.setInputSize((w, h))
            self._yunet.setScoreThreshold(min_score)
            _, found = self._yunet.detect(frame)
            if found is not None:
                for f in found:
                    x, y, fw, fh = [float(v) for v in f[:4]]
                    lm = f[4:14].reshape(5, 2)
                    faces.append({
                        "box": (x, y, fw, fh),
                        "score": float(f[14]),
                        "mouth": ((float(lm[3][0]), float(lm[3][1])), (float(lm[4][0]), float(lm[4][1]))),
                        "nose": (float(lm[2][0]), float(lm[2][1])),
                    })
        elif self._haar:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            for c in self._haar:
                for (x, y, fw, fh) in c.detectMultiScale(gray, 1.15, 4, minSize=(24, 24)):
                    faces.append({"box": (float(x), float(y), float(fw), float(fh)), "score": 0.6,
                                  "mouth": None, "nose": None})
        return faces


_finder = None


def finder():
    global _finder
    if _finder is None:
        _finder = FaceFinder()
    return _finder


# ---------- blur ----------

def _expand(box, w, h, pad=0.3):
    x, y, bw, bh = box
    x0 = int(max(0, x - bw * pad))
    y0 = int(max(0, y - bh * pad))
    x1 = int(min(w, x + bw * (1 + pad)))
    y1 = int(min(h, y + bh * (1 + pad)))
    return x0, y0, x1, y1


BLUR_PAD = 0.45  # blur boxes are made 45% bigger on every side


def blur_boxes(frame, boxes):
    out = frame.copy()
    h, w = out.shape[:2]
    for box in boxes:
        x0, y0, x1, y1 = _expand(box, w, h, pad=BLUR_PAD)
        if x1 - x0 < 2 or y1 - y0 < 2:
            continue
        region = out[y0:y1, x0:x1]
        # Pixelate first, then smooth: nothing of the face can be recovered.
        small = cv2.resize(region, (6, 6), interpolation=cv2.INTER_AREA)
        region = cv2.resize(small, (x1 - x0, y1 - y0), interpolation=cv2.INTER_NEAREST)
        out[y0:y1, x0:x1] = cv2.GaussianBlur(region, (0, 0), 7)
    return out


def blur_whole(frame):
    small = cv2.resize(frame, (16, 9), interpolation=cv2.INTER_AREA)
    return cv2.resize(small, (frame.shape[1], frame.shape[0]), interpolation=cv2.INTER_LINEAR)


BLUR_SCORE = 0.25   # lower than for lips: blurring a non-face is fine, missing a face is not
EDGE_PAD = 0.25     # frames are padded so a face cut off by the frame edge still looks like a face
CARRY = 5           # a face found in one frame is also blurred 5 frames before and after
SIDE_EVERY = 3      # the side-face detector runs on every 3rd frame (the carry covers the rest)
SIDE_WIDTH = 320    # ...on a copy this wide, which is fast enough for a 10-second piece

_side = None


def _side_finders():
    """OpenCV's frontal and PROFILE face detectors, used only to find faces to blur.
    YuNet is trained on whole faces; these catch faces turned sideways."""
    global _side
    if _side is None:
        # Shipped in models/ (newer OpenCV packages no longer include them); OpenCV's own copy as a fallback.
        _side = []
        for name in ("haarcascade_frontalface_default.xml", "haarcascade_profileface.xml"):
            for folder in (MODEL_PATH.parent, Path(getattr(cv2, "data", None).haarcascades if hasattr(cv2, "data") else "")):
                f = folder / name
                if f.exists():
                    c = cv2.CascadeClassifier(str(f))
                    if not c.empty():
                        _side.append((name, c))
                        break
    return _side


def _blur_boxes_one(frame, fd, side):
    h, w = frame.shape[:2]
    boxes = []
    # 1. YuNet on a padded frame: a half face at the edge becomes a whole face in the middle
    px, py = int(w * EDGE_PAD), int(h * EDGE_PAD)
    padded = cv2.copyMakeBorder(frame, py, py, px, px, cv2.BORDER_CONSTANT, value=(0, 0, 0))
    for f in fd.detect(padded, min_score=BLUR_SCORE):
        x, y, bw, bh = f["box"]
        boxes.append((x - px, y - py, bw, bh))
    # 2. Side faces: the profile detector on a smaller copy of the frame and on its mirror
    #    image (it only sees faces turned one way). YuNet already covers faces from the front.
    if side is not None:
        scale = min(1.0, SIDE_WIDTH / float(w))
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if scale < 1.0:
            gray = cv2.resize(gray, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        gray = cv2.equalizeHist(gray)
        gw = gray.shape[1]
        for flip in (False, True):
            img = cv2.flip(gray, 1) if flip else gray
            for (x, y, bw, bh) in side.detectMultiScale(img, 1.15, 3, minSize=(14, 14)):
                x = gw - x - bw if flip else x
                boxes.append((x / scale, y / scale, bw / scale, bh / scale))
    # keep only boxes that touch the frame
    return [b for b in boxes if b[0] + b[2] > 0 and b[1] + b[3] > 0 and b[0] < w and b[1] < h]


def face_boxes_for_blur(frames):
    """
    Faces to blur in every frame. Three finders together, a low bar, and every box carried
    CARRY frames before and after, so a face missed for a moment is still covered.
    The side-face detector runs on every 3rd frame (the carry covers the others).
    """
    fd = finder()
    if not fd.ok:
        return None
    profile = next((c for name, c in _side_finders() if "profile" in name), None)
    found = [_blur_boxes_one(fr, fd, profile if i % SIDE_EVERY == 0 else None) for i, fr in enumerate(frames)]
    merged = []
    for i in range(len(frames)):
        boxes = []
        for j in range(max(0, i - CARRY), min(len(frames), i + CARRY + 1)):
            boxes.extend(found[j])
        merged.append(boxes)
    return merged, sum(1 for f in found if f)


def blurred_frames(frames):
    """Returns (blurred frames, frames that had a face). Without a face model, the whole frame is blurred."""
    result = face_boxes_for_blur(frames)
    if result is None:
        return [blur_whole(f) for f in frames], -1
    boxes, with_faces = result
    return [blur_boxes(f, b) for f, b in zip(frames, boxes)], with_faces


def safe_for_ai(blurred_frame):
    """
    Last check before a picture leaves the laptop. The frame is already blurred; if the face
    finder still sees a face (with a very low bar), that spot is blurred again. If a face is
    still found after that, returns None and the picture is not sent.
    """
    fd = finder()
    if not fd.ok:
        return None
    left = [f["box"] for f in fd.detect(blurred_frame, min_score=0.3)]
    if not left:
        return blurred_frame
    again = blur_boxes(blurred_frame, left)
    if fd.detect(again, min_score=0.3):
        return None
    return again


def encode_clip(frames, fps, audio_source, out_path):
    """Writes frames (already blurred) plus the original sound as a small browser-playable MP4."""
    if not frames:
        return 0
    h, w = frames[0].shape[:2]
    cmd = [FFMPEG, "-v", "error", "-y",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", str(w) + "x" + str(h), "-r", str(fps), "-i", "-",
           "-i", str(audio_source),
           "-map", "0:v", "-map", "1:a?",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "32", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "40k", "-ac", "1",
           "-shortest", "-movflags", "+faststart", str(out_path)]
    _run(cmd, input_bytes=b"".join(f.tobytes() for f in frames))
    return Path(out_path).stat().st_size


def jpeg(frame, quality=80):
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buf.tobytes() if ok else b""


# ---------- picture quality ----------

def sharpness(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def thumb(frame):
    return cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (64, 36)).astype(np.float32)


def change(a, b):
    """0 = same picture, larger = more different."""
    if a is None or b is None:
        return 999.0
    return float(np.mean(np.abs(a - b)))


# ---------- lips ----------

def _iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x0, y0 = max(ax, bx), max(ay, by)
    x1, y1 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def _crop(gray, x0, y0, x1, y1):
    h, w = gray.shape
    x0, y0 = int(max(0, x0)), int(max(0, y0))
    x1, y1 = int(min(w, x1)), int(min(h, y1))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    return cv2.resize(gray[y0:y1, x0:x1], (32, 16)).astype(np.float32) / 255.0


def _regions(face, gray):
    """Mouth area and an upper-face reference area (to cancel out head movement)."""
    x, y, w, h = face["box"]
    if face.get("mouth"):
        (rx, ry), (lx, ly) = face["mouth"]
        cx, cy = (rx + lx) / 2.0, (ry + ly) / 2.0
        half = max(abs(lx - rx) * 0.75, w * 0.18)
        mouth = _crop(gray, cx - half, cy - h * 0.12, cx + half, cy + h * 0.2)
    else:
        mouth = _crop(gray, x + w * 0.25, y + h * 0.65, x + w * 0.75, y + h * 0.95)
    upper = _crop(gray, x + w * 0.2, y + h * 0.15, x + w * 0.8, y + h * 0.45)
    return mouth, upper


def face_tracks(frames, min_score=0.6):
    """
    Follows each visible face from frame to frame (by position only, no face recognition).
    Returns tracks: {"id", "boxes": {frame_i: box}, "motion": {frame_i: mouth movement}}.
    """
    fd = finder()
    if not fd.ok:
        return []
    tracks, active, next_id = [], {}, 1
    prev_crops = {}
    for i, frame in enumerate(frames):
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = fd.detect(frame, min_score=min_score)
        new_active = {}
        for face in faces:
            best, best_iou = None, 0.3
            for tid, tr in active.items():
                if tid in new_active:
                    continue
                last = tr["boxes"][max(tr["boxes"])]
                o = _iou(face["box"], last)
                if o > best_iou:
                    best, best_iou = tid, o
            if best is None:
                tr = {"id": next_id, "boxes": {}, "motion": {}}
                tracks.append(tr)
                best = next_id
                next_id += 1
                active[best] = tr
            tr = active[best]
            tr["boxes"][i] = face["box"]
            mouth, upper = _regions(face, gray)
            prev = prev_crops.get(best)
            if prev and mouth is not None and prev[0] is not None and prev[1] is not None and upper is not None:
                m = float(np.mean(np.abs(mouth - prev[0])))
                u = float(np.mean(np.abs(upper - prev[1])))
                tr["motion"][i] = max(0.0, m - u)
            prev_crops[best] = (mouth, upper)
            new_active[best] = tr
        active = new_active
    return tracks


def speaking_track(tracks, env, fps, start, end, max_lag=0.3):
    """
    Which visible face is speaking between start and end (seconds in this piece)?
    A face counts as speaking when its mouth moves in time with the sound.
    Phones record sound and picture slightly out of sync, so we also try shifting
    the sound by up to `max_lag` seconds either way and keep the best match.
    Returns {"track", "corr", "motion", "lag", "visible": [track ids]} or None.
    """
    i0, i1 = int(start * fps), int(end * fps) + 1
    lags = range(-int(max_lag * fps), int(max_lag * fps) + 1)
    best, visible = None, []
    for tr in tracks:
        frames = [i for i in range(i0, i1) if i in tr["boxes"]]
        if len(frames) < max(3, (i1 - i0) // 2):
            continue
        visible.append(tr["id"])
        idx = [i for i in frames if i in tr["motion"]]
        if len(idx) < 6:
            continue
        mean_m = float(np.mean([tr["motion"][i] for i in idx]))
        if mean_m < 0.008:
            continue
        # Mouth movement is compared with both the loudness and the CHANGE in loudness:
        # the mouth moves most while a sound starts or stops.
        change_env = np.abs(np.diff(env, prepend=env[:1]))
        for signal in (env, change_env):
            for lag in lags:
                pairs = [(tr["motion"][i], signal[i + lag]) for i in idx if 0 <= i + lag < len(signal)]
                if len(pairs) < 6:
                    continue
                m = np.array([p[0] for p in pairs])
                a = np.array([p[1] for p in pairs])
                if m.std() < 1e-6 or a.std() < 1e-6:
                    continue
                corr = float(np.corrcoef(m, a)[0, 1])
                if corr >= 0.35 and (best is None or corr > best["corr"]):
                    best = {"track": tr["id"], "corr": round(corr, 3), "motion": round(mean_m, 4),
                            "lag": round(lag / float(fps), 2)}
    if best is not None:
        best["visible"] = visible
        return best
    return {"track": None, "visible": visible} if visible else None
