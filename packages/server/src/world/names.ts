import fs from 'node:fs';
import path from 'node:path';

/** A folder as a name: its last part, `~` for the home folder (model.rs `folder_name`). */
export function folderName(full: string, home: string): string {
  const p = full.replace(/[/\\]+$/, '');
  const h = home.replace(/[/\\]+$/, '');
  if (full === '' || p === h) return '~';
  if (p === '') return full.slice(0, 1);
  const parts = p.split(/[/\\]/).filter((s) => s !== '');
  return parts[parts.length - 1] ?? p;
}

/** Agent names as the desktop shows them (window.rs `agent_name`). */
export function agentName(app: string): string {
  switch (app) {
    case 'claude':
    case 'claude-code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'pi':
      return 'Pi';
    case 'pig':
      return 'PiG';
    case 'opencode':
      return 'OpenCode';
    case 'cursor':
    case 'cursor-agent':
      return 'Cursor';
    case 'amp':
      return 'Amp';
    case 'grok':
      return 'Grok';
    case 'dsh-tui':
      return 'DeepSeek Harness';
    default:
      return app;
  }
}

/**
 * The checkout a folder is in (a worktree's own folder; outside git the folder
 * itself), the way Herdr names unnamed spaces. Cached: it's on the hot path of
 * every world rebuild, and checkouts rarely move.
 */
export class CheckoutResolver {
  private cache = new Map<string, { top: string; at: number }>();
  constructor(
    private readonly ttlMs = 30_000,
    private readonly exists: (p: string) => boolean = fs.existsSync,
  ) {}

  top(folder: string): string {
    const now = Date.now();
    const hit = this.cache.get(folder);
    if (hit && now - hit.at < this.ttlMs) return hit.top;
    let top = folder;
    let dir = folder;
    for (let i = 0; i < 64 && dir; i++) {
      if (this.exists(path.join(dir, '.git'))) {
        top = dir;
        break;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(folder, { top, at: now });
    return top;
  }
}
