import type { ConversationMeta, ConvItem, NoticeItem, TerminalView, ThinkingItem, UserItem } from '@herdr-mobile/protocol';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { useNow, useServices } from '../hooks/app';
import { copyText } from '../lib/copy';
import { speech } from '../lib/speech';
import type { Conversation, ConversationState } from './client';
import { Markdown } from './Markdown';
import { SpeakButton, SpeechDock, useSpeech, useSpeechHighlight } from './ReadAloud';
import { ToolCard } from './ToolCard';
import '../styles/conversation.css';

export function useConversation(terminalId: string): { conv: Conversation | null; state: ConversationState | null } {
  const { conversations } = useServices();
  const [conv, setConv] = useState<Conversation | null>(null);
  useEffect(() => {
    const c = conversations.open(terminalId);
    setConv(c);
    return () => c.close();
  }, [conversations, terminalId]);
  const state = useSyncExternalStore(
    useCallback((l: () => void) => (conv ? conv.subscribe(l) : () => {}), [conv]),
    () => conv?.get() ?? null,
  );
  return { conv, state };
}

export function formatDuration(ms: number): string {
  if (ms < 9950) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const clock = (ts: number | null) => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState<'ok' | 'failed' | null>(null);
  return (
    <>
      <button
        type="button"
        className="msg-act"
        onClick={async () => {
          setDone((await copyText(text)) ? 'ok' : 'failed');
          setTimeout(() => setDone(null), 1500);
        }}
        aria-label={label}
        title={label}
      >
        <Icon name={done === 'ok' ? 'check' : 'copy'} size={13} />
      </button>
      {done && (
        <span className="msg-copied" role="status">
          {done === 'ok' ? 'Copied' : 'Couldn’t copy'}
        </span>
      )}
    </>
  );
}

function UserBubble({ it }: { it: UserItem }) {
  if (it.source !== 'prompt') {
    return (
      <div className="msg-user cmd">
        <span className="cmd-chip">
          {it.source === 'shell' && <span className="cmd-bang">!</span>}
          {it.text}
        </span>
      </div>
    );
  }
  return (
    <div className="msg-user">
      <div className="bubble">
        {it.images > 0 && (
          <span className="bubble-img">
            {it.images === 1 ? '1 image' : `${it.images} images`}
            {it.text ? ' · ' : ''}
          </span>
        )}
        {it.text}
        {it.truncated && <span className="clip-note"> (clipped)</span>}
      </div>
      <div className="msg-meta">{clock(it.ts)}</div>
    </div>
  );
}

function Thinking({ it }: { it: ThinkingItem }) {
  const label = it.durationMs ? `Thought for ${formatDuration(it.durationMs)}` : 'Thinking';
  if (!it.text.trim()) {
    return (
      <div className="thinking bare">
        <Icon name="sparkles" size={12} />
        {label}
      </div>
    );
  }
  return (
    <details className="thinking">
      <summary>
        <Icon name="sparkles" size={12} />
        {label}
        <Icon name="chevron-right" size={11} className="thinking-chev" />
      </summary>
      <div className="thinking-text">{it.text}</div>
    </details>
  );
}

const NOTICE_ICON: Record<NoticeItem['notice'], IconName> = {
  compact: 'layers',
  interrupt: 'ban',
  task: 'bell',
  message: 'mail',
  output: 'corner-down-right',
  error: 'alert',
  turn: 'clock',
  recap: 'history',
  info: 'circle-help',
};

function Notice({ it }: { it: NoticeItem }) {
  if (it.notice === 'turn') {
    return (
      <div className="turn-end">
        <span>
          {it.durationMs ? `Worked for ${formatDuration(it.durationMs)}` : 'Done'}
          {it.ts ? ` · ${clock(it.ts)}` : ''}
        </span>
      </div>
    );
  }
  if (it.notice === 'output') {
    return <pre className="cmd-out">{it.text}</pre>;
  }
  const body = (
    <>
      <Icon name={NOTICE_ICON[it.notice]} size={12} />
      <span className="notice-text">{it.notice === 'recap' ? `Recap: ${it.text}` : it.text}</span>
    </>
  );
  if (it.detail) {
    return (
      <details className={`notice n-${it.notice}`}>
        <summary>
          {body}
          <Icon name="chevron-right" size={11} className="thinking-chev" />
        </summary>
        <Markdown text={it.detail} className="md-sm notice-detail" />
      </details>
    );
  }
  return <div className={`notice n-${it.notice}`}>{body}</div>;
}

