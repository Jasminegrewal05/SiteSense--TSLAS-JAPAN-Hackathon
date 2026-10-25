// Small inline icon set (stroke icons, 20x20 grid).
const PATHS = {
  check: "M4.5 10.5l3.5 3.5 7.5-8",
  alert: "M10 6v5M10 14.2v.1",
  slash: "M6 14L14 6",
  plus: "M10 4.5v11M4.5 10h11",
  upload: "M10 13V4M6.5 7.5L10 4l3.5 3.5M4 14v2h12v-2",
  file: "M6 3h5l4 4v10H6zM11 3v4h4",
  trash: "M5 6h10M8 6V4h4v2M6.5 6l.7 10h5.6l.7-10",
  edit: "M4 16h3l8.5-8.5-3-3L4 13zM11.5 5.5l3 3",
  back: "M12 5l-5 5 5 5",
  lock: "M6 9V7a4 4 0 018 0v2M5 9h10v7H5z",
  phone: "M7 3h6v14H7zM9.5 14.5h1",
  logout: "M8 4H4v12h4M12 7l3 3-3 3M15 10H8",
  chevron: "M8 5l5 5-5 5",
  x: "M5.5 5.5l9 9M14.5 5.5l-9 9",
  download: "M10 4v9M6.5 9.5L10 13l3.5-3.5M4 16h12",
};

export default function Icon({ name, size = 18, className = "", strokeWidth = 1.7 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
