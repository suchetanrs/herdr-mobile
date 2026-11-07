import { type FormEvent, useState } from 'react';
import { HerdrMark } from '../components/Chrome';
import { Icon } from '../components/Icon';
import { useServices } from '../hooks/app';
import { useTapFocus } from '../hooks/gestures';
import { type SignInResult, signIn } from '../lib/auth';

const MESSAGES: Record<Exclude<SignInResult, 'ok'>, string> = {
  unauthorized: 'That token isn’t the bridge’s (it may have been replaced). Check it and try again.',
  blocked: 'Too many wrong tokens from this address. Wait a few minutes and try again.',
  unreachable: 'Can’t reach the bridge right now.',
};

let linkResult: Exclude<SignInResult, 'ok'> | null = null;
/** How signing in with the opened link went, when it didn't work (shown above the form). */
export function setLinkResult(r: SignInResult): void {
  linkResult = r === 'ok' ? null : r;
}

/** The token as typed or pasted: the token itself, or a sign-in link (`#token=`, or an old `?token=` one). */
export function tokenFromInput(text: string): string {
  const t = text.trim();
  const m = /[#?&]token=([^&#\s]*)/.exec(t);
  if (!m) return t;
  try {
    return decodeURIComponent(m[1] ?? '');
  } catch {
    return m[1] ?? '';
  }
}

/** Shown when this device isn't signed in: paste the token or the link once; the device then gets its own session. */
export function TokenScreen() {
  const { conn, store } = useServices();
  const [token, setToken] = useState('');
  const tapFocus = useTapFocus<HTMLInputElement>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => (linkResult ? MESSAGES[linkResult] : null));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const t = tokenFromInput(token);
    if (!t) return;
    setBusy(true);
    setError(null);
    const verdict = await signIn(t);
    setBusy(false);
    if (verdict === 'ok') {
      linkResult = null;
      setToken('');
      store.setConn({ status: 'connecting', attempt: 0 });
      conn.retryNow();
    } else setError(MESSAGES[verdict]);
  };

  return (
    <div className="token-screen">
      <form className="token-card" onSubmit={submit}>
        <HerdrMark size={40} />
        <h1>Connect to Herdr</h1>
        <p>
          Open the sign-in link, or paste it or the token here. The token is in <code>~/.config/herdr-mobile/token</code> on the computer
          running Herdr.
        </p>
        <label className="field">
          <Icon name="key" size={16} />
          <input
            ref={tapFocus}
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="Token or link"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            aria-label="Token"
          />
        </label>
        {error && <div className="token-error">{error}</div>}
        <button className="btn btn-primary" type="submit" disabled={busy || !token.trim()}>
          {busy ? <Icon name="spinner" size={14} spin /> : null}
          Connect
        </button>
        <p className="token-note">
          The token is used once to sign this device in; it isn’t kept here. Anyone with it can type into your agents: sign devices out in
          Settings.
        </p>
      </form>
    </div>
  );
}
