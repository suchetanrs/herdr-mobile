import type { TerminalView, World } from '@herdr-mobile/protocol';
import { type CSSProperties, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentMenu } from '../components/AgentMenu';
import { type View, ViewSwitch, ZoomButton } from '../components/AgentTools';
import { ApproveBar } from '../components/ApproveBar';
import { ChunkBoundary } from '../components/ChunkBoundary';
import { Composer } from '../components/Composer';
import { Icon } from '../components/Icon';
import { type CtrlState, KeyBar, withCtrl } from '../components/KeyBar';
import { ProgramIcon } from '../components/ProgramIcon';
import { PromptProbe } from '../components/PromptProbe';
import { AlertsButton, BackButton, Screen } from '../components/Screen';
import { StatusGlyph, statusLabel } from '../components/Status';
import { TextSheet } from '../components/TextSheet';
import { useLive, useLooking, useServices, useSettings, useWorld } from '../hooks/app';
import { useMediaQuery } from '../hooks/dom';
import { useSwipe } from '../hooks/gestures';
import { folder } from '../lib/format';
import { accountLabel, program, shownStatus, spaceIdOf, spaceTerminals, tabLabel, terminalName } from '../lib/model';
import { back, navigate } from '../lib/router';
import { settings as settingsStore } from '../lib/settings';
import { load, save } from '../lib/storage';
import { runSteps } from '../terminal/answer';
import { ctrlChar, ctrlKeyName } from '../terminal/input';
import { PROMPT_HISTORY, type Prompt, parsePrompt, type Step, typingIntoOther } from '../terminal/prompt';
import type { TerminalApi } from '../terminal/TerminalPane';
import type { Zoom } from '../terminal/zoom';
import { ConversationView, TerminalPane } from '../views/lazy';

/** The tab an agent opens on: the one last picked for it, else (with a transcript) the one Settings names. */
export function defaultView(t: TerminalView | undefined): View {
  const picked = t ? load<View | null>(`view.${t.id}`, null) : null;
  if (picked === 'terminal' || picked === 'conversation') return picked;
  return t?.transcript ? settingsStore.get().agentView : 'terminal';
}

function pickView(terminalId: string, view: View): void {
  save(`view.${terminalId}`, view);
  navigate({ name: 'agent', terminalId, view }, { replace: true });
}

/**
 * Under the agent's name: its space, the tab when that says something the name doesn't, and where it
 * is among the space's terminals (swipe to the others).
 */
export function agentPlace(t: TerminalView, world: World, index: number, count: number): string {
  const space = t.spaceId ? world.spaces[t.spaceId] : undefined;
  const tab = t.tabId ? world.tabs[t.tabId] : undefined;
  const parts: string[] = [space ? space.name : t.machine ? `${t.machine} · not in a space` : 'Not in a space'];
  const label = tab ? tabLabel(tab, world) : '';
  if (tab && label !== terminalName(t, world) && !/^\d+$/.test(label)) parts.push(label);
  if (count > 1) parts.push(`${index + 1} of ${count}`);
  return parts.join(' · ');
}

const LANDSCAPE_PHONE = '(orientation: landscape) and (max-height: 500px)';

