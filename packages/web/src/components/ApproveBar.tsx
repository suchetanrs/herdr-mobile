import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTapFocus, useTapGuard } from '../hooks/gestures';
import { highlighted, nextSteps, otherSteps, type Prompt, type PromptOption, pickSteps, type Step, tabSteps } from '../terminal/prompt';
import { Icon } from './Icon';

const FALLBACK: Prompt = {
  kind: 'menu',
  question: null,
  cursor: null,
  options: [
    { key: 'y', label: 'Yes' },
    { key: 'n', label: 'No' },
  ],
};

const isNo = (label: string) => /^(no\b|deny|reject|cancel|don.?t)/i.test(label);

/**
 * When the agent is blocked: its question in full and one tap per answer, as its screen shows them
 * (Claude Code's permission menu, or an AskUserQuestion with its steps, descriptions, check marks,
 * multi-select and "Type something"), else y / n. Nothing is ever answered without a tap.
 */
export function ApproveBar({
  prompt,
  onSteps,
  onOpen,
  reading = false,
  inline = false,
  offline = false,
}: {
  prompt: Prompt | null;
  /** Types an answer (keys, a paste) into the agent's terminal. */
  onSteps: (steps: Step[]) => Promise<void>;
  /** Inline: "Type something" opens the agent (typing needs room). */
  onOpen?: () => void;
  /** The screen isn't read yet: hold the answers back rather than offer y / n that may be wrong. */
  reading?: boolean;
  /** In a list, under the agent's own line (which already says "Needs you"). */
  inline?: boolean;
  /** Not connected: the question stays visible, answering waits. */
  offline?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [typing, setTyping] = useState<string | null>(null);
  const guard = useTapGuard<HTMLElement>();
  const otherInput = useRef<HTMLInputElement | null>(null);
  const tapFocus = useTapFocus<HTMLInputElement>();
  const otherRef = useCallback(
    (el: HTMLInputElement | null) => {
      otherInput.current = el;
      tapFocus(el);
    },
    [tapFocus],
  );
  const p = prompt ?? FALLBACK;
  const questionKey = `${p.kind}|${p.question ?? ''}|${p.tab ?? ''}`;
  // Another question on screen: close the text field.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the question.
  useEffect(() => setTyping(null), [questionKey]);

  const run = async (steps: Step[], id: string) => {
    if (!steps.length) return;
    setBusy(id);
    try {
      await onSteps(steps);
    } finally {
      setBusy(null);
    }
  };
  const disabled = busy !== null || offline;
  const lit = highlighted(p);
  const tabs = !inline && p.tabs && p.tabs.length > 1 ? p.tabs : null;
  const options = reading ? [] : p.options;

  const submitText = (e: FormEvent) => {
    e.preventDefault();
    if (typing === null) return;
    void run(otherSteps(p, typing.trim()), 'other').then(() => setTyping(null));
  };

  const option = (o: PromptOption, i: number) => {
    const id = `o${o.key}`;
    if (o.other && typing !== null && !inline)
      return (
        <form key={id} className="approve-other" onSubmit={submitText}>
          <input
            ref={otherRef}
            className="approve-other-input"
            aria-label="Your answer"
            placeholder="Type your answer"
            value={typing}
            enterKeyHint="send"
            onChange={(e) => setTyping(e.target.value)}
          />
          <button type="submit" className="approve-other-send" disabled={disabled} aria-label="Send answer">
            {busy === 'other' ? <Icon name="spinner" size={14} spin /> : <Icon name="send" size={15} />}
          </button>
          <button type="button" className="approve-other-cancel" aria-label="Cancel" onClick={() => setTyping(null)}>
            <Icon name="x" size={14} />
          </button>
        </form>
      );
    const press = () => {
      if (!o.other) void run(pickSteps(p, i), id);
      else if (inline) onOpen?.();
      else {
        // The field must exist and take focus within this tap (not after a later render), or iOS won't raise
        // its keyboard (the home-screen app least of all).
        flushSync(() => setTyping(o.text ?? ''));
        otherInput.current?.focus();
      }
    };
    const box = p.multi && !o.extra;
    return (
      <button
        key={id}
        type="button"
        className={`approve-btn${lit.has(i) ? ' primary' : ''}${p.cursor === i ? ' cursor' : ''}${isNo(o.label) ? ' deny' : ''}${o.extra ? ' extra' : ''}`}
        disabled={disabled}
        aria-pressed={box ? Boolean(o.checked) : undefined}
        onClick={press}
        title={o.other ? 'Type your own answer' : `Press ${o.key}`}
      >
        {busy === id ? (
          <Icon name="spinner" size={13} spin />
        ) : box ? (
          <span className={`approve-box${o.checked ? ' on' : ''}`}>{o.checked && <Icon name="check" size={12} />}</span>
        ) : (
          <span className="approve-key">{o.key}</span>
        )}
        <span className="approve-text">
          <span className="approve-label">
            {o.other && o.text ? o.text : o.label}
            {o.other && <Icon name="pencil" size={12} />}
            {o.checked && !box && <Icon name="check" size={13} />}
          </span>
          {!inline && o.description && <span className="approve-desc">{o.description}</span>}
        </span>
      </button>
    );
  };

  const question = <p className="approve-q">{reading ? 'Reading the question…' : (p.question ?? 'Waiting for your answer')}</p>;

  return (
    <section ref={guard} className={`approve${inline ? ' inline' : ''}`} aria-label="The agent needs you">
      <div className="approve-head">
        {inline ? question : <span className="st st-pill">Needs you</span>}
        {tabs && (
          <nav className="approve-tabs" aria-label="Questions">
            {tabs.map((t, i) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: the agent's own tab order.
                key={i}
                type="button"
                className={`approve-tab${i === p.tab ? ' on' : ''}${t.answered ? ' done' : ''}`}
                aria-current={i === p.tab ? 'step' : undefined}
                disabled={disabled || p.tab === null || p.tab === undefined}
                onClick={() => void run(tabSteps(p, i), `tab${i}`)}
              >
                {t.answered || t.submit ? <Icon name="check" size={11} /> : <span className="approve-tab-box" />}
                {t.label}
              </button>
            ))}
          </nav>
        )}
        <button
          type="button"
          className="approve-dismiss"
          disabled={disabled}
          onClick={() => void run([{ keys: ['esc'] }], 'esc')}
          title="Press Esc"
        >
          {busy === 'esc' ? <Icon name="spinner" size={12} spin /> : <span className="approve-key">esc</span>}
          Dismiss
        </button>
      </div>
      {!inline && question}
      {!inline && !reading && p.detail && <pre className="approve-detail">{p.detail.join('\n')}</pre>}
      {!reading && p.review && (
        <ul className="approve-review">
          {p.review.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: as shown.
            <li key={i}>
              <span className="approve-review-q">{r.question}</span>
              <span className="approve-review-a">→ {r.answer}</span>
            </li>
          ))}
          {p.warning && <li className="approve-warning">{p.warning}</li>}
        </ul>
      )}
      <div className="approve-actions">
        {reading && (
          <span className="approve-reading">
            <Icon name="spinner" size={13} spin />
          </span>
        )}
        {options.map((o, i) => (o.extra ? null : option(o, i)))}
        {!reading && p.next && (
          <button
            type="button"
            className={`approve-btn approve-next${p.cursor === 'next' ? ' cursor' : ''}`}
            disabled={disabled}
            onClick={() => void run(nextSteps(p), 'next')}
          >
            {busy === 'next' ? <Icon name="spinner" size={13} spin /> : <Icon name="chevron-right" size={14} />}
            <span className="approve-label">{p.next}</span>
          </button>
        )}
        {options.map((o, i) => (o.extra ? option(o, i) : null))}
      </div>
    </section>
  );
}