const Row = memo(function Row({
  it,
  cwd,
  waiting,
  reply,
  replyId,
  owner,
}: {
  it: ConvItem;
  cwd: string | null;
  waiting: boolean;
  /** The last text of a message carries the whole message, to copy and read aloud. */
  reply: string | null;
  /** The message this text belongs to (its last text's id), for the read-aloud highlight. */
  replyId: string | undefined;
  owner: string;
}) {
  switch (it.kind) {
    case 'user':
      return <UserBubble it={it} />;
    case 'assistant':
      return (
        <div className="msg-agent" data-reply={replyId}>
          <Markdown text={it.text} />
          {(reply !== null || it.truncated) && (
            <div className="msg-actions">
              {reply !== null && <CopyButton text={reply} label="Copy the reply" />}
              {reply !== null && <SpeakButton owner={owner} replyId={it.id} text={reply} />}
              {it.truncated && <span className="clip-note">Clipped: the terminal has all of it.</span>}
            </div>
          )}
        </div>
      );
    case 'thinking':
      return <Thinking it={it} />;
    case 'tool':
      return <ToolCard t={it} cwd={cwd} waiting={waiting} />;
    case 'notice':
      return <Notice it={it} />;
  }
});

/**
 * For each message (a run of the agent's texts with nothing else between them; a tool call, thinking, notice or prompt
 * ends it): its last text's id -> the message's text, and each of its texts' ids -> that last id. One Claude turn
 * holds several messages ("Got it. ...", tool calls, the answer); copy and read aloud act on one message only.
 */
function replies(items: readonly ConvItem[]): { text: Map<string, string>; of: Map<string, string> } {
  const text = new Map<string, string>();
  const of = new Map<string, string>();
  let texts: string[] = [];
  let ids: string[] = [];
  const close = () => {
    const last = ids[ids.length - 1];
    if (last) {
      text.set(last, texts.join('\n\n'));
      for (const id of ids) of.set(id, last);
    }
    texts = [];
    ids = [];
  };
  for (const it of items) {
    if (it.kind !== 'assistant') close();
    else {
      texts.push(it.text);
      ids.push(it.id);
    }
  }
  close();
  return { text, of };
}

function shownItem(it: ConvItem): boolean {
  if (it.kind === 'thinking') return Boolean(it.text.trim() || it.durationMs);
  return true;
}

