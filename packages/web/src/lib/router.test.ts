import { describe, expect, it } from 'vitest';
import { depth, parseRoute, routeHash } from './router';

describe('router', () => {
  it('round-trips routes, including machine-qualified ids', () => {
    for (const r of [
      { name: 'spaces' },
      { name: 'alerts' },
      { name: 'settings' },
      { name: 'new' },
      { name: 'files' },
      { name: 'files', view: '/home/me/My clips/a#1 ö.mp4' },
      { name: 'files', space: 'rohan/sp1' },
      { name: 'files', space: 'sp1', view: '/home/me/a b/c.md' },
      { name: 'space', spaceId: 'rohan/sp1' },
      { name: 'agent', terminalId: 'rohan/t7' },
      { name: 'agent', terminalId: 't7', view: 'conversation' },
      { name: 'agent', terminalId: 't7', view: 'terminal' },
    ] as const) {
      expect(parseRoute(routeHash(r))).toEqual(r);
    }
    expect(parseRoute('')).toEqual({ name: 'spaces' });
    expect(parseRoute('#/nonsense')).toEqual({ name: 'spaces' });
    expect(depth({ name: 'agent', terminalId: 't1' })).toBeGreaterThan(depth({ name: 'space', spaceId: 's' }));
    expect(depth({ name: 'files', space: 's' })).toBeGreaterThan(depth({ name: 'space', spaceId: 's' }));
  });
});
