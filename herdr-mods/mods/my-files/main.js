// A lazy file browser for the focused pane's folder. A click opens the file in its own
// Herdr tab (a `file-viewer` mod), or shows the tab already open for it; Cmd-click opens
// it in the system's default app.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, window, run, shared, setShared, notify, openOverlay } from "herdr";

// shared(OPEN): { "<on>|<file>": { tab, root } }, root being the tree's folder when the
// file was opened. Older entries are a bare tab id.
// shared(MENU): the action chosen in the `file-menu` popup, { id, context, action, path }.
const VIEWER = "file-viewer", OPEN = "file-viewer:open", MENU = "my-files:menu";
let last = null;

const docKey = (file, on) => `${on ?? ""}|${file}`;
const tabOf = (entry) => typeof entry === "string" ? entry : entry?.tab;
const hasViewer = (tab) => panes().some(p => p.tab === tab && p.mod === VIEWER);
const openIn = (tab) => tab ? Object.entries(shared(OPEN) ?? {}).find(([, v]) => tabOf(v) === tab) : null;
const viewing = (tab) => openIn(tab)?.[0] ?? null;

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  // A file tab has no folder of its own: show the one its file was opened from.
  const opened = pane?.mod === VIEWER && openIn(f.tab);
  if (opened) {
    const [k, v] = opened, bar = k.indexOf("|"), file = k.slice(bar + 1);
    return { cwd: v?.root ?? (file.replace(/[\\/][^\\/]*$/, "") || "/"), on: k.slice(0, bar) || null, space: space?.id };
  }
  // Another mod pane has no folder either: keep the tree where it was.
  if (pane?.mod && last?.space === space?.id) return last;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return (last = { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id });
}
const key = () => JSON.stringify(location());
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  if (!on && window()?.platform === "windows") {
    const r = await exec("powershell", ["-NoProfile", "-Command", "& { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) } }) | ConvertTo-Json -Compress } '" + path.replaceAll("'", "''") + "'"]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ] && [ ! -L "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {}; this.ignored = new Set();
    this.menuDone = shared(MENU)?.id;
    try { this.hideDots = localStorage.getItem("hideDots") === "1"; } catch { this.hideDots = false; }
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.ignored = new Set(); this.inRepo = false; this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.inRepo = top?.code === 0; this.watch(cwd, cx);
        cx.notify();
        if (this.inRepo) {
          const ignored = await this.findIgnored(["", ...this.folders], context, new Set());
          if (this.current(context)) this.ignored = ignored;
        }
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  // Git decides (all .gitignore files, .git/info/exclude, core.excludesFile); tracked files
  // are never ignored. Adds the ignored paths of these folders' entries to `into`. A failure
  // (no repo, a nested repo, a remote without git) just leaves the folder ungreyed.
  async findIgnored(folders, context, into) {
    for (const folder of folders) {
      if (!this.current(context)) break;
      const entries = this.entries.get(folder);
      if (!entries?.length || this.underIgnored(folder, into) || (!context.on && window()?.platform === "windows")) continue;
      const args = entries.map(e => (folder ? `${folder}/` : "") + e.name + (e.dir ? "/" : ""));
      // exec has no stdin: pipe the names through sh so any file name survives (-z needs --stdin).
      const r = await exec("sh", ["-c", 'printf "%s\\0" "$@" | git --no-optional-locks check-ignore --stdin -z', "ignored", ...args], { cwd: context.cwd, on: context.on }).catch(() => null);
      if (r?.code === 0) for (const p of r.stdout.split("\0").filter(Boolean)) into.add(p.replace(/\/$/, ""));
    }
    return into;
  }

  underIgnored(path, set = this.ignored) {
    for (let p = path; p; p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") if (set.has(p)) return true;
    return false;
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
          if (this.inRepo && this.current(context)) { await this.findIgnored([path], context, this.ignored); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  open(path) {
    if (!this.root) return;
    const file = `${this.root}/${path}`, on = this.on, key = docKey(file, on), open = { ...(shared(OPEN) ?? {}) };
    const tab = tabOf(open[key]);
    if (tab && hasViewer(tab)) { run("tab.select", { id: tab }); return; }
    if (open[key]) { delete open[key]; setShared(OPEN, open); }
    // run() gives back no tab id: the viewer pane that wasn't there before is the new tab's.
    this.opening = { key, root: this.root, before: new Set(panes().filter(p => p.mod === VIEWER).map(p => p.pane)) };
    run("tab.new", { name: path.split("/").pop(), mod: VIEWER, props: { file, on } });
    this.claim();
  }

  claim() {
    const fresh = this.opening && panes().find(p => p.mod === VIEWER && !this.opening.before.has(p.pane));
    if (!fresh) return;
    setShared(OPEN, { ...(shared(OPEN) ?? {}), [this.opening.key]: { tab: fresh.tab, root: this.opening.root } });
    this.opening = null;
  }

  openExternally(path, cx) {
    if (!this.root) return;
    const file = `${this.root}/${path}`;
    if (this.on) {
      notify({ title: "Can't open in a local app", body: `${path} is on ${this.on}.`, level: "warning" });
      return;
    }
    const mac = window()?.platform === "macos";
    cx.spawn(async () => {
      const r = await exec(mac ? "open" : "xdg-open", [file]).catch(e => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) notify({ title: "Couldn't open the file", body: (r.stderr || path).trim(), level: "error" });
    });
  }

  menu(path, dir) {
    if (!this.root) return;
    const p = { path, file: `${this.root}/${path}`, dir, expanded: this.folders.has(path), on: this.on, space: location().space, context: this.context.key };
    // Matches file-menu's rows: 31px each, two 9px separators, 5px padding.
    const rows = 5 + (p.on ? 0 : 1) + (p.on || dir ? 0 : 1);
    openOverlay({ mod: "file-menu", kind: "popup", width: 230, height: rows * 31 + 2 * 9 + 10, props: p });
  }

  // A choice from file-menu that needs this tree: open in a tab, expand or collapse.
  answer(cx) {
    const req = shared(MENU);
    if (!req || req.id === this.menuDone) return;
    this.menuDone = req.id;
    if (req.context !== this.context?.key) return;
    if (req.action === "open") this.open(req.path);
    else if (req.action === "toggle") this.toggle(req.path, cx);
  }

  toggleDots(cx) {
    this.hideDots = !this.hideDots;
    try { localStorage.setItem("hideDots", this.hideDots ? "1" : "0"); } catch {}
    cx.notify();
  }

  rows(prefix, depth, out, t, current, dimmed = false) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      if (this.hideDots && entry.name.startsWith(".")) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      const dim = dimmed || this.ignored.has(path);
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .when(!entry.dir && current === docKey(`${this.root}/${path}`, this.on), el => el.bg(t.selected))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu(path, entry.dir); })
        .on_click((e, cx) => entry.dir ? this.toggle(path, cx) : e.modifiers?.platform ? this.openExternally(path, cx) : this.open(path))
        .child(entry.dir ? svg(`mods/my-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/my-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(dim ? t.dim : t.muted))
        .child(div().flex_1().min_w(0).truncate().when(dim, el => el.text_color(t.dim)).child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t, current, dim);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    this.answer(cx);
    this.claim();
    const t = theme(), current = viewing(focused()?.tab), list = this.rows("", 0, [], t, current);
    const empty = this.error || (this.loading ? "Loading files…" : !this.root ? "No folder" : this.entries.get("")?.length ? "Only hidden files" : "No files");
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.root?.split(/[\\/]/).pop() ?? ""))
        .child(div().id("files-dots").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.toggleDots(cx))
          .child(svg(`mods/my-files/${this.hideDots ? "eye-off" : "eye"}.svg`).size(14).text_color(this.hideDots ? t.dim : t.muted))))
      .child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(list)
        .when(Boolean(this.error) || !list.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(empty)))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))));
  }
}
