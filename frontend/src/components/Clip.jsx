import { api } from "../api";
import { Button, Modal } from "./ui";

export function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

// A small button that plays the blurred clip at that moment.
export function ClipButton({ clip, onPlay, label }) {
  if (!clip) return null;
  return (
    <button
      onClick={() => onPlay(clip)}
      className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-line-strong bg-white text-sm font-bold text-ink hover:bg-ink-50 shrink-0"
      aria-label={"Play clip at " + clock(clip.time)}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M2 1l7 4-7 4z" fill="currentColor" />
      </svg>
      <span className="num">{label || clock(clip.time)}</span>
    </button>
  );
}

// The player. `starts` maps piece number -> start time in seconds, so it opens at the right moment.
export function ClipPlayer({ visitId, clip, starts, onClose }) {
  const offset = clip ? Math.max(0, clip.time - ((starts && starts[String(clip.piece)]) || 0) - 1) : 0;
  return (
    <Modal
      open={!!clip}
      onClose={onClose}
      title={clip ? "Clip at " + clock(clip.time) + " (faces blurred)" : ""}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      {clip && (
        <video
          key={clip.piece + "-" + clip.time}
          src={api.clipUrl(visitId, clip.piece)}
          controls
          autoPlay
          playsInline
          className="w-full rounded-lg bg-black"
          onLoadedMetadata={(e) => {
            e.currentTarget.currentTime = starts ? offset : 0;
          }}
        />
      )}
    </Modal>
  );
}
