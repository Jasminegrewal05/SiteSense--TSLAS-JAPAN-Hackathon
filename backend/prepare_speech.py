"""
Downloads the speech-to-text model once (about 145 MB for "base"), so the first
visit works even without internet. Run from the backend folder:

    python prepare_speech.py

Then test it on any audio or video file you have:

    python prepare_speech.py some_recording.mp4
"""

import sys

from dotenv import load_dotenv

load_dotenv()

import media  # noqa: E402
import settings  # noqa: E402
import stt  # noqa: E402

if not stt.available():
    print("faster-whisper is not installed. Run: pip install -r requirements.txt")
    sys.exit(1)

print("Loading speech model '" + settings.get("WHISPER_MODEL", "small") + "' (downloads the first time)...")
stt._load()
print("Speech model ready.")

if len(sys.argv) > 1:
    if not media.ffmpeg_ok():
        print("ffmpeg is not installed, so the test file cannot be read.")
        sys.exit(1)
    wav = media.decode_audio(sys.argv[1])
    for seg in stt.transcribe(wav):
        print(format(seg["start"], "6.1f") + "s  " + seg["text"])
