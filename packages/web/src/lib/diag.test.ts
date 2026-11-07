// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldReload } from './build';
import { DiagRecorder, diagFromUrl, MAX_EVENTS, MAX_REPORT_BYTES, redact, safeLocation, selectorOf } from './diag';
import { AppStore } from './store';

const SECRET = 'hm_Sk3cretTokenValue0123456789abcdefXYZ';

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

function touch(type: string, target: Element, x = 10, y = 10) {
  const e = new Event(type, { bubbles: true, cancelable: true }) as Event & Record<string, unknown>;
  const t = { identifier: 0, clientX: x, clientY: y, target };
  Object.assign(e, { touches: type === 'touchend' ? [] : [t], changedTouches: [t] });
  target.dispatchEvent(e);
}

describe('diagnostics redaction', () => {
  it('redacts token-like runs and token= values, and caps length', () => {
    expect(redact(`failed ${SECRET} here`)).toBe('failed [redacted] here');
    expect(redact('GET /x?token=abc&y=1')).toBe('GET /x?token=[redacted]&y=1');
    expect(redact('a'.repeat(500)).length).toBeLessThanOrEqual(201);
    expect(safeLocation({ pathname: '/', hash: `#token=${SECRET}&/a/t1` })).toBe('/#token=[redacted]');
    expect(safeLocation({ pathname: '/', hash: '#/a/t1' })).toBe('/#/a/t1');
  });

  it('selectors name elements without their text, value or placeholder', () => {
    document.body.innerHTML =
      '<form class="composer"><textarea class="composer-input" aria-label="Message" placeholder="secret placeholder"></textarea></form><button aria-label="Open agent named private">x</button>';
    const ta = document.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'my typed secret';
    expect(selectorOf(ta)).toBe('body>form.composer>textarea.composer-input[Message]');
    const btn = selectorOf(document.querySelector('button'));
    expect(btn).not.toContain('private');
  });

  it('a report never carries typed text, cookies, tokens or the query', async () => {
    document.body.innerHTML = '<div class="agent-input-row"><textarea aria-label="Message"></textarea></div>';
    const ta = document.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = `please type ${SECRET} hunter2-typed`;
    // biome-ignore lint/suspicious/noDocumentCookie: a cookie the report must not carry.
    document.cookie = `hm_other=${SECRET}`;
    window.history.replaceState(null, '', `/?token=${SECRET}#token=${SECRET}`);
    const bodies: string[] = [];
    const store = new AppStore();
    const rec = new DiagRecorder(store, async (b) => {
      bodies.push(b);
      return 200;
    });
    rec.setEnabled(true);
    touch('touchstart', ta);
    touch('touchend', ta);
    ta.focus();
    ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'x' }));
    window.dispatchEvent(new ErrorEvent('error', { message: `boom ${SECRET}`, filename: `http://h/assets/a.js?token=${SECRET}` }));
    expect(await rec.flush('manual')).toBe('sent');
    const body = bodies[0] ?? '';
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('please type');
    expect(body).not.toContain('hm_other');
    const report = JSON.parse(body) as { info: Record<string, unknown>; events: Array<Record<string, unknown>> };
    const kinds = report.events.map((e) => e.k);
    expect(kinds).toEqual(expect.arrayContaining(['start', 'ws', 'touchstart', 'touchend', 'focusin', 'error']));
    const end = report.events.find((e) => e.k === 'touchend') as Record<string, unknown>;
    expect(end.tg).toBe('body>div.agent-input-row>textarea[Message]');
    expect(end.f).toMatchObject({ dis: false, ro: false, editable: true });
    expect(report.info.build).toBe('dev');
    expect(report.info.loc).toBe('/#token=[redacted]');
    rec.setEnabled(false);
    window.history.replaceState(null, '', '/');
  });

  it('off records nothing; the ring and the report stay bounded', async () => {
    const rec = new DiagRecorder(null, async () => 200);
    rec.push('x');
    expect(rec.count).toBe(0);
    rec.setEnabled(true);
    for (let i = 0; i < MAX_EVENTS + 50; i++) rec.push('big', { pad: 'p'.repeat(300) });
    expect(rec.count).toBe(MAX_EVENTS);
    expect(rec.report('t').length).toBeLessThanOrEqual(MAX_REPORT_BYTES);
    rec.setEnabled(false);
    expect(rec.count).toBe(0);
  });

  it('send results: 429 limited, 401 signed out, a throw failed; auto skips when nothing is new', async () => {
    const send = vi.fn(async () => 429);
    const rec = new DiagRecorder(null, send);
    rec.setEnabled(true);
    expect(await rec.flush('manual')).toBe('limited');
    send.mockImplementation(async () => 401);
    expect(await rec.flush('manual')).toBe('signed-out');
    send.mockImplementation(async () => {
      throw new Error('net');
    });
    expect(await rec.flush('manual')).toBe('failed');
    send.mockImplementation(async () => 200);
    expect(await rec.flush('manual')).toBe('sent');
    expect(await rec.flush('auto')).toBe('nothing');
    rec.setEnabled(false);
  });

  it('#diag turns it on and leaves the address; #diag-off turns it off', () => {
    window.history.replaceState(null, '', '/#diag&/a/t1');
    expect(diagFromUrl()).toBe(true);
    expect(window.location.hash).toBe('#/a/t1');
    window.history.replaceState(null, '', '/#diag-off');
    expect(diagFromUrl()).toBe(false);
    expect(window.location.hash).toBe('');
    window.history.replaceState(null, '', '/#/a/t1');
    expect(diagFromUrl()).toBeNull();
  });
});

describe('shouldReload (an old page after an update)', () => {
  const base = { own: 'aaa 2026', server: 'bbb 2026', editing: false, reloadedFor: null };
  it('reloads into a different build the bridge serves', () => expect(shouldReload(base)).toBe(true));
  it('not while typing', () => expect(shouldReload({ ...base, editing: true })).toBe(false));
  it('not twice for the same build (no loop)', () => expect(shouldReload({ ...base, reloadedFor: 'bbb 2026' })).toBe(false));
  it('not in dev, not for the same build, not without one', () => {
    expect(shouldReload({ ...base, own: 'dev' })).toBe(false);
    expect(shouldReload({ ...base, server: 'aaa 2026' })).toBe(false);
    expect(shouldReload({ ...base, server: null })).toBe(false);
  });
});
