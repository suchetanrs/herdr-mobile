import type { ITheme } from '@xterm/xterm';

/** herdr-app settings.rs palettes, as xterm.js themes (graphite: dark, paper: light). */
const GRAPHITE = {
  background: '#17191d',
  foreground: '#d2d4d9',
  selection: '#394454',
  cursor: '#d2d4d9',
  ansi: [
    '#45484f',
    '#dc8c95',
    '#a6bd91',
    '#d8be87',
    '#96b2d7',
    '#b5a2ce',
    '#8cbdc3',
    '#d2d4d9',
    '#818793',
    '#f0a5ad',
    '#bad5a2',
    '#ead2a1',
    '#b0cbef',
    '#cbb7e6',
    '#a4d5db',
    '#f0f0f2',
  ],
};
const PAPER = {
  background: '#ffffff',
  foreground: '#25272c',
  selection: '#cfdcf5',
  cursor: '#25272c',
  ansi: [
    '#25272c',
    '#c62a2a',
    '#1a7f37',
    '#8f5d00',
    '#1f62d0',
    '#7a45c8',
    '#0f6f74',
    '#5f6068',
    '#7b7e87',
    '#d1242f',
    '#1f883d',
    '#9a6700',
    '#0969da',
    '#8250df',
    '#1b7c83',
    '#111214',
  ],
};

const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;

export function terminalTheme(light: boolean): ITheme {
  const p = light ? PAPER : GRAPHITE;
  const t: ITheme = {
    background: p.background,
    foreground: p.foreground,
    cursor: p.cursor,
    cursorAccent: p.background,
    selectionBackground: p.selection,
    scrollbarSliderBackground: light ? '#00000026' : '#ffffff24',
    scrollbarSliderHoverBackground: light ? '#00000040' : '#ffffff38',
    scrollbarSliderActiveBackground: light ? '#00000052' : '#ffffff48',
  };
  const rec = t as Record<string, string>;
  NAMES.forEach((n, i) => {
    rec[n] = p.ansi[i] as string;
    rec[`bright${n[0]?.toUpperCase()}${n.slice(1)}`] = p.ansi[i + 8] as string;
  });
  return t;
}

/** The raw palette (history rows drawn outside xterm use the same colors). */
export function terminalColors(light: boolean): { background: string; foreground: string; ansi: readonly string[] } {
  return light ? PAPER : GRAPHITE;
}
