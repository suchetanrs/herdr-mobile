import { test as base, expect, type Page } from '@playwright/test';

/** Every page fails its test on an uncaught error or a Content-Security-Policy violation. */
export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    const problems: string[] = [];
    page.on('pageerror', (e) => {
      // WebKit reports this benign notice (the observer's next callback just comes a frame later) as an error.
      if (/^ResizeObserver loop completed with undelivered notifications/.test(e.message)) return;
      problems.push(`pageerror: ${e.message}`);
    });
    page.on('console', (m) => {
      const text = m.text();
      if (/content security policy|refused to (load|execute|connect|apply)/i.test(text)) problems.push(`csp: ${text}`);
    });
    await use(page);
    expect(problems, problems.join('\n')).toEqual([]);
  },
});
export { expect };

/**
 * Space names as the app lists them (the phone's inbox: a card per space that needs something, a compact line
 * per idle one; the desktop's main page shows the same inbox).
 */
export async function listedSpaces(page: Page): Promise<string[]> {
  const names = page.locator('.space-row-name, .space-line-name');
  await names.first().waitFor();
  return (await names.allTextContents()).map((s) => s.trim());
}

/** Waits for the connection dot to say live (WebSocket open and herdr-core connected). */
export async function live(page: Page): Promise<void> {
  await expect(page.locator('.conn.conn-ok').first()).toBeAttached({ timeout: 15_000 });
}
