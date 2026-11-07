import type { Program } from '../lib/programs';

/**
 * A program's icon as Herdr draws it: a one-color glyph in the text color, or
 * the picture itself. `tile`: on its colored chip, as Herdr's terminals bar.
 */
export function ProgramIcon({ program, size = 16, tile = false }: { program: Program; size?: number; tile?: boolean }) {
  const glyph = program.icon ? (
    program.tint ? (
      <span
        className="prog-glyph"
        style={{
          width: size,
          height: size,
          WebkitMaskImage: `url(${program.icon})`,
          maskImage: `url(${program.icon})`,
          ...(tile && program.color ? { backgroundColor: program.color } : {}),
        }}
      />
    ) : (
      <img className="prog-img" src={program.icon} width={size} height={size} alt="" draggable={false} />
    )
  ) : (
    <span className="prog-glyph" style={{ width: size, height: size }} />
  );
  if (!tile) return <span className="prog">{glyph}</span>;
  return (
    <span className="prog-tile" style={{ backgroundColor: program.tile ?? 'var(--raised)' }}>
      {glyph}
    </span>
  );
}
