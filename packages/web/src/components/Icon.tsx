import check from '../assets/ui/check.svg?raw';
import chevronDown from '../assets/ui/chevron-down.svg?raw';
import chevronLeft from '../assets/ui/chevron-left.svg?raw';
import chevronRight from '../assets/ui/chevron-right.svg?raw';
import circleCheck from '../assets/ui/circle-check.svg?raw';
import clock from '../assets/ui/clock.svg?raw';
import close from '../assets/ui/close.svg?raw';
import folder from '../assets/ui/folder.svg?raw';
import gitBranch from '../assets/ui/git-branch.svg?raw';
import layers from '../assets/ui/layers.svg?raw';
import monitor from '../assets/ui/monitor.svg?raw';
import pin from '../assets/ui/pin.svg?raw';
import plus from '../assets/ui/plus.svg?raw';
import search from '../assets/ui/search.svg?raw';
import server from '../assets/ui/server.svg?raw';
import settings from '../assets/ui/settings.svg?raw';
import spinner from '../assets/ui/spinner.svg?raw';
import terminal from '../assets/ui/terminal.svg?raw';
import x from '../assets/ui/x.svg?raw';

// Herdr's own UI glyphs (Lucide, ISC) from its workspace-chrome mod, plus a few more Lucide shapes drawn the same way.
const lucide = (body: string, width = 2) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICONS = {
  'chevron-down': chevronDown,
  'chevron-left': chevronLeft,
  'chevron-right': chevronRight,
  check,
  'circle-check': circleCheck,
  clock,
  close,
  folder,
  'git-branch': gitBranch,
  layers,
  monitor,
  pin,
  plus,
  search,
  server,
  settings,
  spinner,
  terminal,
  x,
  bell: lucide(
    '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
    1.75,
  ),
  keyboard: lucide(
    '<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>',
    1.75,
  ),
  send: lucide('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>', 2.25),
  expand: lucide('<path d="m15 3 6 0 0 6"/><path d="M9 21 3 21 3 15"/><path d="M21 3 14 10"/><path d="M3 21 10 14"/>', 1.75),
  collapse: lucide('<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="m14 10 7-7"/><path d="m3 21 7-7"/>', 1.75),
  message: lucide('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', 1.75),
  'zoom-in': lucide('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M11 8v6"/><path d="M8 11h6"/>', 1.75),
  'zoom-out': lucide('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M8 11h6"/>', 1.75),
  fit: lucide('<path d="m18 8 4 4-4 4"/><path d="m6 8-4 4 4 4"/><path d="M2 12h20"/>', 1.75),
  offline: lucide(
    '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
    1.75,
  ),
  key: lucide(
    '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
    1.75,
  ),
  'check-all': lucide('<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/>', 1.75),
  'arrow-down': lucide('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>', 2),
  copy: lucide(
    '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    1.75,
  ),
  'file-text': lucide(
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    1.75,
  ),
  pencil: lucide(
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    1.75,
  ),
  'file-plus': lucide(
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6"/><path d="M12 18v-6"/>',
    1.75,
  ),
  globe: lucide('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>', 1.75),
  bot: lucide(
    '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
    1.75,
  ),
  'list-checks': lucide(
    '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
    1.75,
  ),
  'circle-help': lucide('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>', 1.75),
  wrench: lucide(
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    1.75,
  ),
  alert: lucide(
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    1.75,
  ),
  sparkles: lucide(
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
    1.75,
  ),
  mail: lucide('<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>', 1.75),
  history: lucide('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>', 1.75),
  ban: lucide('<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>', 1.75),
  'corner-down-right': lucide('<polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>', 1.75),
  stop: lucide('<rect x="6" y="6" width="12" height="12" rx="2"/>', 1.75),
  'scan-text': lucide(
    '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8h8"/><path d="M7 12h10"/><path d="M7 16h6"/>',
    1.75,
  ),
  locate: lucide(
    '<path d="M2 12h3"/><path d="M19 12h3"/><path d="M12 2v3"/><path d="M12 19v3"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/>',
    1.75,
  ),
  'text-size': lucide(
    '<path d="M21 14h-5"/><path d="M16 16v-3.5a2.5 2.5 0 0 1 5 0V16"/><path d="M4.5 13h6"/><path d="m3 16 4.5-9 4.5 9"/>',
    1.75,
  ),
  minus: lucide('<path d="M5 12h14"/>', 2),
  'wrap-text': lucide('<path d="m16 16-2 2 2 2"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><path d="M3 18h7"/><path d="M3 6h18"/>', 1.75),
  sun: lucide(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    1.75,
  ),
  moon: lucide('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>', 1.75),
  refresh: lucide(
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    1.75,
  ),
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 14, className, spin }: { name: IconName; size?: number; className?: string; spin?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`icon${spin ? ' spin' : ''}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: our own bundled SVG files, no user content.
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}
