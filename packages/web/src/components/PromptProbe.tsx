import { Suspense, useCallback, useRef } from 'react';
import { PROMPT_HISTORY, type Prompt, parsePrompt } from '../terminal/prompt';
import type { TerminalApi } from '../terminal/TerminalPane';
import { TerminalPane } from '../views/lazy';

/**
 * A blocked agent's question and numbered answers, read off its terminal, which is streamed unseen
 * (observe only: it never resizes, never types). `onPrompt(null)`: nothing to parse (y / n then).
 */
export function PromptProbe({
  terminalId,
  onPrompt,
  apiRef,
}: {
  terminalId: string;
  onPrompt: (p: Prompt | null) => void;
  /** The unseen terminal's api, for a parent that also types into it. */
  apiRef?: (api: TerminalApi | null) => void;
}) {
  const api = useRef<TerminalApi | null>(null);
  const read = useCallback(() => {
    const screen = api.current?.screen(PROMPT_HISTORY);
    if (!screen?.lines.some((l) => l.trim())) return;
    onPrompt(parsePrompt(screen));
  }, [onPrompt]);
  const setApi = useCallback(
    (a: TerminalApi | null) => {
      api.current = a;
      apiRef?.(a);
    },
    [apiRef],
  );
  return (
    <Suspense fallback={null}>
      <div className="term-offscreen" aria-hidden="true">
        <TerminalPane key={`ask-${terminalId}`} terminalId={terminalId} ref={setApi} onOutput={read} defaultZoom="fit" />
      </div>
    </Suspense>
  );
}
