import fs from 'node:fs';
import path from 'node:path';

/** A programs.json entry, the parts the bridge uses (programs.rs `Entry`). */
export interface Program {
  name?: string;
  /** Other process names (or agents' 7501 app names) for this entry. */
  match?: string[];
  /** How to start it, for an agent people can start from a menu. */
  run?: string[];
}

export type ProgramTable = ReadonlyMap<string, Program>;

/**
 * herdr-app's built-in table (defaults/programs.json, v0.1.14: name, match, run). The web app has
 * the whole file in packages/web/src/lib/programs.json and a test keeps the two equal.
 */
export const BUILT_IN_PROGRAMS: Readonly<Record<string, Program>> = {
  claude: { name: 'Claude Code', match: ['claude-code'], run: ['claude'] },
  codex: { name: 'Codex', run: ['codex', '--no-daemon'] },
  pi: { name: 'Pi', run: ['pi'] },
  pig: { name: 'PiG', run: ['pig'] },
  opencode: { name: 'OpenCode', run: ['opencode'] },
  cursor: { name: 'Cursor', match: ['cursor-agent'], run: ['cursor-agent'] },
  copilot: { name: 'Copilot', match: ['github-copilot'], run: ['copilot'] },
  amp: { name: 'Amp', run: ['amp'] },
  grok: { name: 'Grok', match: ['grok-build'], run: ['grok'] },
  'dsh-tui': { name: 'DeepSeek Harness', run: ['dsh-tui'] },
  antigravity: { name: 'Antigravity', match: ['agy'], run: ['agy'] },
  kimi: { name: 'Kimi', match: ['kimi-code', 'kimicodecli'], run: ['kimi'] },
  kiro: { name: 'Kiro', match: ['kiro-cli'], run: ['kiro-cli'] },
  hermes: { name: 'Hermes', run: ['hermes'] },
  mastracode: { name: 'Mastra Code' },
  qoder: { name: 'Qoder', match: ['qodercli'], run: ['qodercli'] },
  muse: { name: 'Muse' },
  crush: { name: 'Crush', run: ['crush'] },
  'command-code': { name: 'Command Code' },
  'prime-agent': { name: 'Prime' },
  gemini: { name: 'Gemini', run: ['gemini'] },
  ollama: { name: 'Ollama' },
  agent: { name: 'Agent' },
  shell: { name: 'Shell' },
  program: { name: 'Program' },
  vim: { name: 'Vim', match: ['vi', 'view'] },
  nvim: { name: 'Neovim' },
  hx: { name: 'Helix', match: ['helix'] },
  emacs: { name: 'Emacs' },
  nano: { name: 'nano' },
  less: { name: 'Pager', match: ['more', 'man', 'bat'] },
  lazygit: { name: 'Git Changes', match: ['gitui', 'tig'] },
  git: { name: 'Git' },
  gh: { name: 'GitHub' },
  glab: { name: 'GitLab' },
  htop: { name: 'Activity', match: ['btop', 'top', 'btm', 'glances'] },
  ssh: { name: 'SSH', match: ['mosh', 'et'] },
  tmux: { name: 'tmux', match: ['zellij', 'screen'] },
  rg: { name: 'Search', match: ['grep', 'fzf', 'fd', 'find'] },
  curl: { name: 'curl', match: ['wget', 'http', 'httpie', 'xh'] },
  ffmpeg: { name: 'FFmpeg' },
  make: { name: 'Make', match: ['just', 'ninja'] },
  cmake: { name: 'CMake' },
  jupyter: { name: 'Jupyter' },
  node: { name: 'Node' },
  bun: { name: 'Bun', match: ['bunx'] },
  deno: { name: 'Deno' },
  python: { name: 'Python', match: ['python3', 'ipython', 'pip', 'pip3'] },
  uv: { name: 'uv', match: ['uvx'] },
  poetry: { name: 'Poetry' },
  ruby: { name: 'Ruby', match: ['irb', 'bundle', 'gem', 'rails'] },
  go: { name: 'Go' },
  cargo: { name: 'Cargo', match: ['rustc', 'rustup'] },
  java: { name: 'Java', match: ['javac', 'jshell'] },
  gradle: { name: 'Gradle', match: ['gradlew'] },
  mvn: { name: 'Maven', match: ['mvnw'] },
  dotnet: { name: '.NET' },
  php: { name: 'PHP', match: ['artisan'] },
  composer: { name: 'Composer' },
  iex: { name: 'Elixir', match: ['elixir', 'mix'] },
  erl: { name: 'Erlang' },
  ghci: { name: 'Haskell', match: ['ghc', 'stack', 'cabal'] },
  ocaml: { name: 'OCaml', match: ['utop', 'dune', 'opam'] },
  zig: { name: 'Zig' },
  swift: { name: 'Swift' },
  kotlin: { name: 'Kotlin', match: ['kotlinc'] },
  scala: { name: 'Scala', match: ['sbt'] },
  lua: { name: 'Lua', match: ['luajit'] },
  perl: { name: 'Perl' },
  R: { name: 'R', match: ['Rscript'] },
  julia: { name: 'Julia' },
  dart: { name: 'Dart' },
  flutter: { name: 'Flutter' },
  tsc: { name: 'TypeScript', match: ['tsx', 'ts-node'] },
  npm: { name: 'npm', match: ['npx'] },
  pnpm: { name: 'pnpm' },
  yarn: { name: 'Yarn' },
  vite: { name: 'Vite' },
  next: { name: 'Next.js' },
  astro: { name: 'Astro' },
  nuxt: { name: 'Nuxt', match: ['nuxi'] },
  turbo: { name: 'Turborepo' },
  webpack: { name: 'webpack' },
  esbuild: { name: 'esbuild' },
  vitest: { name: 'Vitest' },
  jest: { name: 'Jest' },
  pytest: { name: 'pytest' },
  eslint: { name: 'ESLint' },
  prettier: { name: 'Prettier' },
  biome: { name: 'Biome' },
  ruff: { name: 'Ruff' },
  expo: { name: 'Expo' },
  tauri: { name: 'Tauri' },
  electron: { name: 'Electron' },
  prisma: { name: 'Prisma' },
  supabase: { name: 'Supabase' },
  'django-admin': { name: 'Django' },
  flask: { name: 'Flask' },
  fastapi: { name: 'FastAPI' },
  psql: { name: 'PostgreSQL', match: ['postgres'] },
  mysql: { name: 'MySQL', match: ['mariadb'] },
  sqlite3: { name: 'SQLite', match: ['sqlite'] },
  'redis-cli': { name: 'Redis', match: ['redis-server'] },
  mongosh: { name: 'MongoDB', match: ['mongo'] },
  docker: { name: 'Docker', match: ['docker-compose', 'lazydocker'] },
  podman: { name: 'Podman' },
  kubectl: { name: 'Kubernetes', match: ['k9s', 'minikube', 'kind'] },
  helm: { name: 'Helm' },
  terraform: { name: 'Terraform', match: ['tofu'] },
  ansible: { name: 'Ansible', match: ['ansible-playbook'] },
  gcloud: { name: 'Google Cloud' },
  vercel: { name: 'Vercel' },
  netlify: { name: 'Netlify' },
  wrangler: { name: 'Cloudflare' },
  fly: { name: 'Fly.io', match: ['flyctl'] },
  caddy: { name: 'Caddy' },
  nginx: { name: 'nginx' },
  nix: { name: 'Nix', match: ['nix-shell', 'nixos-rebuild'] },
  brew: { name: 'Homebrew' },
  apt: { name: 'apt', match: ['apt-get', 'dpkg'] },
  dnf: { name: 'dnf', match: ['rpm-ostree'] },
  pacman: { name: 'pacman', match: ['yay', 'paru'] },
};

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
const optional = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || v === null || ok(v);

