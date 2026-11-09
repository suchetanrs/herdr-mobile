import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CoreTerminal } from '../src/core/types.js';
import { loadPrograms, ProgramNames, programName } from '../src/programs.js';
import { terminalLabel } from '../src/world/derive.js';
import { agentName } from '../src/world/names.js';
import { rmDir, tmpDir } from './helpers/tmp.js';

describe('agent names (programs.rs `name`)', () => {
  it('come from the programs table: key, then match names, any case, else the app itself', () => {
    const cases: Array<[string, string]> = [
      ['claude', 'Claude Code'],
      ['claude-code', 'Claude Code'],
      ['codex', 'Codex'],
      ['cursor-agent', 'Cursor'],
      ['kiro-cli', 'Kiro'],
      ['kiro', 'Kiro'],
      ['gemini', 'Gemini'],
      ['kimi', 'Kimi'],
      ['kimi-code', 'Kimi'],
      ['kimicodecli', 'Kimi'],
      ['github-copilot', 'Copilot'],
      ['grok-build', 'Grok'],
      ['agy', 'Antigravity'],
      ['qodercli', 'Qoder'],
      ['Gemini', 'Gemini'],
      ['KIRO-CLI', 'Kiro'],
      ['some-new-agent', 'some-new-agent'],
    ];
    for (const [app, name] of cases) expect(agentName(app), app).toBe(name);
  });

  it('label terminals without a name the same way', () => {
    const kiro = { address: 't1', status: { app: 'kiro-cli' } } as unknown as CoreTerminal;
    expect(terminalLabel({ ...kiro, name: 'mine' })).toBe('mine');
    expect(terminalLabel(kiro)).toBe('Kiro');
    expect(terminalLabel(kiro, () => 'X')).toBe('X');
  });

  it('follow the person’s programs.json (read only), as Herdr does when it changes', () => {
    const dir = tmpDir('programs');
    let now = 0;
    try {
      const file = path.join(dir, 'programs.json');
      const names = new ProgramNames(dir, 1000, () => now);
      expect(names.name('kiro-cli')).toBe('Kiro');
      fs.writeFileSync(
        file,
        JSON.stringify({
          programs: {
            kiro: { name: 'Kiro (work)' },
            mine: { match: ['my-agent'] },
            codex: { match: ['codex-cli'] },
            gemini: { name: null, run: ['gemini', '--yolo'] },
          },
        }),
      );
      fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
      // Not looked at again until the check interval passes.
      expect(names.name('kiro-cli')).toBe('Kiro');
      now = 1000;
      expect(names.name('kiro-cli')).toBe('Kiro (work)');
      expect(names.name('my-agent')).toBe('mine');
      expect(names.name('codex-cli')).toBe('Codex');
      expect(names.name('gemini')).toBe('Gemini');
      const table = loadPrograms(dir);
      expect(table.get('gemini')).toEqual({ name: 'Gemini', run: ['gemini', '--yolo'] });
      expect(table.get('kimi')?.match).toEqual(['kimi-code', 'kimicodecli']);
      // Herdr refuses a file with a wrong type anywhere and keeps its built-ins.
      fs.writeFileSync(file, JSON.stringify({ programs: { kiro: { name: 'Kiro (work)' }, bad: { match: 'x' } } }));
      fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
      now = 2000;
      expect(names.name('kiro-cli')).toBe('Kiro');
      fs.writeFileSync(file, '{ not json');
      expect(programName(loadPrograms(dir), 'kiro-cli')).toBe('Kiro');
      fs.rmSync(file);
      now = 3000;
      expect(names.name('my-agent')).toBe('my-agent');
    } finally {
      rmDir(dir);
    }
  });

  it('let the first key in byte order win a shared match name, as Herdr’s BTreeMap does', () => {
    const dir = tmpDir('programs');
    try {
      fs.writeFileSync(
        path.join(dir, 'programs.json'),
        JSON.stringify({ programs: { zed: { name: 'Zed', match: ['shared'] }, alpha: { name: 'Alpha', match: ['shared'] } } }),
      );
      expect(programName(loadPrograms(dir), 'shared')).toBe('Alpha');
    } finally {
      rmDir(dir);
    }
  });
});
