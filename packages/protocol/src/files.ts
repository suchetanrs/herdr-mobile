/*
 * The file browser (REST, read only): `GET /api/fs/list?path=&hidden=&offset=` lists a folder (or describes a
 * file, so a typed file path can be downloaded), `GET /api/fs/download?path=` sends a file as an attachment.
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
  code: 'bad-path' | 'not-found' | 'denied' | 'private' | 'not-regular' | 'busy';
}

/** Entries per page of a listing. */
export const FS_PAGE = 500;
/** Entries read from one folder at most. */
export const FS_SCAN_MAX = 20_000;
/** Longest path accepted. */
export const FS_PATH_MAX = 4096;