/** Would serde read this entry (programs.rs `Entry`)? A wrong type anywhere makes Herdr refuse the whole file. */
function entryOk(e: unknown): e is Record<string, unknown> {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  const o = e as Record<string, unknown>;
  const str = (v: unknown) => typeof v === 'string';
  return (
    optional(o.name, str) &&
    optional(o.icon, str) &&
    optional(o.tile, str) &&
    optional(o.color, str) &&
    optional(o.tint, (v) => typeof v === 'boolean') &&
    (o.match === undefined || strings(o.match)) &&
    (o.run === undefined || strings(o.run))
  );
}

/** The person's programs.json, or null when it is missing or Herdr would refuse it. */
function readMine(herdrAppDir: string): Record<string, Record<string, unknown>> | null {
  let mine: unknown;
  try {
    mine = JSON.parse(fs.readFileSync(path.join(herdrAppDir, 'programs.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!mine || typeof mine !== 'object' || Array.isArray(mine)) return null;
  const m = mine as Record<string, unknown>;
  if (!(m.shells === undefined || strings(m.shells)) || !(m.interpreters === undefined || strings(m.interpreters))) return null;
  if (m.programs === undefined) return {};
  if (!m.programs || typeof m.programs !== 'object' || Array.isArray(m.programs)) return null;
  const programs = m.programs as Record<string, unknown>;
  return Object.values(programs).every(entryOk) ? (programs as Record<string, Record<string, unknown>>) : null;
}

/**
 * The built-in table with the person's `programs.json` (herdr-app's home, read only) on top,
 * entry by entry (programs.rs `load` / `Entry::over`); keys in the order Herdr walks them.
 */
export function loadPrograms(herdrAppDir: string | null): ProgramTable {
  const table = new Map<string, Program>(Object.entries(BUILT_IN_PROGRAMS).map(([k, e]) => [k, { ...e }]));
  const mine = herdrAppDir ? readMine(herdrAppDir) : null;
  for (const [key, e] of Object.entries(mine ?? {})) {
    const was = table.get(key) ?? {};
    const name = typeof e.name === 'string' ? e.name : was.name;
    const match = strings(e.match) && e.match.length > 0 ? [...e.match] : was.match;
    const run = strings(e.run) && e.run.length > 0 ? [...e.run] : was.run;
    table.set(key, { ...(name !== undefined ? { name } : {}), ...(match ? { match } : {}), ...(run ? { run } : {}) });
  }
  // A BTreeMap in Herdr: keys in byte order, which decides who wins a shared match name.
  return new Map([...table].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** programs.rs `find`: the entry by key, else by one of its match names (case-insensitive). */
export function findProgram(table: ProgramTable, name: string): [string, Program] | null {
  const lower = name.toLowerCase();
  for (const [k, e] of table) if (k === name || k.toLowerCase() === lower) return [k, e];
  for (const [k, e] of table) if (e.match?.some((a) => a === name || a.toLowerCase() === lower)) return [k, e];
  return null;
}

/** programs.rs `name`: how Herdr calls an agent, from its 7501 `app` ("Kiro"), else the `app`. */
export function programName(table: ProgramTable, app: string): string {
  const f = findProgram(table, app);
  return f ? (f[1].name ?? f[0]) : app;
}

/**
 * Agent names as Herdr shows them, following the person's programs.json as Herdr does when it
 * changes (its file watch; here at most one stat per `checkMs`).
 */
export class ProgramNames {
  private table: ProgramTable;
  private mtime: number | null;
  private checkedAt: number;

  constructor(
    private readonly herdrAppDir: string | null,
    private readonly checkMs = 2_000,
    private readonly now: () => number = Date.now,
  ) {
    this.mtime = this.stat();
    this.table = loadPrograms(herdrAppDir);
    this.checkedAt = now();
  }

  name(app: string): string {
    if (this.now() - this.checkedAt >= this.checkMs) {
      this.checkedAt = this.now();
      const m = this.stat();
      if (m !== this.mtime) {
        this.mtime = m;
        this.table = loadPrograms(this.herdrAppDir);
      }
    }
    return programName(this.table, app);
  }

  private stat(): number | null {
    if (!this.herdrAppDir) return null;
    try {
      return fs.statSync(path.join(this.herdrAppDir, 'programs.json')).mtimeMs;
    } catch {
      return null;
    }
  }
}

/** Built-ins only (tests, and anything without a herdr-app home). */
export const builtInNames = new ProgramNames(null);
