import type { CoreInfo, SpaceView, TabView, TerminalView, World } from './world.js';

/** One change to a `World`. Entities are replaced whole, never merged. */
export type PatchOp =
  | { op: 'space'; value: SpaceView }
  | { op: 'tab'; value: TabView }
  | { op: 'terminal'; value: TerminalView }
  | { op: 'delSpace'; id: string }
  | { op: 'delTab'; id: string }
  | { op: 'delTerminal'; id: string }
  | { op: 'spaceOrder'; value: string[] }
  | { op: 'core'; value: CoreInfo };

/** Applies ops to a world in place and returns it. Pure data, shared by server tests and clients. */
export function applyPatch(world: World, ops: readonly PatchOp[]): World {
  for (const o of ops) {
    switch (o.op) {
      case 'space':
        world.spaces[o.value.id] = o.value;
        break;
      case 'tab':
        world.tabs[o.value.id] = o.value;
        break;
      case 'terminal':
        world.terminals[o.value.id] = o.value;
        break;
      case 'delSpace':
        delete world.spaces[o.id];
        break;
      case 'delTab':
        delete world.tabs[o.id];
        break;
      case 'delTerminal':
        delete world.terminals[o.id];
        break;
      case 'spaceOrder':
        world.spaceOrder = o.value;
        break;
      case 'core':
        world.core = o.value;
        break;
    }
  }
  return world;
}
