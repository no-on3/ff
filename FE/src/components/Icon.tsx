import React from 'react';

/** The console's icons: 20-unit outlines drawn in the text's color. */
const PATHS = {
  functions: <path d="M6 3h2l5 13M4 16l5-8" />,
  databases: (
    <>
      <ellipse cx="10" cy="5" rx="6" ry="2.5" />
      <path d="M4 5v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5" />
    </>
  ),
  buckets: (
    <>
      <ellipse cx="10" cy="5" rx="6.5" ry="2" />
      <path d="M3.5 5 5 16c.2 1 2.4 1.5 5 1.5s4.8-.5 5-1.5L16.5 5" />
    </>
  ),
  queues: <path d="M3 5.5h10M3 10h10M3 14.5h6M15 8l2.5 2-2.5 2" />,
  alarms: <path d="M5 13V9a5 5 0 0 1 10 0v4l1.5 2h-13L5 13ZM8.5 17.5a1.5 1.5 0 0 0 3 0" />,
  usage: <path d="M4 16V9M8.5 16V4M13 16v-5M17 16V7" />,
  billing: <path d="M5 3h10v14l-2.5-1.5L10 17l-2.5-1.5L5 17V3ZM8 7h4M8 10h4" />,
  settings: (
    <>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
    </>
  ),
  notifications: <path d="M3 5h14v10H3zM3 5l7 6 7-6" />,
  members: (
    <>
      <circle cx="7.5" cy="7" r="2.5" />
      <path d="M3 16c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4M13 4.8a2.5 2.5 0 0 1 0 4.4M14.5 12.3c1.5.5 2.5 1.8 2.5 3.7" />
    </>
  ),
  keys: (
    <>
      <circle cx="6.5" cy="13.5" r="3" />
      <path d="m8.6 11.4 7-7M13 7l2 2M15 5l1.5 1.5" />
    </>
  ),
  menu: <path d="M3.5 6h13M3.5 10h13M3.5 14h13" />,
  close: <path d="m5 5 10 10M15 5 5 15" />,
  chevron: <path d="m7 8 3 3 3-3" />,
  plus: <path d="M10 4v12M4 10h12" />,
  search: (
    <>
      <circle cx="9" cy="9" r="5" />
      <path d="m13 13 4 4" />
    </>
  ),
  link: <path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2L10 5.8M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l1.1-1.1" />,
  clock: (
    <>
      <circle cx="10" cy="10" r="6.5" />
      <path d="M10 6.5V10l2.5 1.5" />
    </>
  ),
} satisfies Record<string, React.ReactNode>;

export type IconName = keyof typeof PATHS;

const Icon: React.FC<{ name: IconName; size?: number; className?: string }> = ({ name, size = 16, className }) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {PATHS[name]}
  </svg>
);

export default Icon;
