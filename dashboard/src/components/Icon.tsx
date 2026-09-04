const paths = {
  plus: "M12 5v14M5 12h14",
  close: "m6 6 12 12M18 6 6 18",
  chevronDown: "m6 9 6 6 6-6",
  chevronRight: "m9 6 6 6-6 6",
  arrowDown: "M12 5v14m-6-6 6 6 6-6",
  arrowUp: "M12 19V5m-6 6 6-6 6 6",
  check: "m5 12 4 4L19 6",
  retry: "M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7",
  folder: "M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3Z",
  sidebar: "M9 4v16M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z",
  settings:
    "M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Zm6 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  search: "M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Zm-1 5.5 5 5",
  pin: "M8 3h8l-1 6 4 4v2H5v-2l4-4ZM12 15v7",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  copy: "M9 9h11v11H9ZM5 15H3V3h12v2",
  edit: "m15 4 5 5M4 20l1-6L16 3l5 5L10 19ZM4 20h6",
  file: "M14 3H5v18h14V8ZM14 3v5h5M8 13h8M8 17h5",
  code: "m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16",
  details: "M4 5h16v14H4ZM14 5v14M7 9h4M7 13h3",
  stop: "M6 6h12v12H6Z",
  link: "m9 15 6-6M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m4 2 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0",
} as const;

export type IconName = keyof typeof paths;

/** One consistent vector style; the surrounding control owns its accessible name. */
export function Icon({
  name,
  size = 20,
}: {
  readonly name: IconName;
  readonly size?: number;
}): React.JSX.Element {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" ? 3 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
