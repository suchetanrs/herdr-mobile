import type {
  FolderCompletion,
  NewSpaceError,
  NewSpaceOptions,
  NewSpaceRequest,
  NewSpaceResult,
  NewTabResult,
  NewTabStart,
  SpaceSessions,
} from '@herdr-mobile/protocol';

/** An error the bridge sent back, with the field it belongs under. */
export class NewSpaceFailure extends Error {
  constructor(
    message: string,
    readonly field?: NewSpaceError['field'],
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<T> {
  let r: Response;
  try {
    r = await fetcher(path, {
      ...init,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: init.body ? { 'content-type': 'application/json' } : {},
    });
  } catch {
    throw new NewSpaceFailure('Can’t reach the bridge right now');
  }
  const body = (await r.json().catch(() => ({}))) as T & Partial<NewSpaceError>;
  if (!r.ok) throw new NewSpaceFailure(body.error ?? `The bridge said ${r.status}`, body.field);
  return body;
}

export const newSpaceOptions = (fetcher?: typeof fetch) => call<NewSpaceOptions>('/api/new-space', {}, fetcher);

export const completeFolder = (typed: string, fetcher?: typeof fetch) =>
  call<FolderCompletion>(`/api/folders?path=${encodeURIComponent(typed)}`, {}, fetcher).then((r) => r.entries);

export const createSpace = (req: NewSpaceRequest, fetcher?: typeof fetch) =>
  call<NewSpaceResult>('/api/spaces', { method: 'POST', body: JSON.stringify(req) }, fetcher);

/** A space's folder and the Claude sessions that can be resumed there. */
export const spaceSessions = (spaceId: string, fetcher?: typeof fetch) =>
  call<SpaceSessions>(`/api/spaces/${encodeURIComponent(spaceId)}/sessions`, {}, fetcher);

/** A new tab in an open space: the shell, Claude Code, or a resumed Claude session. */
export const addTab = (spaceId: string, start: NewTabStart, fetcher?: typeof fetch) =>
  call<NewTabResult>(`/api/spaces/${encodeURIComponent(spaceId)}/tabs`, { method: 'POST', body: JSON.stringify({ start }) }, fetcher);

/** The last part of a typed folder (what Herdr would name the space after). */
export function folderBase(typed: string): string {
  const t = typed.trim().replace(/\/+$/, '');
  if (t === '' || t === '~') return '~';
  return t.slice(t.lastIndexOf('/') + 1);
}
