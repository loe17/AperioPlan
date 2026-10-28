/**
 * Einheitlicher Symbolsatz von AperioPlan (eigene SVG-Strichgrafiken, 24 × 24).
 * Alle Symbole übernehmen die Textfarbe (currentColor) und passen so in Hell- und Dunkelmodus.
 */
import type { CSSProperties, ReactNode } from 'react';

const P: Record<string, ReactNode> = {
  // Navigation & Allgemein
  home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20h14V9.5" /><path d="M10 20v-6h4v6" /></>,
  inbox: <><path d="M3 13h5l1.5 3h5L16 13h5" /><path d="M5 5h14l2 8v6H3v-6z" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  'calendar-team': <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /><circle cx="12" cy="14.5" r="1.6" /><path d="M9.2 19c.4-1.5 1.5-2.2 2.8-2.2s2.4.7 2.8 2.2" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  timer: <><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 1.5M9.5 2h5M12 2v3" /></>,
  palm: <><path d="M12 21V11" /><path d="M12 11C10 7 6 6 3 7.5c3 .3 5.5 1.6 7 3.5" /><path d="M12 11c2-4 6-5 9-3.5-3 .3-5.5 1.6-7 3.5" /><path d="M12 11c0-4-2-6.5-5-7.5 2 1.5 3.5 4 4 7" /><path d="M6 21h12" /></>,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  unlock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.5-2" /></>,
  star: <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />,
  'star-filled': <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" fill="currentColor" />,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.7-3.6 3.3-5.5 6.5-5.5s5.8 1.9 6.5 5.5" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c2 .7 3.2 2.5 3.6 5.2" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c.8-4 4-6.5 8-6.5s7.2 2.5 8 6.5" /></>,
  folder: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />,
  'folder-open': <><path d="M3 18V6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h7.5A1.5 1.5 0 0 1 20 9v1.5" /><path d="M3 18l2.5-7.5h16L19 18.5a2 2 0 0 1-1.9 1.5H4.5A1.5 1.5 0 0 1 3 18z" /></>,
  projects: <><rect x="3" y="4" width="7" height="7" rx="1.5" /><rect x="14" y="4" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  tools: <><path d="M14.5 6.5a4 4 0 0 0 5 5L21 13l-8 8-3-3 8-8" /><path d="M3 21l6-6M6 3l4 4-3 3-4-4z" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  bell: <><path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9" /><path d="M10 20a2 2 0 0 0 4 0" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  // Wetter
  cloud: <path d="M7 18h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.5A3.3 3.3 0 0 0 7 18z" />,
  'cloud-sun': <><path d="M8 19h9a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.6 1.2A2.9 2.9 0 0 0 8 19z" /><path d="M8.5 3v1.5M3 8.5h1.5M4.6 4.6l1 1M12.4 4.6l-1 1" /><path d="M6.2 10.6A3.5 3.5 0 0 1 11.6 6.4" /></>,
  fog: <><path d="M7 13h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.5A3.3 3.3 0 0 0 7 13z" /><path d="M4 17h16M6 20.5h12" /></>,
  drizzle: <><path d="M7 15h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.5A3.3 3.3 0 0 0 7 15z" /><path d="M8 18.5v.5M12 19.5v.5M16 18.5v.5" /></>,
  rain: <><path d="M7 14h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.5A3.3 3.3 0 0 0 7 14z" /><path d="m8 17-1 3M12 17l-1 3M16 17l-1 3" /></>,
  snow: <><path d="M7 14h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.5A3.3 3.3 0 0 0 7 14z" /><path d="M8 18h.01M12 20h.01M16 18h.01M10 21.5h.01M14 21.5h.01" strokeWidth="2.4" /></>,
  storm: <><path d="M7 14h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.5A3.3 3.3 0 0 0 7 14z" /><path d="m12.5 14-2.5 4h4l-2.5 4" /></>,
  grip: <path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" strokeWidth="3" />,
  layout: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 9v12" /></>,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  logout: <><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 16l-4-4 4-4M6 12h10" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  'chevrons-left': <path d="m11 17-5-5 5-5M18 17l-5-5 5-5" />,
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  'chevron-left': <path d="m15 6-6 6 6 6" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'arrow-up': <path d="M12 19V5M6 11l6-6 6 6" />,
  'arrow-down': <path d="M12 5v14M6 13l6 6 6-6" />,
  'arrow-right': <path d="M5 12h14M13 6l6 6-6 6" />,
  more: <><circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" /></>,
  redo: <><path d="M15 14l5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></>,
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  'check-circle': <><circle cx="12" cy="12" r="9" /><path d="m8 12.5 3 3 5-6" /></>,
  'x-circle': <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></>,
  alert: <><path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0" /><path d="M12 9v4M12 17h.01" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  ban: <><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></>,
  edit: <><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>,
  trash: <><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13M9 7V4h6v3" /></>,
  download: <><path d="M12 4v11M7 10l5 5 5-5" /><path d="M4 19h16" /></>,
  upload: <><path d="M12 16V5M7 10l5-5 5 5" /><path d="M4 19h16" /></>,
  link: <><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  refresh: <><path d="M20 11A8 8 0 0 0 5.5 6.5L4 8" /><path d="M4 3.5V8h4.5M4 13a8 8 0 0 0 14.5 4.5L20 16" /><path d="M20 20.5V16h-4.5" /></>,
  key: <><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 9.3-9.3M16 7l3 3M14 9l2 2" /></>,
  'eye-off': <><path d="M3 3l18 18" /><path d="M10.6 5.1A10 10 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3 3.8M6.5 6.6C3.9 8.3 2.5 12 2.5 12s3.5 7 9.5 7a9.6 9.6 0 0 0 4.2-1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>,
  maximize: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  filter: <path d="M3 5h18l-7 8.5V20l-4-2v-4.5z" />,
  paperclip: <path d="m20 11.5-8.4 8.4a5 5 0 0 1-7.1-7.1L13 4.3a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.5a1.7 1.7 0 0 1-2.4-2.4L14.6 7.4" />,
  send: <><path d="M21 3 10.5 13.5" /><path d="M21 3 14.5 21l-4-7.5L3 9.5z" /></>,
  printer: <><path d="M6 9V3h12v6" /><rect x="3" y="9" width="18" height="8" rx="2" /><path d="M6 14h12v7H6z" /></>,
  sparkles: <><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></>,
  puzzle: <path d="M10 3.5a2 2 0 0 1 4 0V5h4a1 1 0 0 1 1 1v4h-1.5a2 2 0 0 0 0 4H19v4a1 1 0 0 1-1 1h-4v-1.5a2 2 0 0 0-4 0V19H6a1 1 0 0 1-1-1v-4h1.5a2 2 0 0 0 0-4H5V6a1 1 0 0 1 1-1h4z" />,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
  list: <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />,
  kanban: <><rect x="3" y="4" width="5" height="16" rx="1.5" /><rect x="10" y="4" width="5" height="11" rx="1.5" /><rect x="17" y="4" width="4" height="7" rx="1.5" /></>,
  gantt: <path d="M4 4v16h16M8 8h6M10 12h7M7 16h5" />,
  whiteboard: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21l4-4 4 4M7 13l3-3 2 2 4-4" /></>,
  report: <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5M9 13h6M9 17h6M9 9h2" /></>,
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  'chart-up': <><path d="M3 20h18" /><path d="m4 16 5-5 4 3 7-8" /><path d="M15 6h5v5" /></>,
  file: <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5" /></>,
  'file-text': <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5M9 12h6M9 16h6" /></>,
  'file-pdf': <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5" /><path d="M8.5 17v-4h1.3a1.2 1.2 0 0 1 0 2.4H8.5M13 17v-4h.8a2 2 0 0 1 0 4zM17.5 13h-1.5v4M16 15h1.3" /></>,
  'file-word': <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5M8.5 12l1.2 5 1.3-3.5 1.3 3.5 1.2-5" /></>,
  'file-excel': <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5M9 12l4 5M13 12l-4 5" /></>,
  'file-slides': <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5" /><rect x="8.5" y="12" width="7" height="5" rx=".5" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></>,
  video: <><rect x="2" y="6" width="14" height="12" rx="2" /><path d="m16 10 6-3v10l-6-3z" /></>,
  'video-off': <><path d="M10.5 6H14a2 2 0 0 1 2 2v3.5l6-3.5v10l-3.5-2M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2" /><path d="m2 2 20 20" /></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
  'mic-off': <><path d="M15 10V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5M5 11a7 7 0 0 0 11.2 5.6M19 11a7 7 0 0 1-.6 2.8M12 18v3" /><path d="m3 3 18 18" /></>,
  phone: <path d="M5 4h3.5l1.5 4.5-2 1.5a11 11 0 0 0 6 6l1.5-2 4.5 1.5V19a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />,
  'screen-share': <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4M12 13V7M9 10l3-3 3 3" /></>,
  archive: <><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" /></>,
  zip: <><path d="M6 3h9l4 4v14H6z" /><path d="M11 3v2h2v2h-2v2h2v2h-2v3h2v3h-2" /></>,
  cube: <><path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z" /><path d="M3.5 7 12 11.5 20.5 7M12 11.5v10" /></>,
  ruler: <><path d="M3 17 17 3l4 4L7 21z" /><path d="m7 13 2 2M10 10l2 2M13 7l2 2" /></>,
  film: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7 3v18M17 3v18M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4" /></>,

  // Fachliche Symbole
  cad: <><path d="M4 20 12 4l8 16" /><path d="M7.5 13h9" /><circle cx="12" cy="4" r="1.5" /></>,
  part: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" /><circle cx="12" cy="12" r="7" /></>,
  assembly: <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /><path d="M11 7h4a2 2 0 0 1 2 2v4M13 17H9a2 2 0 0 1-2-2v-4" /></>,
  drawing: <><rect x="3" y="3" width="18" height="18" rx="1.5" /><path d="M3 16h18M13 16v5M6 6h6v6H6zM15 7h3M15 10h3" /></>,
  factory: <><path d="M3 21V10l5 3V10l5 3V10l5 3V4h3v17z" /><path d="M7 17h2M12 17h2M17 17h1" /></>,
  chat: <path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1" />,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3.5 6.5 8.5 6.5 8.5-6.5" /></>,
  lightbulb: <><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3" /></>,
  team: <><circle cx="12" cy="7" r="3" /><circle cx="5" cy="10" r="2.2" /><circle cx="19" cy="10" r="2.2" /><path d="M7 20c.4-3.3 2.4-5 5-5s4.6 1.7 5 5M1.5 19c.3-2 1.5-3.2 3.5-3.2M22.5 19c-.3-2-1.5-3.2-3.5-3.2" /></>,
  building: <><path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M2 21h20" /><path d="M8 8h3M8 12h3M8 16h3" /></>,
  door: <><path d="M5 21V4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v17M3 21h18" /><path d="M15 12h.01" /></>,
  car: <><path d="M5 17H3v-5l2-5h14l2 5v5h-2" /><path d="M3 12h18" /><circle cx="7.5" cy="17" r="2" /><circle cx="16.5" cy="17" r="2" /><path d="M9.5 17h5" /></>,
  equipment: <><rect x="3" y="7" width="18" height="12" rx="2" /><path d="M8 7V5h8v2M3 12h18M10 12v2h4v-2" /></>,
  box: <><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z" /><path d="m3 7.5 9 4.5 9-4.5M12 12v9M7.5 5.3l9 4.5" /></>,
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  gear: <><circle cx="12" cy="12" r="3.2" /><path d="M10.3 2.5h3.4l.5 2.6 2 .9 2.2-1.5 2.4 2.4-1.5 2.2.9 2 2.6.5v3.4l-2.6.5-.9 2 1.5 2.2-2.4 2.4-2.2-1.5-2 .9-.5 2.6h-3.4l-.5-2.6-2-.9-2.2 1.5-2.4-2.4 1.5-2.2-.9-2-2.6-.5v-3.4l2.6-.5.9-2-1.5-2.2 2.4-2.4 2.2 1.5 2-.9z" /></>,
  rocket: <><path d="M5 15c-1.5 1.2-2 4-2 6 2 0 4.8-.5 6-2" /><path d="M9 15l-3-3c2-6 7-9 14-9 0 7-3 12-9 14z" /><circle cx="14.5" cy="9.5" r="1.8" /><path d="M6 12H3l2.5-3.5H9M12 18v3l3.5-2.5V15" /></>,
  flag: <path d="M5 21V4M5 4h11l-2 4 2 4H5" />,
  target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>,
  headset: <><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><rect x="3" y="14" width="4" height="6" rx="1.5" /><rect x="17" y="14" width="4" height="6" rx="1.5" /><path d="M19 20c0 1-1 1.5-3 1.5h-2" /></>,
  'calendar-check': <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /><path d="m9 15 2 2 4-4" /></>,
  ticket: <><path d="M3 8a2 2 0 0 0 0 4v0a2 2 0 0 1 0 4v2h18v-2a2 2 0 0 1 0-4 2 2 0 0 0 0-4V6H3z" transform="translate(0 -1)" /><path d="M14 5v14" strokeDasharray="2 2" /></>,
  contract: <><path d="M6 3h9l4 4v14H6z" /><path d="M15 3v4h4M9 11h7M9 14h7M9 17h4" /><path d="m3 9 1.5 1.5L7 8" /></>,
  receipt: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  signature: <><path d="M3 17c2-4 4-9 6-9s-1 9 1 9 3-5 4-5 1 4 3 4 2-2 4-2" /><path d="M3 21h18" /></>,
  shift: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 13h3M13 13h3M8 16h3" /></>,
  'id-card': <><rect x="2" y="5" width="20" height="14" rx="2" /><circle cx="8" cy="11" r="2.2" /><path d="M5 16c.6-1.6 1.8-2.4 3-2.4s2.4.8 3 2.4M14 10h5M14 13h4" /></>,
  graduation: <><path d="m2 9 10-5 10 5-10 5z" /><path d="M6 11v5c3 2 9 2 12 0v-5M22 9v6" /></>,
  approve: <><circle cx="12" cy="12" r="9" /><path d="m8 12.5 3 3 5-6" /><path d="M12 3v2M12 19v2" /></>,
  sliders: <><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>,
  ticket2: <path d="M4 7h16v4a2 2 0 0 0 0 2v4H4v-4a2 2 0 0 0 0-4z" />,
  tent: <><path d="M3 20 12 4l9 16z" /><path d="M12 4v16M9 20l3-6 3 6" /></>,
  wrench: <path d="M14.5 6.5a4.5 4.5 0 0 0 5.6 5.6L21 13l-8 8a2.8 2.8 0 0 1-4-4l8-8-.9-.9a4.5 4.5 0 0 1-1.6-1.6" />,
  shield: <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />,
  leaf: <><path d="M5 19C5 10 10 5 20 4c0 10-5 15-14 15" /><path d="M5 19c3-5 6-8 10-10" /></>,
  heart: <path d="M12 20s-8-4.7-8-10.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 2.5C20 15.3 12 20 12 20" />,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
  truck: <><path d="M2 6h12v10H2zM14 10h4l3 3v3h-7" /><circle cx="6" cy="17.5" r="2" /><circle cx="17" cy="17.5" r="2" /></>,
  flask: <><path d="M9 3h6M10 3v6l-5.5 9.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3" /><path d="M7.5 15h9" /></>,
  holiday: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /><path d="m12 12.5.9 1.8 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2-1.5-1.4 2-.3z" /></>,
  milestone: <path d="M12 3 21 12 12 21 3 12z" />,
  dependency: <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M8.5 6H14a3 3 0 0 1 3 3v6.5" /></>,
  pen: <path d="M3 21l3-1 12-12-2-2L4 18zM14 4l2-2 4 4-2 2" />,
  note: <><path d="M4 4h16v11l-5 5H4z" /><path d="M15 20v-5h5" /></>,
  text: <path d="M5 6V4h14v2M12 4v16M9 20h6" />,
  square: <rect x="4" y="4" width="16" height="16" rx="2" />,
  circle: <circle cx="12" cy="12" r="8.5" />,
  hand: <><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12" /><path d="M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.8-2.4L3 15.5a1.6 1.6 0 0 1 2.5-2l2.5 2" /></>,
  mouse: <><rect x="6" y="3" width="12" height="18" rx="6" /><path d="M12 7v4" /></>,
  keyboard: <><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></>,
  database: <><ellipse cx="12" cy="5.5" rx="8" ry="3" /><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  server: <><rect x="3" y="3" width="18" height="8" rx="2" /><rect x="3" y="13" width="18" height="8" rx="2" /><path d="M7 7h.01M7 17h.01" /></>,
  hdd: <><path d="M3 13h18l-2.5-8h-13z" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 16.5h.01M11 16.5h6" /></>,
  scan: <><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><path d="M4 12h16" /></>,
  repeat: <><path d="M17 2l4 4-4 4" /><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4" /><path d="M21 13v2a3 3 0 0 1-3 3H3" /></>,
  location: <><path d="M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12" /><circle cx="12" cy="9" r="2.5" /></>,
  euro: <><path d="M18 6.5A7 7 0 1 0 18 17.5" /><path d="M4 10h10M4 14h10" /></>,
  camera: <><path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1" /><circle cx="12" cy="13" r="3.5" /></>,
  pin: <><path d="M12 17v5" /><path d="M8 3h8l-1 6 3 4H6l3-4z" /></>,
  dot: <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />,
  play: <path d="M7 4.5v15l12.5-7.5z" />,
  'circle-dashed': <circle cx="12" cy="12" r="8.5" strokeDasharray="3 3" />,
};

