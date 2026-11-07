/** Builders for synthetic Claude Code transcript entries (shapes from real ~/.claude/projects files). */

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const at = (s: number) => new Date(Date.UTC(2026, 10, 7, 3, 0, s)).toISOString();

export const entry = {
  prompt: (text: string, s = 0) => ({
    type: 'user',
    uuid: uuid(),
    timestamp: at(s),
    isSidechain: false,
    message: { role: 'user', content: text },
    origin: { kind: 'human' },
  }),
  text: (text: string, s = 0, model = 'claude-opus-5-5') => ({
    type: 'assistant',
    uuid: uuid(),
    timestamp: at(s),
    isSidechain: false,
    message: {
      id: `msg_${n}`,
      model,
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, output_tokens: 10 },
    },
  }),
  thinking: (text: string, s = 0) => ({
    type: 'assistant',
    uuid: uuid(),
    timestamp: at(s),
    thinkingDurationMs: 1200,
    message: {
      id: `msg_${n}`,
      model: 'claude-opus-5-5',
      role: 'assistant',
      content: [{ type: 'thinking', thinking: text, signature: 'x' }],
    },
  }),
  tool: (id: string, name: string, input: unknown, s = 0) => ({
    type: 'assistant',
    uuid: uuid(),
    timestamp: at(s),
    message: { id: `msg_${n}`, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  }),
  result: (id: string, content: unknown, toolUseResult: unknown, isError = false, s = 0) => ({
    type: 'user',
    uuid: uuid(),
    timestamp: at(s),
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, is_error: isError }] },
    toolUseResult,
  }),
  system: (subtype: string, more: Record<string, unknown> = {}, s = 0) => ({
    type: 'system',
    subtype,
    uuid: uuid(),
    timestamp: at(s),
    isMeta: false,
    ...more,
  }),
  meta: (text: string) => ({ type: 'user', uuid: uuid(), timestamp: at(0), isMeta: true, message: { role: 'user', content: text } }),
  title: (customTitle: string) => ({ type: 'custom-title', customTitle, sessionId: 's' }),
  cost: (totalCostUSD: number) => ({ type: 'cost-state', totalCostUSD }),
};

export const jsonl = (...entries: unknown[]) => entries.map((e) => `${JSON.stringify(e)}\n`).join('');
