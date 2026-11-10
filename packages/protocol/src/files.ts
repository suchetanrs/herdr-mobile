/*
 * The file browser (REST, read only): `GET /api/fs/list?path=&hidden=&offset=` lists a folder (or describes a
 * file, so a typed file path can be downloaded), `GET /api/fs/download?path=` sends a file as an attachment,
 * `GET /api/fs/view?path=` sends a viewable one (see VIEWABLE) inline, for the in-app viewer.
 */

/** What an entry is (a symbolic link counts as what it points to; `link` says it is one). */
export type FsKind = 'dir' | 'file' | 'other';

export interface FsEntry {
  name: string;
  kind: FsKind;
  /** A symbolic link (to `kind`; a broken one is `other`). */
  link: boolean;
  /** Bytes, for files. */
  size: number | null;
  /** Last modified, ms since the epoch. */
  mtime: number | null;
}

export interface FsListing {
  kind: 'dir';
  /** The folder's real path (symlinks resolved). */
  path: string;
  /** Its parent folder; null at `/`. */
  parent: string | null;
  /** The home folder (for `~` in paths). */
  home: string;
  /** Folders first, then files, by name; one page of them. */
  entries: FsEntry[];
  /** Entries in the folder (as filtered: hidden ones only when asked for). */
  total: number;
  /** Index of `entries[0]` among all of them. */
  offset: number;
  /** Hidden entries (`.name`) left out (0 when they were asked for). */
  hidden: number;
  /** The folder has more than FS_SCAN_MAX entries; only the first ones read were listed. */
  truncated: boolean;
}

/** The typed path is a file: download it. */
export interface FsFile {
  kind: 'file';
  path: string;
  name: string;
  size: number;
  mtime: number;
  /** A regular file that can be downloaded (not a device, socket or pipe). */
  downloadable: boolean;
}

export type FsLookup = FsListing | FsFile;

export interface FsError {
  error: string;
  code: 'bad-path' | 'not-found' | 'denied' | 'private' | 'not-regular' | 'busy' | 'not-viewable' | 'too-big';
}

/** Entries per page of a listing. */
export const FS_PAGE = 500;
/** Entries read from one folder at most. */
export const FS_SCAN_MAX = 20_000;
/** Longest path accepted. */
export const FS_PATH_MAX = 4096;

/** How the in-app viewer shows a file. */
export type ViewKind = 'video' | 'audio' | 'image' | 'pdf' | 'markdown';

/**
 * The only files the bridge sends inline, by extension (lower case), with the type it sends them as. The
 * bridge also checks the first bytes; nothing else (HTML, SVG, scripts...) is ever sent inline.
 */
export const VIEWABLE: Readonly<Record<string, { kind: ViewKind; type: string }>> = {
  mp4: { kind: 'video', type: 'video/mp4' },
  m4v: { kind: 'video', type: 'video/mp4' },
  mov: { kind: 'video', type: 'video/quicktime' },
  mp3: { kind: 'audio', type: 'audio/mpeg' },
  m4a: { kind: 'audio', type: 'audio/mp4' },
  aac: { kind: 'audio', type: 'audio/aac' },
  wav: { kind: 'audio', type: 'audio/wav' },
  flac: { kind: 'audio', type: 'audio/flac' },
  ogg: { kind: 'audio', type: 'audio/ogg' },
  opus: { kind: 'audio', type: 'audio/ogg' },
  png: { kind: 'image', type: 'image/png' },
  jpg: { kind: 'image', type: 'image/jpeg' },
  jpeg: { kind: 'image', type: 'image/jpeg' },
  gif: { kind: 'image', type: 'image/gif' },
  webp: { kind: 'image', type: 'image/webp' },
  heic: { kind: 'image', type: 'image/heic' },
  heif: { kind: 'image', type: 'image/heif' },
  avif: { kind: 'image', type: 'image/avif' },
  bmp: { kind: 'image', type: 'image/bmp' },
  pdf: { kind: 'pdf', type: 'application/pdf' },
  md: { kind: 'markdown', type: 'text/plain; charset=utf-8' },
  markdown: { kind: 'markdown', type: 'text/plain; charset=utf-8' },
};

/** The viewer entry for a file name, or null (download it instead). */
export function viewableOf(name: string): { kind: ViewKind; type: string } | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(VIEWABLE, ext) ? (VIEWABLE[ext] ?? null) : null;
}

/** Largest Markdown file the viewer is sent (it renders it whole). */
export const FS_MARKDOWN_MAX = 2 * 1024 * 1024;
