import type { PatchOp, World } from '@herdr-mobile/protocol';

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** The ops that turn `prev` into `next`: whole-entity replacements and deletions. */
export function diffWorld(prev: World, next: World): PatchOp[] {
  const ops: PatchOp[] = [];
  if (!same(prev.core, next.core)) ops.push({ op: 'core', value: next.core });
  for (const [id, v] of Object.entries(next.terminals)) if (!same(prev.terminals[id], v)) ops.push({ op: 'terminal', value: v });
  for (const [id, v] of Object.entries(next.tabs)) if (!same(prev.tabs[id], v)) ops.push({ op: 'tab', value: v });
  for (const [id, v] of Object.entries(next.spaces)) if (!same(prev.spaces[id], v)) ops.push({ op: 'space', value: v });
  if (!same(prev.spaceOrder, next.spaceOrder)) ops.push({ op: 'spaceOrder', value: next.spaceOrder });
  for (const id of Object.keys(prev.spaces)) if (!(id in next.spaces)) ops.push({ op: 'delSpace', id });
  for (const id of Object.keys(prev.tabs)) if (!(id in next.tabs)) ops.push({ op: 'delTab', id });
  for (const id of Object.keys(prev.terminals)) if (!(id in next.terminals)) ops.push({ op: 'delTerminal', id });
  return ops;
}
