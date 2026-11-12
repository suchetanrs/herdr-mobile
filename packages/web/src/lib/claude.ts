import type { ClaudeSettingKind, ClaudeSettingOptions, ClaudeSettingResult } from '@herdr-mobile/protocol';
import { call } from './spaces';

const url = (terminalId: string, kind: ClaudeSettingKind) => `/api/agents/${encodeURIComponent(terminalId)}/claude/${kind}`;

/** The models / effort levels a Claude Code agent offers (read from its own menu) and the one in use. */
export const claudeSettingOptions = (terminalId: string, kind: ClaudeSettingKind, fetcher?: typeof fetch) =>
  call<ClaudeSettingOptions>(url(terminalId, kind), {}, fetcher);

/** Switches it for this session; resolves once Claude confirmed. */
export const chooseClaudeSetting = (terminalId: string, kind: ClaudeSettingKind, value: string, fetcher?: typeof fetch) =>
  call<ClaudeSettingResult>(url(terminalId, kind), { method: 'POST', body: JSON.stringify({ value }) }, fetcher);
