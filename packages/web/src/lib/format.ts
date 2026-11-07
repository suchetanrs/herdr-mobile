/** "<1m", "4m", "8h", "3d", as Herdr's agents list. */
export function duration(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** A home folder as "~" (the bridge's home isn't sent, so any /home/<user> or /Users/<user>). */
export function folder(cwd: string | null | undefined): string {
  if (!cwd) return '';
  return cwd.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~');
}

/** Drops leading symbols (spinners, bullets) agents put in their titles. */
export function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
