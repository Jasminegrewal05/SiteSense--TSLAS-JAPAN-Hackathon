// The "61 days -> 85 days" figure pair: shows which number moved, and how far.
export default function Movement({ label, previous, current, size = "md" }) {
  const big = size === "lg";
  return (
    <div className="min-w-0">
      <div className={"text-sub " + (big ? "text-sm" : "text-xs")}>{label}</div>
      <div className={"num flex items-baseline gap-2 " + (big ? "mt-1" : "mt-0.5")}>
        {previous && (
          <>
            <span className={"text-sub " + (big ? "text-2xl" : "text-sm")}>{previous}</span>
            <svg
              width={big ? 22 : 14}
              height={big ? 12 : 8}
              viewBox="0 0 22 12"
              className="text-line-strong shrink-0 self-center"
              aria-label="to"
            >
              <path d="M1 6h18M15 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          </>
        )}
        <span className={"font-bold text-text " + (big ? "text-4xl" : "text-sm")}>{current}</span>
      </div>
    </div>
  );
}
