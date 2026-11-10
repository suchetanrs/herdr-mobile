// @vitest-environment jsdom
import type { FsFile, FsListing } from '@herdr-mobile/protocol';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeFrom, crumbs, fileSize, modified, tildePath, typedToPath } from '../lib/files';
import { sampleWorld } from '../test/fixtures';
import { renderWith } from '../test/render';
import { FilesScreen } from './FilesScreen';

const HOME = '/home/me';
const dirOf = (p: string, names: Array<[string, 'dir' | 'file']>, hidden = 0): FsListing => ({
  kind: 'dir',
  path: p,
  parent: p === '/' ? null : p.slice(0, p.lastIndexOf('/')) || '/',
  home: HOME,
  entries: names.map(([name, kind]) => ({ name, kind, link: false, size: kind === 'file' ? 2048 : null, mtime: Date.now() - 120_000 })),
  total: names.length,
  offset: 0,
  hidden,
  truncated: false,
});

let asked: string[];
let tree: Record<string, FsListing | FsFile | { status: number; error: string; code: string }>;

beforeEach(() => {
  localStorage.clear();
  asked = [];
  tree = {
    [HOME]: dirOf(
      HOME,
      [
        ['code', 'dir'],
        ['notes.zip', 'file'],
      ],
      1,
    ),
    [`${HOME}/code`]: dirOf(`${HOME}/code`, [['app.bin', 'file']]),
    [`${HOME}/code/app.bin`]: { kind: 'file', path: `${HOME}/code/app.bin`, name: 'app.bin', size: 10, mtime: 0, downloadable: true },
    '/etc/shadow': { status: 403, error: 'Permission denied', code: 'denied' },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const q = new URL(url, 'http://x').searchParams;
      let p = q.get('path') ?? '';
      asked.push(`${p}${q.get('hidden') ? ' +hidden' : ''}`);
      if (p === '~' || p === '') p = HOME;
      if (p.startsWith('~/')) p = HOME + p.slice(1);
      const hit = tree[p];
      if (!hit) return new Response(JSON.stringify({ error: 'No such file or folder', code: 'not-found' }), { status: 404 });
      if ('status' in hit) return new Response(JSON.stringify(hit), { status: hit.status });
      return new Response(JSON.stringify(hit), { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Files screen', () => {
  it('starts at home: path bar, crumbs, folders then files with size and age; files are download links', async () => {
    renderWith(<FilesScreen />, sampleWorld());
    await screen.findByText('notes.zip');
    expect((screen.getByLabelText('Path') as HTMLInputElement).value).toBe('~');
    expect(screen.getAllByRole('button', { name: '/' }).length).toBe(1);
    expect(screen.getByRole('button', { name: 'me' }).getAttribute('aria-current')).toBe('page');
    const link = screen.getByRole('link', { name: 'Download notes.zip' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/api/fs/download?path=${encodeURIComponent(`${HOME}/notes.zip`)}`);
    expect(link.hasAttribute('download')).toBe(true);
    expect(screen.getByText(/2\.0 KB · 2 min ago/)).toBeTruthy();
    expect(screen.getByText(/1 hidden/)).toBeTruthy();
    fireEvent.click(screen.getByText('code'));
    await screen.findByText('app.bin');
    expect((screen.getByLabelText('Path') as HTMLInputElement).value).toBe('~/code');
    expect(localStorage.getItem('hm.files.dir')).toBe(JSON.stringify(`${HOME}/code`));
    fireEvent.click(screen.getByRole('button', { name: 'Up one folder' }));
    await screen.findByText('notes.zip');
  });

  it('a typed folder opens; a typed file downloads; errors say why', async () => {
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(`${this.getAttribute('href')} ${this.download}`);
    });
    renderWith(<FilesScreen />, sampleWorld());
    await screen.findByText('notes.zip');
    const bar = screen.getByLabelText('Path') as HTMLInputElement;
    fireEvent.change(bar, { target: { value: 'code' } });
    fireEvent.submit(bar.closest('form') as HTMLFormElement);
    await screen.findByText('app.bin');
    expect(asked).toContain(`${HOME}/code`);
    fireEvent.change(bar, { target: { value: '~/code/app.bin' } });
    fireEvent.submit(bar.closest('form') as HTMLFormElement);
    await screen.findByText(/Downloading/);
    expect(clicks).toEqual([`/api/fs/download?path=${encodeURIComponent(`${HOME}/code/app.bin`)} app.bin`]);
    expect(document.querySelector('.fs-notice')?.textContent).toContain('Downloading app.bin');
    fireEvent.change(bar, { target: { value: '/etc/shadow' } });
    fireEvent.submit(bar.closest('form') as HTMLFormElement);
    await screen.findByText('Permission denied', { selector: 'h3' });
    fireEvent.change(bar, { target: { value: '/nope' } });
    fireEvent.submit(bar.closest('form') as HTMLFormElement);
    await screen.findByText('Not found');
    fireEvent.click(screen.getByRole('button', { name: 'Back to the folder' }));
    await screen.findByText('app.bin');
  });

  it('while a folder loads: Go stays enabled (a disabled default button swallows Enter) and typing is kept', async () => {
    const real = globalThis.fetch;
    let release = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        await new Promise<void>((r) => {
          release = r;
        });
        return real(url);
      }),
    );
    renderWith(<FilesScreen />, sampleWorld());
    const go = screen.getByRole('button', { name: 'Go' }) as HTMLButtonElement;
    expect(go.getAttribute('aria-busy')).toBe('true');
    expect(go.disabled).toBe(false);
    // Typing while it loads: the folder arriving doesn't overwrite the typed path.
    const bar = screen.getByLabelText('Path') as HTMLInputElement;
    fireEvent.change(bar, { target: { value: '~/cod' } });
    release();
    await screen.findByText('notes.zip');
    expect(bar.value).toBe('~/cod');
  });

  it('hidden files: off by default, the toggle asks again and is remembered', async () => {
    renderWith(<FilesScreen />, sampleWorld());
    await screen.findByText('notes.zip');
    expect(asked[0]).toBe('~');
    const toggle = screen.getByRole('button', { name: /Hidden/ });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => expect(asked).toContain(`${HOME} +hidden`));
    expect(localStorage.getItem('hm.files.hidden')).toBe('true');
  });

  it('a remembered folder that is gone falls back to home', async () => {
    localStorage.setItem('hm.files.dir', JSON.stringify('/gone'));
    renderWith(<FilesScreen />, sampleWorld());
    await screen.findByText('notes.zip');
    expect(asked).toEqual(['/gone', '~']);
  });
});

describe("Files screen: git-ignored entries and a space's files", () => {
  it('ignored entries are dimmed but stay a folder button / download link', async () => {
    const l = tree[HOME] as FsListing;
    l.entries = l.entries.map((e) => ({ ...e, ignored: true }));
    (tree[`${HOME}/code`] as FsListing).entries[0] = { ...(tree[`${HOME}/code`] as FsListing).entries[0], ignored: false } as never;
    renderWith(<FilesScreen />, sampleWorld());
    await screen.findByText('notes.zip');
    const link = screen.getByRole('link', { name: 'Download notes.zip' });
    expect(link.classList.contains('fs-ignored')).toBe(true);
    const folder = screen.getByText('code').closest('button') as HTMLButtonElement;
    expect(folder.classList.contains('fs-ignored')).toBe(true);
    fireEvent.click(folder);
    await screen.findByText('app.bin');
    expect(screen.getByRole('link', { name: 'Download app.bin' }).classList.contains('fs-ignored')).toBe(false);
  });

  it("from a space: opens its first terminal's folder, falls back to the space's, leaves the last folder alone", async () => {
    localStorage.setItem('hm.files.dir', JSON.stringify(`${HOME}/code`));
    const world = sampleWorld();
    world.spaces.spA = { ...world.spaces.spA, folder: HOME } as never;
    renderWith(<FilesScreen space="spA" />, world); // t1's cwd /home/me/code/alpha isn't in the tree
    await screen.findByText('notes.zip');
    expect(asked).toEqual(['/home/me/code/alpha', HOME]);
    expect(screen.getByText('alpha', { selector: '.topbar-sub' })).toBeTruthy();
    fireEvent.click(screen.getByText('code'));
    await screen.findByText('app.bin');
    expect(localStorage.getItem('hm.files.dir')).toBe(JSON.stringify(`${HOME}/code`));
    cleanup();
    localStorage.removeItem('hm.files.dir');
    asked = [];
    renderWith(<FilesScreen space="spA" />, world);
    await screen.findByText('notes.zip');
    expect(localStorage.getItem('hm.files.dir')).toBeNull();
  });
});

describe('lib/files', () => {
  it('paths: relative to the folder shown, ~ kept, quotes dropped; ~ shown for home; crumbs', () => {
    expect(typedToPath('src', '/a/b')).toBe('/a/b/src');
    expect(typedToPath('../x', '/a/b')).toBe('/a/b/../x');
    expect(typedToPath('~/x', '/a')).toBe('~/x');
    expect(typedToPath('"/a b/c"', '/z')).toBe('/a b/c');
    expect(typedToPath('x', '/')).toBe('/x');
    expect(tildePath('/home/me', HOME)).toBe('~');
    expect(tildePath('/home/me/a', HOME)).toBe('~/a');
    expect(tildePath('/home/meow', HOME)).toBe('/home/meow');
    expect(crumbs('/')).toEqual([{ label: '/', path: '/' }]);
    expect(crumbs('/a/b')).toEqual([
      { label: '/', path: '/' },
      { label: 'a', path: '/a' },
      { label: 'b', path: '/a/b' },
    ]);
  });

  it('sizes, ages, completion', () => {
    expect(fileSize(0)).toBe('0 B');
    expect(fileSize(1536)).toBe('1.5 KB');
    expect(fileSize(50 * 1024 * 1024)).toBe('50 MB');
    expect(modified(1000, 1000 + 30_000)).toBe('just now');
    expect(modified(0, 5 * 60_000)).toBe('5 min ago');
    expect(modified(0, 3 * 3_600_000)).toBe('3 h ago');
    const names = [
      { name: 'Projects', kind: 'dir' },
      { name: 'Pictures', kind: 'dir' },
      { name: 'notes.zip', kind: 'file' },
    ];
    expect(completeFrom('~/Proj', names)).toBe('~/Projects/');
    expect(completeFrom('~/P', names)).toBeNull();
    expect(completeFrom('~/no', names)).toBe('~/notes.zip');
    expect(completeFrom('~/z', names)).toBeNull();
    expect(completeFrom('pi', names)).toBe('Pictures/');
  });
});

describe('File viewer', () => {
  it('viewable files open the viewer (download stays a link); others stay downloads', async () => {
    tree[HOME] = dirOf(HOME, [
      ['clip.mp4', 'file'],
      ['notes.zip', 'file'],
    ]);
    window.location.hash = '#/files';
    renderWith(<FilesScreen />, sampleWorld());
    await screen.findByText('clip.mp4');
    expect(screen.getByRole('link', { name: 'Download clip.mp4' }).getAttribute('href')).toBe(
      `/api/fs/download?path=${encodeURIComponent(`${HOME}/clip.mp4`)}`,
    );
    expect(screen.queryByRole('button', { name: 'Open notes.zip' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open clip.mp4' }));
    expect(window.location.hash).toBe(`#/files/view/${encodeURIComponent(`${HOME}/clip.mp4`)}`);
  });

  it('video, image and Markdown (raw HTML stays text); a media error offers Download', async () => {
    const { FileViewer } = await import('./FileViewer');
    const onClose = vi.fn();
    const v = renderWith(<FileViewer path={`${HOME}/clip.mp4`} onClose={onClose} />, sampleWorld());
    const video = v.container.querySelector('video') as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe(`/api/fs/view?path=${encodeURIComponent(`${HOME}/clip.mp4`)}`);
    expect(video.hasAttribute('playsinline')).toBe(true);
    fireEvent.error(video);
    expect(await screen.findByText('Can’t show this here')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Download instead/ }).getAttribute('href')).toContain('/api/fs/download?path=');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
    cleanup();

    const i = renderWith(<FileViewer path={`${HOME}/pic.png`} onClose={onClose} />, sampleWorld());
    expect(i.container.querySelector('img.fv-img')?.getAttribute('src')).toContain('/api/fs/view?path=');
    cleanup();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('# Title\n\n<script>window.hacked = 1</script> and `code`', { status: 200 })),
    );
    const m = renderWith(<FileViewer path={`${HOME}/README.md`} onClose={onClose} />, sampleWorld());
    await screen.findByRole('heading', { name: 'Title' });
    expect(m.container.querySelector('.fv-md script')).toBeNull();
    expect(m.container.textContent).toContain('<script>window.hacked = 1</script>');
  });

  it('code: line numbers + highlight.js classes, <script> stays text; big files plain; Wrap; a refused file offers Download', async () => {
    const { FileViewer } = await import('./FileViewer');
    const onClose = vi.fn();
    const py = 'def f(x):\n    """doc\n    more"""\n    return "<script>window.hacked = 1</script>"\n';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(py, { status: 200 })),
    );
    const c = renderWith(<FileViewer path={`${HOME}/a.py`} onClose={onClose} />, sampleWorld());
    await waitFor(() => expect(c.container.querySelectorAll('.cv-line')).toHaveLength(4));
    expect([...c.container.querySelectorAll('.cv-ln')].map((n) => n.textContent)).toEqual(['1', '2', '3', '4']);
    expect(c.container.querySelector('.cv-code.hljs .hljs-keyword')?.textContent).toBe('def');
    // A multi-line string stays coloured on each of its lines.
    expect(c.container.querySelectorAll('.cv-line')[1]?.querySelector('.hljs-string')).toBeTruthy();
    expect(c.container.querySelector('.cv-code script')).toBeNull();
    expect(c.container.textContent).toContain('<script>window.hacked = 1</script>');
    expect(c.container.textContent).toContain('Python · 4 lines');
    const wrap = screen.getByRole('button', { name: 'Wrap' });
    fireEvent.click(wrap);
    expect(wrap.getAttribute('aria-pressed')).toBe('true');
    expect(c.container.querySelector('.cv-scroll.cv-wrap')).toBeTruthy();
    cleanup();

    const big = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(60)}`).join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(big, { status: 200 })),
    );
    const b = renderWith(<FileViewer path={`${HOME}/big.py`} onClose={onClose} />, sampleWorld());
    await waitFor(() => expect(b.container.querySelector('.cv-line')).toBeTruthy());
    expect(b.container.querySelector('.cv-code.hljs')).toBeNull();
    expect(b.container.textContent).toContain('Plain text · 5,000 lines');
    expect(b.container.querySelectorAll('.cv-line')).toHaveLength(2000);
    fireEvent.click(screen.getByRole('button', { name: /Show more \(3,000 lines left\)/ }));
    expect(b.container.querySelectorAll('.cv-line')).toHaveLength(4000);
    cleanup();

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'This file can’t be shown here; download it instead', code: 'not-viewable' }), {
            status: 415,
          }),
      ),
    );
    renderWith(<FileViewer path={`${HOME}/bin.py`} onClose={onClose} />, sampleWorld());
    expect(await screen.findByText('Can’t show this here')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Download instead/ }).getAttribute('href')).toBe(
      `/api/fs/download?path=${encodeURIComponent(`${HOME}/bin.py`)}`,
    );
  });

  it('code files and text by name open the viewer; text too big for it downloads', async () => {
    tree[HOME] = dirOf(HOME, [
      ['Dockerfile', 'file'],
      ['conf.yaml', 'file'],
      ['.env', 'file'],
      ['page.html', 'file'],
    ]);
    const huge = { name: 'huge.log', kind: 'file' as const, link: false, size: 3 * 1024 * 1024, mtime: 0 };
    (tree[HOME] as FsListing).entries.push(huge);
    window.location.hash = '#/files';
    renderWith(<FilesScreen />, sampleWorld());
    await screen.findByText('conf.yaml');
    expect(screen.getByRole('button', { name: 'Open conf.yaml' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Dockerfile' })).toBeTruthy();
    for (const n of ['.env', 'page.html', 'huge.log']) {
      expect(screen.queryByRole('button', { name: `Open ${n}` }), n).toBeNull();
      expect(screen.getByRole('link', { name: `Download ${n}` }), n).toBeTruthy();
    }
  });
});
