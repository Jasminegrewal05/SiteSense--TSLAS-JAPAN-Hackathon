import { useEffect } from "react";
import { Link } from "react-router-dom";

const BUTTON = {
  primary: "bg-ink text-white hover:bg-ink-hover disabled:bg-line-strong",
  secondary: "bg-white text-text border border-line-strong hover:bg-canvas disabled:text-sub",
  quiet: "text-sub hover:text-text hover:bg-canvas",
  danger: "text-high hover:bg-high-bg",
};

const SIZE = {
  md: "h-12 px-5 text-base rounded-[10px]",
  sm: "h-10 px-4 text-sm rounded-lg",
  lg: "h-14 px-7 text-lg rounded-xl",
};

export function Button({ variant = "primary", size = "md", className = "", busy = false, children, ...props }) {
  return (
    <button
      className={
        "inline-flex items-center justify-center gap-2 font-bold " + SIZE[size] + " " +
        "transition-colors disabled:cursor-not-allowed " +
        BUTTON[variant] +
        " " +
        className
      }
      disabled={busy || props.disabled}
      {...props}
    >
      {busy ? "Working..." : children}
    </button>
  );
}

export function ButtonLink({ to, variant = "primary", size = "md", className = "", children, ...props }) {
  return (
    <Link
      to={to}
      className={
        "inline-flex items-center justify-center gap-2 font-bold transition-colors " + SIZE[size] + " " +
        BUTTON[variant] +
        " " +
        className
      }
      {...props}
    >
      {children}
    </Link>
  );
}

const TONES = {
  neutral: "bg-nv-bg text-nv",
  ink: "bg-ink-50 text-ink",
  ok: "bg-ok-bg text-ok",
  high: "bg-high-bg text-high",
  med: "bg-med-bg text-med",
};

export function Pill({ tone = "neutral", children, className = "" }) {
  return (
    <span className={"inline-flex items-center rounded-md px-2.5 py-1 text-sm font-bold " + TONES[tone] + " " + className}>
      {children}
    </span>
  );
}

export function Notice({ tone = "high", children, className = "" }) {
  const styles = {
    high: "border-high/30 bg-high-bg text-high",
    med: "border-med/30 bg-med-bg text-med",
    ok: "border-ok/30 bg-ok-bg text-ok",
    ink: "border-ink-100 bg-ink-50 text-ink",
  };
  return (
    <div role="status" className={"rounded-lg border px-4 py-3 text-base " + styles[tone] + " " + className}>
      {children}
    </div>
  );
}

export function Field({ label, hint, error, children, className = "" }) {
  return (
    <label className={"block " + className}>
      <span className="block text-base font-bold mb-1.5">{label}</span>
      {children}
      {hint && !error && <span className="block text-sm text-sub mt-1">{hint}</span>}
      {error && <span className="block text-sm text-high mt-1">{error}</span>}
    </label>
  );
}

export const inputClass =
  "w-full h-12 rounded-[10px] border border-line-strong bg-white px-3.5 text-base " +
  "placeholder:text-sub/70 focus:border-ink focus:outline-none focus:ring-2 focus:ring-ink-100 " +
  "disabled:bg-canvas disabled:text-sub";

export function PageHeading({ title, children, sub }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
      <div>
        <h1 className="text-3xl font-bold">{title}</h1>
        {sub && <p className="text-sub text-lg mt-1 max-w-2xl">{sub}</p>}
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-text/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="sheet-enter relative w-full sm:max-w-lg bg-white rounded-t-xl sm:rounded-lg shadow-xl max-h-[92vh] overflow-y-auto"
      >
        <div className="px-5 pt-5 pb-2">
          <h2 className="text-xl font-bold">{title}</h2>
        </div>
        <div className="px-5 pb-5">{children}</div>
        {footer && (
          <div className="sticky bottom-0 bg-white border-t border-line px-5 py-3 flex justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function Loading({ text = "Loading..." }) {
  return <div className="py-16 text-center text-sub">{text}</div>;
}

export const VERDICT = {
  differs: "Doesn't match",
  not_shown: "Not shown",
  supported: "Supported",
  unchecked: "Couldn't check",
};

export function Tag({ verdict, className = "" }) {
  return <span className={"tag tag-" + verdict + " " + className}>{VERDICT[verdict]}</span>;
}

// The one thing to do now on this visit: a sentence and a big button.
export function NextStep({ text, action, to, onClick, busy }) {
  return (
    <div className="bg-white border-2 border-ink rounded-xl px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6">
      <p className="text-lg font-bold flex-1">{text}</p>
      {action && (to ? (
        <ButtonLink to={to} size="lg" className="shrink-0">{action}</ButtonLink>
      ) : (
        <Button size="lg" onClick={onClick} busy={busy} className="shrink-0">{action}</Button>
      ))}
    </div>
  );
}
