import { type FormEvent, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSettings } from '../hooks/app';
import { drafts } from '../lib/drafts';
import { Icon } from './Icon';

export function loadDraft(terminalId: string): string {
  return drafts.get(terminalId);
}

export function saveDraft(terminalId: string, text: string): void {
  drafts.set(terminalId, text);
}

/**
 * The chat-style input: grows with its text, expands to half the screen,
 * keeps a draft per agent. On a hardware keyboard Enter sends and Shift+Enter
 * makes a new line; on a phone the button sends.
 */
export function Composer({
  terminalId,
  placeholder,
  onSend,
  onCtrlChar,
  coarse,
}: {
  terminalId: string;
  placeholder: string;
  /** Resolves when the bridge took it; rejects to keep the text. */
  onSend: (text: string) => Promise<void>;
  /** Ctrl is armed: a typed character becomes ctrl+char (returns true when consumed). */
  onCtrlChar?: (ch: string) => boolean;
  /** Touch-first device: Enter makes a new line. */
  coarse: boolean;
}) {
  const settings = useSettings();
  const [text, setText] = useState(() => loadDraft(terminalId));
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Each agent has its own draft.
  useEffect(() => {
    setText(loadDraft(terminalId));
    setExpanded(false);
  }, [terminalId]);

  useEffect(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => saveDraft(terminalId, text), 250);
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [text, terminalId]);

  // Grows with its text (text is what changes its scrollHeight).
  // biome-ignore lint/correctness/useExhaustiveDependencies: text drives the measurement.
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta || expanded) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 132)}px`;
  }, [text, expanded]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const value = text;
    if (!value.trim() || sending) return;
    setSending(true);
    setText('');
    saveDraft(terminalId, '');
    try {
      await onSend(value);
      setExpanded(false);
    } catch {
      setText((cur) => (cur ? `${value}\n${cur}` : value));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (!coarse || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form className={`composer${expanded ? ' expanded' : ''}`} onSubmit={submit}>
      <button
        type="button"
        className="icon-btn composer-expand"
        aria-label={expanded ? 'Shrink' : 'Expand'}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => setExpanded((x) => !x)}
      >
        <Icon name={expanded ? 'collapse' : 'expand'} size={15} />
      </button>
      <textarea
        ref={ref}
        className="composer-input"
        rows={1}
        value={text}
        placeholder={placeholder}
        enterKeyHint={coarse ? 'enter' : 'send'}
        autoCapitalize="sentences"
        spellCheck
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onBeforeInput={(e) => {
          const data = (e.nativeEvent as InputEvent).data;
          if (data && data.length === 1 && onCtrlChar?.(data)) e.preventDefault();
        }}
        aria-label="Message"
      />
      <button
        type="submit"
        className="send-btn"
        disabled={!text.trim() || sending}
        aria-label={settings.sendEnter ? 'Send' : 'Type (no Enter)'}
        onPointerDown={(e) => e.preventDefault()}
      >
        {sending ? <Icon name="spinner" size={15} spin /> : <Icon name="send" size={16} />}
      </button>
    </form>
  );
}
