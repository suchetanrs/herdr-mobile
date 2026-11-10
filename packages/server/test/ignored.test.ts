// Greying in the file browser: which entries git ignores (real git, throwaway repos).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FsListing } from '@herdr-mobile/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileBrowser } from '../src/files/browse.js';
import { gitIgnored, IGNORE_MAX } from '../src/files/ignored.js';
import { rmDir, tmpDir } from './helpers/tmp.js';

let dir = '';
let repo = '';
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
const write = (rel: string, text = 'x') => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
const entriesOf = (rel: string) =>
  fs.readdirSync(path.join(repo, rel), { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }));
const ignoredIn = async (rel: string) => [...(await gitIgnored(path.join(repo, rel), entriesOf(rel)))].sort();

beforeEach(() => {
  dir = fs.realpathSync(tmpDir('ign'));
  repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git('init', '-q');
  write('.gitignore', 'build/\n*.log\n');
  write('src/.gitignore', 'gen/\n');
  write('src/app.ts');
  write('src/gen/out.ts');
  write('src/lib/x.ts');
  write('build/sub/a.txt');
  write('build/b.txt');
  write('debug.log');
  write('tracked.log');
  write('mine.txt');
  write('global.tmp');
  write('README.md');
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'mine.txt\n');
  write('.excludes', '*.tmp\n');
  git('config', 'core.excludesFile', path.join(repo, '.excludes'));
  git('add', '-f', 'tracked.log', 'README.md');
});
afterEach(() => rmDir(dir));

describe('gitIgnored', () => {
  it('counts .gitignore, info/exclude and core.excludesFile; never tracked files; greys .git', async () => {
    expect(await ignoredIn('.')).toEqual(['.git', 'build', 'debug.log', 'global.tmp', 'mine.txt']);
  });

  it('nested .gitignore files apply in their folder', async () => {
    expect(await ignoredIn('src')).toEqual(['gen']);
    expect(await ignoredIn('src/lib')).toEqual([]);
  });

  it('everything inside an ignored folder is ignored, at any depth, and inside .git', async () => {
    expect(await ignoredIn('build')).toEqual(['b.txt', 'sub']);
    expect(await ignoredIn('build/sub')).toEqual(['a.txt']);
    expect(await ignoredIn('src/gen')).toEqual(['out.ts']);
    expect((await ignoredIn('.git')).length).toBe(entriesOf('.git').length);
  });

  it('outside a repo, when git fails or is too slow, or with too many entries: nothing, no error', async () => {
    expect([...(await gitIgnored('/', [{ name: 'etc', dir: true }]))]).toEqual([]);
    const opts = { git: path.join(dir, 'no-such-git') };
    expect([
      ...(await gitIgnored(
        repo,
        entriesOf('.').filter((e) => e.name !== '.git'),
        opts,
      )),
    ]).toEqual([]);
    const slow = path.join(dir, 'slow-git');
    fs.writeFileSync(slow, '#!/bin/sh\nexec sleep 5\n', { mode: 0o755 });
    const t0 = Date.now();
    expect([...(await gitIgnored(repo, [{ name: 'debug.log', dir: false }], { git: slow, timeoutMs: 150 }))]).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2000);
    const many = Array.from({ length: IGNORE_MAX + 1 }, (_, i) => ({ name: `f${i}.log`, dir: false }));
    expect([...(await gitIgnored(repo, many))]).toEqual([]);
    expect([...(await gitIgnored(repo, []))]).toEqual([]);
  });

  it('listings carry `ignored` per entry', async () => {
    const browser = new FileBrowser({ home: dir, privateDirs: [path.join(dir, 'cfg')] });
    const l = (await browser.lookup(repo, { hidden: true })) as FsListing;
    const flags = Object.fromEntries(l.entries.map((e) => [e.name, e.ignored]));
    expect(flags).toMatchObject({ '.git': true, build: true, 'debug.log': true, 'mine.txt': true, src: false, 'tracked.log': false });
    fs.symlinkSync('src', path.join(repo, 'srclink'));
    const linked = (await browser.lookup(repo)) as FsListing;
    expect(linked.entries.find((e) => e.name === 'srclink')?.kind).toBe('dir');
    expect(linked.entries.find((e) => e.name === 'debug.log')?.ignored).toBe(true); // the link didn't spoil the batch
    const inside = (await browser.lookup(path.join(repo, 'build', 'sub'))) as FsListing;
    expect(inside.entries.map((e) => e.ignored)).toEqual([true]);
  });
});
