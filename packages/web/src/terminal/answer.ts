import { TERMINAL_LIMITS } from '@herdr-mobile/protocol';
import type { Step } from './prompt';
import type { TerminalClient } from './streams';

/** A beat between steps, so the agent has drawn the last one before the next arrives. */
const STEP_GAP_MS = 80;

/**
 * Types an answer's steps in order: keys as `term.answer` (only while it's blocked, on the turn seen),
 * text as a paste without Enter (into the free-text field the keys before it opened).
 */
export async function runSteps(
  terminals: Pick<TerminalClient, 'answer' | 'send'>,
  terminalId: string,
  turn: number | undefined,
  steps: readonly Step[],
  gapMs = STEP_GAP_MS,
): Promise<void> {
  for (let s = 0; s < steps.length; s++) {
    const step = steps[s] as Step;
    if (s > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
    if ('paste' in step) await terminals.send(terminalId, step.paste, true, false);
    else
      for (let i = 0; i < step.keys.length; i += TERMINAL_LIMITS.maxAnswerKeys)
        await terminals.answer(terminalId, step.keys.slice(i, i + TERMINAL_LIMITS.maxAnswerKeys), turn);
  }
}