function modelName(m: string): string {
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function MetaBar({ meta, name }: { meta: ConversationMeta; name: string }) {
  const parts: string[] = [];
  if (meta.model) parts.push(modelName(meta.model));
  if (meta.contextTokens) parts.push(`${Math.round(meta.contextTokens / 1000)}k context`);
  if (meta.costUsd != null && meta.costUsd > 0) parts.push(`$${meta.costUsd.toFixed(2)}`);
  if (!meta.title && parts.length === 0) return null;
  return (
    <div className="conv-meta">
      {meta.title && meta.title !== name && <span className="conv-title">{meta.title}</span>}
      <span className="conv-facts">{parts.join(' · ')}</span>
    </div>
  );
}

function Working({ since, onStop }: { since: number | null; onStop: () => void }) {
  const now = useNow(1000);
  return (
    <div className="working-row" aria-live="polite">
      <span className="working-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="working-text">Working{since ? ` · ${formatDuration(now - since)}` : '…'}</span>
      <button type="button" className="stop-btn" onClick={onStop} title="Press Esc in the terminal (interrupts the agent)">
        <Icon name="stop" size={12} />
        Stop
      </button>
    </div>
  );
}

/**
 * Screen 3's Conversation tab: the agent's transcript as a chat, live.
 * Follows the end while you're at the end; scrolling up stops that and shows
 * a jump-to-latest pill; older turns load as you reach the top.
 */
export function ConversationView({
  t,
  onStop,
  onShowTerminal,
}: {
  t: TerminalView;
  /** Interrupt the agent (Esc). */
  onStop: () => void;
  onShowTerminal: () => void;
}) {
  const { conv, state } = useConversation(t.id);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const anchor = useRef(0);
  const prevFirst = useRef<string | null>(null);
  const prevCount = useRef(0);
  const prevEpoch = useRef(-1);
  const [away, setAway] = useState(false);
  const [unread, setUnread] = useState(0);
  const spoken = useSpeech();
  useSpeechHighlight(spoken, t.id, content, scroller);
  // Reading stops (paused, resumable at the same sentence) when this view goes or the page is hidden.
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') speech.suspend(t.id);
    };
    const gone = () => speech.suspend(t.id);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', gone);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', gone);
      speech.suspend(t.id);
    };
  }, [t.id]);

  const items = useMemo(() => (state?.items ?? []).filter(shownItem), [state?.items]);
  const replyText = useMemo(() => replies(items), [items]);
  const working = t.status === 'working' || t.word === 'working';
  const blocked = t.status === 'blocked' || t.word === 'blocked';
  const waitingId = useMemo(() => {
    if (!blocked) return null;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it?.kind === 'tool') return it.result ? null : it.id;
      if (it?.kind === 'user') return null;
    }
    return null;
  }, [blocked, items]);

  const toEnd = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    setAway(false);
    setUnread(0);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const fromEnd = el.scrollHeight - el.scrollTop - el.clientHeight;
    anchor.current = el.scrollHeight - el.scrollTop;
    stick.current = fromEnd < 48;
    setAway(fromEnd > 240);
    if (stick.current) setUnread(0);
    if (el.scrollTop < 600) conv?.loadOlder();
  };

  // Keep the place: follow the end, or hold still while older items are put above.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !state) return;
    const first = items[0]?.id ?? null;
    if (state.epoch !== prevEpoch.current) {
      prevEpoch.current = state.epoch;
      stick.current = true;
      el.scrollTop = el.scrollHeight;
    } else if (prevFirst.current !== null && first !== prevFirst.current && items.length > prevCount.current) {
      el.scrollTop = el.scrollHeight - anchor.current;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    } else if (items.length > prevCount.current) {
      const added = items.length - prevCount.current;
      setUnread((n) => n + added);
    }
    prevFirst.current = first;
    prevCount.current = items.length;
    anchor.current = el.scrollHeight - el.scrollTop;
    // Not enough to scroll yet: fetch more history right away.
    if (el.scrollHeight <= el.clientHeight + 80) conv?.loadOlder();
  }, [items, state, conv]);

  // Late layout (code highlighting, a card opening at the end, the keyboard): stay at the end if we were there.
  const shown = state?.status === 'live' || (state?.status === 'error' && state.items.length > 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attach when the list is (re)drawn.
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shown]);

  if (!state || state.status === 'loading') {
    return (
      <div className="conv">
        <div className="conv-loading">
          <Icon name="spinner" size={16} spin />
          Loading the conversation…
        </div>
      </div>
    );
  }
  if (state.status === 'none' || state.status === 'gone' || (state.status === 'error' && state.items.length === 0)) {
    return (
      <div className="conversation-empty">
        <Icon name="message" size={28} />
        <h3>{state.status === 'error' ? 'Couldn’t load the conversation' : 'No conversation to show'}</h3>
        <p>
          {state.status === 'error'
            ? (state.error ?? 'The bridge could not read the transcript.')
            : state.status === 'gone'
              ? 'This terminal is gone.'
              : 'This agent has no transcript the bridge can read (only Claude Code’s, for now).'}
        </p>
        <button type="button" className="btn" onClick={onShowTerminal}>
          <Icon name="terminal" size={13} />
          Show the terminal
        </button>
      </div>
    );
  }

  const docked = spoken.owner === t.id && spoken.key !== null;
  return (
    <div className={`conv${docked ? ' speaking' : ''}`}>
      <MetaBar meta={state.meta} name={t.name ?? t.title} />
      <div className="conv-scroll" ref={scroller} onScroll={onScroll}>
        <div className="conv-list" ref={content}>
          {state.before !== null ? (
            <button type="button" className="conv-older" disabled={state.loadingOlder} onClick={() => conv?.loadOlder()}>
              {state.loadingOlder ? <Icon name="spinner" size={12} spin /> : <Icon name="history" size={12} />}
              {state.loadingOlder ? 'Loading earlier messages…' : 'Load earlier messages'}
            </button>
          ) : (
            <div className="conv-start">Start of this session</div>
          )}
          {items.length === 0 && !working && <div className="conv-quiet">Nothing here yet. Send a message below.</div>}
          {items.map((it) => (
            <div key={it.id} className={`row row-${it.kind}${it.kind === 'notice' ? ` row-n-${it.notice}` : ''}`}>
              <Row
                it={it}
                cwd={t.cwd}
                waiting={it.id === waitingId}
                reply={replyText.text.get(it.id) ?? null}
                replyId={replyText.of.get(it.id)}
                owner={t.id}
              />
            </div>
          ))}
          {working && <Working since={t.statusMs} onStop={onStop} />}
          {blocked && !waitingId && (
            <div className="working-row blocked">
              <Icon name="circle-help" size={13} />
              <span className="working-text">Waiting for your answer below</span>
            </div>
          )}
        </div>
      </div>
      {away && (
        <button type="button" className="jump-pill" onClick={() => toEnd(true)}>
          <Icon name="arrow-down" size={13} />
          {unread > 0 ? `${unread} new` : 'Latest'}
        </button>
      )}
      {state.stale && <div className="conv-stale">Reconnecting… showing what was loaded</div>}
      {docked && <SpeechDock s={spoken} />}
    </div>
  );
}
