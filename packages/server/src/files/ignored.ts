import { spawn } from 'node:child_process';

export interface IgnoreOptions {
  /** The git program (test hook). */
  git?: string;
  /** Give up after this long (then nothing is ignored). */
  timeoutMs?: number;
}

/** Most entries asked about at once (a listing page is at most FS_PAGE). */
export const IGNORE_MAX = 1000;
const OUTPUT_MAX = 1024 * 1024;

const inGitDir = (dir: string) => dir.split('/').includes('.git');

/**
 * Which of a folder's entries git ignores (every .gitignore, .git/info/exclude and core.excludesFile; tracked
 * files never; entries inside an ignored folder too, as git sees them). `.git` itself and everything in it
 * count as ignored. Any failure (not in a repo, no git, too slow, too many entries) means none: greying is
 * a hint, never an error.
 */
export async function gitIgnored(
  dir: string,
  entries: ReadonlyArray<{ name: string; dir: boolean }>,
  opts: IgnoreOptions = {},
): Promise<Set<string>> {
  if (entries.length === 0 || entries.length > IGNORE_MAX) return new Set();
  if (inGitDir(dir)) return new Set(entries.map((e) => e.name));
  const out = new Set<string>(entries.filter((e) => e.name === '.git').map((e) => e.name));
  const asked = entries.filter((e) => e.name !== '.git');
  if (asked.length === 0) return out;
  const found = await checkIgnore(
    dir,
    asked.map((e) => (e.dir ? `${e.name}/` : e.name)),
    opts,
  );
  for (const p of found) out.add(p.endsWith('/') ? p.slice(0, -1) : p);
  return out;
}

/** `git check-ignore --stdin -z` in `dir` over `paths` (relative to it): the ones it prints. */
function checkIgnore(dir: string, paths: string[], opts: IgnoreOptions): Promise<string[]> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: string[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    // A clean environment for git's own variables, so the bridge's never point it at another repo.
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
    for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CEILING_DIRECTORIES|COMMON_DIR)$/.test(k)) delete env[k];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.git ?? 'git', ['--no-optional-locks', 'check-ignore', '--stdin', '-z'], {
        cwd: dir,
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      resolve([]);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish([]);
    }, opts.timeoutMs ?? 2000);
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout?.on('data', (b: Buffer) => {
      size += b.length;
      if (size > OUTPUT_MAX) {
        child.kill('SIGKILL');
        finish([]);
      } else chunks.push(b);
    });
    child.on('error', () => finish([]));
    // 0: some ignored, 1: none, anything else (128: not a repo...): treat as none.
    child.on('close', (code) => finish(code === 0 ? Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean) : []));
    child.stdin?.on('error', () => {});
    child.stdin?.end(paths.map((p) => `${p}\0`).join(''));
  });
}
