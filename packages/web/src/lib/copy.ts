/**
 * Copies text. `navigator.clipboard` needs a secure context, which a phone on plain HTTP over Tailscale isn't, so
 * there the copy is a hidden textarea and execCommand('copy'), done synchronously: it only works inside the tap
 * (iOS Safari and Android Chrome alike). Call copyText from the tap handler itself, before any await.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!(window.isSecureContext && navigator.clipboard?.writeText)) return copyByCommand(text);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyByCommand(text);
  }
}

export function copyByCommand(text: string): boolean {
  const before = document.activeElement as HTMLElement | null;
  const ta = document.createElement('textarea');
  ta.value = text;
  // readonly: no keyboard; 12pt: iOS doesn't zoom; on screen (but invisible) at the current scroll: iOS selects it.
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  Object.assign(ta.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '1px',
    height: '1px',
    padding: '0',
    border: '0',
    opacity: '0',
    fontSize: '12pt',
  });
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  window.getSelection()?.removeAllRanges();
  before?.focus?.({ preventScroll: true });
  return ok;
}