/** Screen 3: one agent, live. Terminal or conversation, composer, quick keys, one-tap answers when it's blocked. */
export function AgentScreen({
  terminalId,
  view: asked,
  embedded = false,
}: {
  terminalId: string;
  /** From the address; none: the agent's default tab. */
  view?: View | undefined;
  embedded?: boolean;
}) {
  const world = useWorld();
  const { terminals, toasts } = useServices();
  const settings = useSettings();
  const coarse = useMediaQuery('(pointer: coarse)');
  const live = useLive();
  const landscape = useMediaQuery(LANDSCAPE_PHONE) && !embedded;
  const t = world.terminals[terminalId];
  const view = asked ?? defaultView(t);
  const [ctrl, setCtrl] = useState<CtrlState>('off');
  const [keyboardOn, setKeyboardOn] = useState(false);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [zoom, setZoom] = useState<{ z: Zoom; font: number } | null>(null);
  const [api, setApi] = useState<TerminalApi | null>(null);
  const [sheet, setSheet] = useState(false);
  const apiRef = useRef<TerminalApi | null>(null);
  const ctrlRef = useRef(ctrl);
  ctrlRef.current = ctrl;
  const status = t ? shownStatus(t) : null;
  const blocked = status === 'blocked' || t?.word === 'blocked';
  useLooking(t ? terminalId : null);

  const siblings = useMemo(() => (t ? spaceTerminals(world, spaceIdOf(t)) : []), [world, t]);
  const index = siblings.findIndex((s) => s.id === terminalId);
  const go = (dir: 1 | -1) => {
    const next = siblings[(index + dir + siblings.length) % siblings.length];
    if (next && next.id !== terminalId) {
      document.documentElement.dataset.swipe = dir > 0 ? 'next' : 'prev';
      // Each agent opens on its own tab.
      navigate({ name: 'agent', terminalId: next.id }, { replace: true });
    }
  };
  const swipe = useSwipe(go);

  const fail = useCallback(
    (what: string, err: unknown) => {
      toasts.show({ id: `err-${Date.now()}`, title: what, body: (err as Error)?.message ?? null, level: 'error', terminalId: null }, 5000);
    },
    [toasts],
  );

  const releaseCtrl = () => {
    if (ctrlRef.current === 'once') setCtrl('off');
  };

  const pressKey = (key: string) => {
    apiRef.current?.follow();
    const name = withCtrl(key, ctrlRef.current);
    releaseCtrl();
    terminals.keys(terminalId, [name]).catch((e) => fail(`Couldn't press ${name}`, e));
  };

  const paneRef = useCallback((a: TerminalApi | null) => {
    apiRef.current = a;
    setApi(a);
  }, []);

  // Whether the screen has been read since the agent got blocked (the Conversation tab reads an unseen terminal, which takes a moment).
  const [promptRead, setPromptRead] = useState(false);
  const [readTimedOut, setReadTimedOut] = useState(false);
  const gotPrompt = useCallback((p: Prompt | null) => {
    setPrompt(p);
    setPromptRead(true);
  }, []);
  const readPrompt = useCallback(() => {
    const screen = apiRef.current?.screen(PROMPT_HISTORY);
    if (!screen?.lines.some((l) => l.trim())) return;
    gotPrompt(parsePrompt(screen));
  }, [gotPrompt]);

  useEffect(() => {
    setPromptRead(false);
    setReadTimedOut(false);
    if (!blocked) {
      setPrompt(null);
      return;
    }
    readPrompt();
    const timer = setTimeout(() => setReadTimedOut(true), 2500);
    return () => clearTimeout(timer);
  }, [blocked, readPrompt]);

  // A different agent: start clean.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the agent changes.
  useEffect(() => {
    setCtrl('off');
    setKeyboardOn(false);
    setSheet(false);
  }, [terminalId]);

  if (!t) {
    return (
      <Screen
        bar={
          <header className="topbar">
            <BackButton onClick={() => back({ name: 'spaces' })} />
            <span className="topbar-title">Agent</span>
          </header>
        }
      >
        <div className="scroll">
          <div className="state-card">
            <Icon name={world.core.connected ? 'ban' : 'monitor'} size={22} />
            <h3>{world.core.connected ? 'This terminal is gone' : 'Waiting for Herdr…'}</h3>
            <p>{world.core.connected ? 'It was closed on the desktop.' : 'Its terminals show up again when Herdr is back.'}</p>
          </div>
        </div>
      </Screen>
    );
  }

  const p = program(t);
  const name = terminalName(t, world);
  const account = accountLabel(t);
  const send = async (text: string) => {
    apiRef.current?.follow();
    // Blocked on a question with the cursor on "Type something": the text goes into that field, pasted
    // (digits in it never pick options) and never with Enter (that would pick it, or untick it in a multi-select).
    const intoOther = blocked && typingIntoOther(prompt);
    if (blocked && !intoOther && prompt?.kind === 'ask') {
      const err = new Error('Pick an answer, or move to “Type something” (arrow keys) to type your own.');
      fail('Claude is asking a question', err);
      throw err;
    }
    try {
      // Without Enter it's still a paste (bracketed when asked): raw text would run a multi-line draft line by line.
      await terminals.send(terminalId, text, intoOther, intoOther ? false : settings.sendEnter);
    } catch (e) {
      fail("Couldn't send", e);
      throw e;
    }
  };
  const answer = async (steps: Step[]) => {
    apiRef.current?.follow();
    try {
      await runSteps(terminals, terminalId, t.turn, steps);
    } catch (e) {
      fail("Couldn't answer", e);
    }
  };

  const tools =
    view === 'terminal' ? (
      <>
        <ZoomButton zoom={zoom} api={api} />
        <button
          type="button"
          className="tool-btn"
          aria-label="Select and copy text"
          title="Select and copy text"
          disabled={!api}
          onClick={() => setSheet(true)}
        >
          <Icon name="scan-text" size={17} />
        </button>
      </>
    ) : null;
  const viewRow = (
    <div className="view-tabs">
      <ViewSwitch view={view} onPick={(v) => pickView(terminalId, v)} />
      <span className="spacer" />
      {tools}
    </div>
  );

  const chatStyle = !embedded && view === 'conversation' ? ({ '--fs': `${settings.chatFont}px` } as CSSProperties) : undefined;
  const body = (
    <>
      {!landscape && viewRow}
      <div className="agent-body" style={chatStyle} {...(view === 'conversation' && !embedded ? swipe : {})}>
        <ChunkBoundary key={view} what={view === 'terminal' ? 'terminal' : 'conversation'}>
          {view === 'terminal' ? (
            <Suspense
              fallback={
                <div className="term-wrap" data-phase="loading">
                  <div className="term-overlay">
                    <span className="term-overlay-text">
                      <Icon name="spinner" size={13} spin />
                      Loading the terminal…
                    </span>
                  </div>
                </div>
              }
            >
              <TerminalPane
                key={terminalId}
                terminalId={terminalId}
                clickToType={!coarse}
                defaultZoom={settings.termZoom}
                ref={paneRef}
                transformInput={(data) => {
                  if (ctrlRef.current === 'off' || data.length !== 1) return data;
                  const c = ctrlChar(data);
                  if (!c) return data;
                  releaseCtrl();
                  return c;
                }}
                onOutput={() => {
                  if (blocked) readPrompt();
                }}
                onZoom={(z, font) => setZoom({ z, font })}
              />
            </Suspense>
          ) : (
            <Suspense
              fallback={
                <div className="conv">
                  <div className="conv-loading">
                    <Icon name="spinner" size={16} spin />
                    Loading the conversation…
                  </div>
                </div>
              }
            >
              <ConversationView
                key={terminalId}
                t={t}
                onStop={() => terminals.keys(terminalId, ['esc']).catch((e) => fail("Couldn't press esc", e))}
                onShowTerminal={() => pickView(terminalId, 'terminal')}
              />
              {/* The terminal, unseen, only to read the agent's question and its numbered answers for the approve bar. */}
              {blocked && <PromptProbe terminalId={terminalId} onPrompt={gotPrompt} apiRef={paneRef} />}
            </Suspense>
          )}
        </ChunkBoundary>
      </div>
      <div className={`agent-input${landscape ? ' side' : ''}`}>
        {/* The Terminal tab has none: there the person answers on the terminal itself (arrows, quick keys, typing). */}
        {blocked && view === 'conversation' && (
          <ApproveBar prompt={prompt} onSteps={answer} reading={!promptRead && !readTimedOut} offline={!live} />
        )}
        <div className="agent-input-row">
          <Composer
            terminalId={terminalId}
            coarse={coarse}
            placeholder={blocked ? (typingIntoOther(prompt) ? 'Type your answer' : 'Answer or message') : 'Message'}
            onSend={send}
            onCtrlChar={(ch) => {
              if (ctrlRef.current === 'off') return false;
              const k = ctrlKeyName(ch);
              if (!k) return false;
              releaseCtrl();
              terminals.keys(terminalId, [k]).catch((e) => fail(`Couldn't press ${k}`, e));
              return true;
            }}
          />
          <KeyBar
            onKey={pressKey}
            ctrl={ctrl}
            onCtrl={setCtrl}
            keyboardOn={keyboardOn}
            onKeyboard={
              view === 'terminal'
                ? () => {
                    if (keyboardOn) apiRef.current?.blur();
                    else apiRef.current?.focusKeyboard();
                    setKeyboardOn(!keyboardOn);
                  }
                : undefined
            }
          />
        </div>
      </div>
      {sheet && <TextSheet title={name} read={() => apiRef.current?.text() ?? ''} onClose={() => setSheet(false)} />}
    </>
  );

  if (embedded) {
    return (
      <div className="pane-card focused">
        <div className="pane-head">
          <ProgramIcon program={p} size={14} />
          <span className="pane-name">{name}</span>
          <span className="pane-cwd">{folder(t.cwd)}</span>
          {account && (
            <span className="account" title={`Claude account: ${account}`}>
              {account}
            </span>
          )}
          <StatusGlyph status={status} />
          <AgentMenu t={t} small />
        </div>
        {body}
      </div>
    );
  }

  return (
    <Screen
      className={`agent-screen${landscape ? ' landscape' : ''}`}
      bar={
        <header className="topbar agent-bar" {...swipe}>
          <BackButton onClick={() => back(t.spaceId ? { name: 'space', spaceId: t.spaceId } : { name: 'spaces' })} />
          <ProgramIcon program={p} size={16} tile />
          <span className="topbar-stack">
            <span className="topbar-title">{name}</span>
            {!landscape && <span className="topbar-sub truncate">{agentPlace(t, world, index, siblings.length)}</span>}
          </span>
          <span className="agent-status" title={statusLabel(status)}>
            <StatusGlyph status={status} />
          </span>
          {account && (
            <span className="account agent-account" title={`Claude account: ${account}`}>
              {account}
            </span>
          )}
          <span className="spacer" />
          {landscape && (
            <>
              <ViewSwitch view={view} onPick={(v) => pickView(terminalId, v)} compact />
              {tools}
            </>
          )}
          <AlertsButton />
          <AgentMenu t={t} />
        </header>
      }
    >
      {body}
    </Screen>
  );
}
