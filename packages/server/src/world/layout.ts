/**
 * The `herdr-app` core document (spaces -> tabs -> node tree), read-only.
 * Node kinds from herdr-app src/layout.rs: block (terminal or mod content),
 * row / column / stack containers.
 */

export interface LayoutNode {
  id: string;
  type: 'block' | 'row' | 'column' | 'stack' | string;
  content?: { terminal?: string; mod?: string; [k: string]: unknown };
  children?: LayoutNode[];
  hidden?: boolean;
  [k: string]: unknown;
}

export interface LayoutTab {
  id: string;
  name?: string;
  root?: LayoutNode;
}

export interface LayoutSpace {
  id: string;
  name?: string;
  folder?: string;
  machine?: string | null;
  tabs?: LayoutTab[];
}

export interface LayoutDoc {
  spaces?: LayoutSpace[];
}

export interface Pane {
  id: string;
  terminal: string | null;
}

/** Pane blocks in tree order (a block with terminal or mod content). */
export function panesOf(root: LayoutNode | undefined): Pane[] {
  const out: Pane[] = [];
  const walk = (n: LayoutNode | undefined) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'block') {
      const t = n.content?.terminal;
      if (typeof t === 'string' || n.content?.mod !== undefined) out.push({ id: n.id, terminal: typeof t === 'string' ? t : null });
      return;
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

/** Herdr's id for a thing on another machine: `rohan/t7` (mirror.rs `qualify`). */
export function qualify(id: string, machine: string | null): string {
  return machine ? `${machine}/${id}` : id;
}

/** Parses a doc value defensively; anything unexpected yields no spaces. */
export function asLayoutDoc(value: unknown): LayoutDoc {
  if (typeof value !== 'object' || value === null) return {};
  const spaces = (value as { spaces?: unknown }).spaces;
  return Array.isArray(spaces) ? { spaces: spaces.filter((s): s is LayoutSpace => typeof s?.id === 'string') } : {};
}
