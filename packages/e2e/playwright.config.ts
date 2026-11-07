import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { REPO } from './lib/env.js';

/**
 * iPhone runs on real WebKit when it can start here. This host lacks libavif16 (installing it needs sudo), so
 * `npm run webkit-libs -w @herdr-mobile/e2e` unpacks it into .test-tmp and it is preloaded into WebKit only.
 * Without either, iPhone falls back to Chromium with iPhone emulation (E2E_IPHONE_ENGINE=chromium forces it).
 */
function iphoneEngine(): { browserName: 'webkit' | 'chromium'; env?: Record<string, string> } {
  if (process.env.E2E_IPHONE_ENGINE === 'chromium') return { browserName: 'chromium' };
  let system = false;
  try {
    system = execFileSync('ldconfig', ['-p'], { encoding: 'utf8' }).includes('libavif.so.16 ');
  } catch {}
  if (system) return { browserName: 'webkit' };
  const lib = path.join(REPO, '.test-tmp/webkit-libs/root/usr/lib/x86_64-linux-gnu');
  const libs = ['libyuv.so.0', 'libgav1.so.1', 'libavif.so.16'].map((f) => path.join(lib, f));
  if (libs.every((f) => fs.existsSync(f))) {
    process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';
    return { browserName: 'webkit', env: { ...(process.env as Record<string, string>), LD_PRELOAD: libs.join(':') } };
  }
  console.warn('[e2e] WebKit cannot start here (no libavif16): iPhone runs on Chromium with iPhone emulation');
  return { browserName: 'chromium' };
}

const iphone = iphoneEngine();
const chromiumArgs = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const { defaultBrowserType: _iphoneDefault, ...iphoneDevice } = devices['iPhone 15'];

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  // One worker: the projects share the throwaway terminals and the e2e instance (the restart test stops it).
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: path.join(REPO, '.test-tmp/e2e/results'),
  use: { colorScheme: 'dark', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    {
      name: 'iphone',
      use: {
        ...iphoneDevice,
        browserName: iphone.browserName,
        ...(iphone.browserName === 'chromium' ? { launchOptions: { args: chromiumArgs } } : {}),
        ...(iphone.env ? { launchOptions: { env: iphone.env } } : {}),
      },
    },
    { name: 'android', use: { ...devices['Pixel 7'], launchOptions: { args: chromiumArgs } } },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, launchOptions: { args: chromiumArgs } },
    },
  ],
});
