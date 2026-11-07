// @vitest-environment jsdom
// SECURITY_AUDIT N2 (client side): the token comes in the URL fragment, leaves the address at once, is sent
// only in the sign-in request's body, and nothing auth-related is kept in localStorage or a WebSocket URL.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tokenFromInput } from '../screens/TokenScreen';
import { forgetStoredToken, signIn, takeTokenFromUrl, wsUrl } from './auth';

const TOKEN = 'abcDEF0123456789abcDEF0123456789abcDEF01234';

afterEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/');
});

describe('sign-in link', () => {
  it('takes #token= out of the address and history, keeping a route after it', () => {
    history.replaceState(null, '', `/#token=${TOKEN}`);
    expect(takeTokenFromUrl()).toBe(TOKEN);
    expect(location.href).not.toContain(TOKEN);
    expect(location.hash).toBe('');
    history.replaceState(null, '', `/#token=${TOKEN}&/a/t1/conversation`);
    expect(takeTokenFromUrl()).toBe(TOKEN);
    expect(location.hash).toBe('#/a/t1/conversation');
    expect(location.href).not.toContain('token');
    history.replaceState(null, '', '/#/s/x');
    expect(takeTokenFromUrl()).toBeNull();
    expect(location.hash).toBe('#/s/x');
  });

  it('sends the token only in a JSON POST body, never a URL; keeps nothing in localStorage', async () => {
    localStorage.setItem('hm.token', JSON.stringify(TOKEN));
    forgetStoredToken();
    const calls: Array<[string, RequestInit]> = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response('{}', { status: 201 });
    }) as unknown as typeof fetch;
    expect(await signIn(TOKEN, fetcher)).toBe('ok');
    expect(calls[0]?.[0]).toBe('/api/session');
    expect(calls[0]?.[1].method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.[1].body)).token).toBe(TOKEN);
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain(TOKEN);
    expect(localStorage.getItem('hm.token')).toBeNull();
    expect(wsUrl()).toBe(`ws://${location.host}/ws`);
  });

  it('reports a wrong token and a blocked address', async () => {
    const answer = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;
    expect(await signIn(TOKEN, answer(401))).toBe('unauthorized');
    expect(await signIn(TOKEN, answer(429))).toBe('blocked');
    expect(await signIn(TOKEN, answer(500))).toBe('unreachable');
  });

  it('a pasted link or the bare token both work', () => {
    expect(tokenFromInput(`http://100.64.0.10:8787/#token=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromInput(`http://100.64.0.10:8787/?token=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromInput(`  ${TOKEN} `)).toBe(TOKEN);
  });
});
