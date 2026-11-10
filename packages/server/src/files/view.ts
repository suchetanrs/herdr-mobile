import { FS_TEXT_MAX, isTextKind, type ViewKind, viewableOf } from '@herdr-mobile/protocol';

/** Bytes read from the start of a file to check what it is (text: enough to tell a binary). */
export const SNIFF_BYTES = 8192;

/** Text: no NUL byte and valid UTF-8 (a character cut off at the end of the sniffed bytes is fine). */
export function looksLikeText(head: Buffer): boolean {
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}

const ascii = (head: Buffer, at: number, text: string) => head.subarray(at, at + text.length).toString('latin1') === text;
/** ISO base media (mp4, mov, m4a, heic, avif): a box type at offset 4. */
const isoBox = (head: Buffer, types: readonly string[]) => types.some((t) => ascii(head, 4, t));
/** MPEG audio frame sync (mp3) or ADTS (aac): 11 or 12 one bits. */
const frameSync = (head: Buffer, mask: number) => head.length >= 2 && head[0] === 0xff && ((head[1] ?? 0) & mask) === mask;

/** The first bytes each viewable extension must start with (Markdown: none, it is sent as plain text). */
const MAGIC: Readonly<Record<string, (head: Buffer) => boolean>> = {
  mp4: (h) => isoBox(h, ['ftyp']),
  m4v: (h) => isoBox(h, ['ftyp']),
  // Old QuickTime files can start with other atoms before `moov`.
  mov: (h) => isoBox(h, ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot']),
  m4a: (h) => isoBox(h, ['ftyp']),
  mp3: (h) => ascii(h, 0, 'ID3') || frameSync(h, 0xe0),
  aac: (h) => ascii(h, 0, 'ID3') || frameSync(h, 0xf0),
  wav: (h) => ascii(h, 0, 'RIFF') && ascii(h, 8, 'WAVE'),
  flac: (h) => ascii(h, 0, 'fLaC') || ascii(h, 0, 'ID3'),
  ogg: (h) => ascii(h, 0, 'OggS'),
  opus: (h) => ascii(h, 0, 'OggS'),
  png: (h) => h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,
  jpeg: (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,
  gif: (h) => ascii(h, 0, 'GIF87a') || ascii(h, 0, 'GIF89a'),
  webp: (h) => ascii(h, 0, 'RIFF') && ascii(h, 8, 'WEBP'),
  heic: (h) => isoBox(h, ['ftyp']),
  heif: (h) => isoBox(h, ['ftyp']),
  avif: (h) => isoBox(h, ['ftyp']),
  bmp: (h) => ascii(h, 0, 'BM'),
  pdf: (h) => ascii(h, 0, '%PDF-'),
  md: () => true,
  markdown: () => true,
};

export type ViewCheck =
  | { ok: true; kind: ViewKind; type: string }
  | { ok: false; status: 413 | 415; code: 'not-viewable' | 'too-big'; error: string };

/**
 * Whether a file may be sent inline: its extension is on the allowlist (VIEWABLE) AND its first bytes are
 * what that extension says (a page renamed `x.png` is refused; code must look like UTF-8 text); text only up
 * to FS_TEXT_MAX.
 */
export function checkViewable(name: string, size: number, head: Buffer): ViewCheck {
  const entry = viewableOf(name);
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  // An extension without a check here is refused (fails closed).
  const magic = entry?.kind === 'code' ? looksLikeText : entry && Object.hasOwn(MAGIC, ext) ? MAGIC[ext] : undefined;
  if (!entry || !magic?.(head)) {
    return { ok: false, status: 415, code: 'not-viewable', error: 'This file can’t be shown here; download it instead' };
  }
  if (isTextKind(entry.kind) && size > FS_TEXT_MAX) {
    return { ok: false, status: 413, code: 'too-big', error: 'This file is too big to show here; download it instead' };
  }
  return { ok: true, kind: entry.kind, type: entry.type };
}

/**
 * The Content-Security-Policy of an inline file, should it be opened as a page of its own: no scripts, no
 * plugins, nothing loaded, an opaque origin (`sandbox`). A PDF can't be sandboxed (browsers refuse to run
 * their PDF viewer in a sandboxed document), so it gets the rest, and may be framed by the app's viewer.
 */
export function viewCsp(kind: ViewKind): string {
  if (kind === 'pdf') {
    return "default-src 'none'; object-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
  }
  return "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
}
