import type { SpaceView } from '@herdr-mobile/protocol';

// Herdr's avatar colors per stored color name (spaces mod `MARK`): one strong color per hue.
const MARK: Record<string, string> = {
  ansi6: '#22a99a',
  ansi3: '#e3814f',
  ansi4: '#5b8def',
  ansi5: '#8b7cf6',
  ansi2: '#3fae6a',
  ansi1: '#d9649a',
};
const PALETTE = ['ansi6', 'ansi3', 'ansi4', 'ansi5', 'ansi2', 'ansi1'];

export function spaceColor(space: SpaceView): string {
  const c = space.color ?? PALETTE[(space.index - 1) % PALETTE.length] ?? 'ansi6';
  if (c.startsWith('#')) return c;
  return MARK[c] ?? `var(--${c})`;
}

/** The colored letter tile in front of a space's name. */
export function SpaceTile({ space, size = 18 }: { space: SpaceView; size?: number }) {
  const letter = [...space.name][0]?.toUpperCase() ?? '?';
  return (
    <span
      className="space-tile"
      style={{ width: size, height: size, backgroundColor: spaceColor(space), fontSize: size * 0.58, borderRadius: size * 0.28 }}
    >
      {letter}
    </span>
  );
}