/** Für Projekte und Teams auswählbare Symbole */
export const PICKABLE_ICONS = [
  'rocket', 'gear', 'cube', 'assembly', 'factory', 'bolt', 'box', 'truck', 'building', 'wrench', 'tools', 'cad', 'drawing',
  'flask', 'target', 'flag', 'shield', 'leaf', 'globe', 'heart', 'lightbulb', 'chart', 'users', 'team', 'folder', 'car', 'door', 'equipment',
];

export type IconName = keyof typeof P;
export const ICON_NAMES = Object.keys(P);
export const isIconName = (n: string | null | undefined): n is string => Boolean(n && n in P);

export function Icon({ name, size = 16, className, style, title, strokeWidth = 1.75 }: { name: string; size?: number; className?: string; style?: CSSProperties; title?: string; strokeWidth?: number }) {
  const body = P[name] ?? P.circle;
  return (
    <svg className={`icon ${className ?? ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      {body}
    </svg>
  );
}

/** Projekt- oder Team-Symbol mit Farbe (gespeichert als "name" oder "name:#farbe") */
export function EntityIcon({ value, size = 16, fallback = 'folder' }: { value?: string | null; size?: number; fallback?: string }) {
  const [name, color] = (value ?? '').split(':');
  return <Icon name={isIconName(name) ? name! : fallback} size={size} style={color ? { color } : undefined} />;
}

export const PICKABLE_COLORS = ['', '#4f46e5', '#3b82f6', '#0ea5e9', '#14b8a6', '#5a8f6a', '#c98a12', '#ea580c', '#d9534f', '#db2777', '#7c3aed', '#64748b'];

/** Auswahl aus Symbol und Farbe für Projekte und Teams */
export function IconPicker({ value, onChange, extra }: { value?: string | null; onChange: (v: string) => void; extra?: string[] }) {
  const [name0, color0] = (value ?? '').split(':');
  const name = isIconName(name0) ? name0! : 'folder';
  const color = color0 ?? '';
  const emit = (n: string, c: string) => onChange(c ? `${n}:${c}` : n);
  return (
    <div className="icon-pick">
      <div className="icon-pick-grid">
        {(extra ?? PICKABLE_ICONS).filter(isIconName).map((n) => (
          <button type="button" key={n} className={n === name ? 'active' : ''} onClick={() => emit(n, color)} title={n} style={n === name && color ? { color } : undefined}>
            <Icon name={n} size={18} />
          </button>
        ))}
      </div>
      <div className="icon-pick-colors">
        {PICKABLE_COLORS.map((c) => (
          <button type="button" key={c || 'none'} className={`swatch ${c === color ? 'active' : ''}`} onClick={() => emit(name, c)}
            style={{ background: c || 'var(--text-3)' }} title={c ? c : 'Standardfarbe'} />
        ))}
      </div>
    </div>
  );
}
