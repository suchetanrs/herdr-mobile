import fs from 'node:fs';
import path from 'node:path';
import {
  APP_LINES,
  APP_NAME,
  ASK_NAME,
  CONV_DIR,
  CONV_FILE,
  CONV_NAME,
  HIST_LINES,
  HIST_NAME,
  hcJson,
  MULTI_MESSAGES,
  READ_ALOUD_REPLY,
  REPO,
  removeTerminal,
  SHELL_NAME,
  STATE_FILE,
  type State,
  sizeOf,
  startInstance,
  stopInstance,
  throwaway,
  until,
  WORK,
} from './lib/env.js';

/** A short Claude Code-shaped transcript for the Conversation tab. */
function seedTranscript(): void {
  fs.rmSync(CONV_DIR, { recursive: true, force: true });
  fs.mkdirSync(CONV_DIR, { recursive: true });
  const t = (s: number) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
  const lines = [
    { type: 'custom-title', customTitle: 'e2e-session' },
    {
      type: 'user',
      uuid: '00000000-0000-4000-8000-000000000011',
      timestamp: t(-10),
      message: { role: 'user', content: 'E2E read-aloud prompt' },
    },
    {
      type: 'assistant',
      uuid: '00000000-0000-4000-8000-000000000012',
      timestamp: t(-9),
      message: {
        id: 'm0',
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [{ type: 'text', text: READ_ALOUD_REPLY }],
        usage: { input_tokens: 3, output_tokens: 40 },
      },
    },
    {
      type: 'user',
      uuid: '00000000-0000-4000-8000-000000000021',
      timestamp: t(-8),
      message: { role: 'user', content: 'E2E multi-message prompt' },
    },
    ...MULTI_MESSAGES.flatMap((text, i) => {
      const n = 22 + i * 3;
      const id = (k: number) => `00000000-0000-4000-8000-0000000000${n + k}`;
      const at = t(-7 + i * 0.5);
      const said = {
        type: 'assistant',
        uuid: id(0),
        timestamp: at,
        message: { id: `mm${i}`, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text }] },
      };
      if (i === MULTI_MESSAGES.length - 1) return [said];
      return [
        said,
        {
          type: 'assistant',
          uuid: id(1),
          timestamp: at,
          message: {
            id: `mm${i}`,
            model: 'claude-opus-5-5',
            role: 'assistant',
            content: [{ type: 'tool_use', id: `toolu_mm${i}`, name: 'Bash', input: { command: 'true', description: 'Check' } }],
          },
        },
        {
          type: 'user',
          uuid: id(2),
          timestamp: at,
          message: { role: 'user', content: [{ tool_use_id: `toolu_mm${i}`, type: 'tool_result', content: '', is_error: false }] },
          toolUseResult: { stdout: '', stderr: '', interrupted: false },
        },
      ];
    }),
    {
      type: 'user',
      uuid: '00000000-0000-4000-8000-000000000001',
      timestamp: t(0),
      message: { role: 'user', content: 'E2E seeded prompt: say hello' },
    },
    {
      type: 'assistant',
      uuid: '00000000-0000-4000-8000-000000000002',
      timestamp: t(1),
      message: {
        id: 'm1',
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from the **seeded** transcript.' }],
        usage: { input_tokens: 3, output_tokens: 8 },
      },
    },
    {
      type: 'system',
      subtype: 'turn_duration',
      durationMs: 1200,
      isMeta: false,
      uuid: '00000000-0000-4000-8000-000000000003',
      timestamp: t(2),
    },
  ];
  fs.writeFileSync(CONV_FILE, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(WORK, { recursive: true });
  await stopInstance();
  // Leftovers of an interrupted run.
  for (const t of hcJson('ls').terminals as Array<{ name?: string; address: string }>) {
    if (t.name === SHELL_NAME || t.name === CONV_NAME || t.name === ASK_NAME || t.name === HIST_NAME || t.name === APP_NAME)
      removeTerminal(t.address);
  }
  seedTranscript();
  const cwd = path.join(WORK, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const shell = throwaway(SHELL_NAME, ['bash', '--norc', '--noprofile', '-i'], cwd);
  const conv = throwaway(CONV_NAME, ['python3', path.join(REPO, 'scripts/fake-agent.py'), CONV_FILE], cwd);
  await until(() => hcJson('read', conv).text.includes('fake agent ready'), 8000);
  const ask = throwaway(ASK_NAME, ['python3', path.join(REPO, 'scripts/fake-ask.py')], cwd);
  await until(() => hcJson('read', ask).text.includes('Do you want to proceed?'), 8000);
  // Far more than herdr-core keeps (~5 MB of rows), in 7 colors.
  const print = `awk 'BEGIN{for(i=1;i<=${HIST_LINES};i++) printf "hist %05d \\033[3%dmcolor%d\\033[0m\\n", i, i%7+1, i%7+1}'`;
  const hist = throwaway(HIST_NAME, ['bash', '-c', `${print}; exec bash --norc --noprofile -i`], cwd);
  await until(() => hcJson('read', hist).text.includes(`hist ${String(HIST_LINES).padStart(5, '0')}`), 15_000);
  fs.writeFileSync(path.join(cwd, 'app.txt'), Array.from({ length: APP_LINES }, (_, i) => `app line ${i + 1}\n`).join(''));
  const app = throwaway(APP_NAME, ['less', '--mouse', '+G', 'app.txt'], cwd);
  await until(() => hcJson('read', app).text.includes('(END)'), 8000);
  const state: State = { shell, conv, ask, hist, app, shellSize: sizeOf(shell) };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  await startInstance();
}
