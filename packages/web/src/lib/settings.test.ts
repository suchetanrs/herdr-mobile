// @vitest-environment jsdom
// Dark (graphite) is the default on every device, whatever the system's color scheme; only a theme picked
// in Settings changes it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSettings } from './settings';

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function freshStore() {
  return (await import('./settings')).settings;
}

describe('theme default', () => {
  it('is dark with nothing stored', () => {
    expect(resolveSettings({}).theme).toBe('dark');
  });

  it("is dark when the stored 'system' was only the old default saved with other settings", () => {
    expect(resolveSettings({ theme: 'system', chatFont: 17 })).toMatchObject({ theme: 'dark', chatFont: 17 });
  });

  it('keeps a picked theme, System included', () => {
    expect(resolveSettings({ theme: 'light' }).theme).toBe('light');
    expect(resolveSettings({ theme: 'system', themePicked: true }).theme).toBe('system');
  });

  it('a fresh device starts dark and stays dark after other settings are saved; picking Light sticks across a reload', async () => {
    let s = await freshStore();
    expect(s.get().theme).toBe('dark');
    s.set({ chatFont: 16 });
    vi.resetModules();
    s = await freshStore();
    expect(s.get().theme).toBe('dark');
    s.set({ theme: 'light' });
    vi.resetModules();
    s = await freshStore();
    expect(s.get().theme).toBe('light');
  });
});
