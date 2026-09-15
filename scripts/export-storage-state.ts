#!/usr/bin/env bun
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import {
  loginVerificationMarkerPath,
  sanitizeBrowserLoginStorageState,
} from "../src/browser-login";
import {
  assertAuthenticatedChatGptPage,
  assertTemporaryChatPage,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_TEMPORARY_CHAT_URL,
  detectChatGptAccountCapabilities,
} from "../src/chatgpt-session";
import {
  atomicWriteFile,
  defaultChromeExecutable,
  defaultConfig,
  expandUserPath,
} from "../src/config";
import { VERSION } from "../src/version";

const DEVTOOLS_READY_TIMEOUT_MS = 30_000;
const LOGIN_READY_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 100;

const HELP = `codex-chatgpt-web session export ${VERSION}

Create a Playwright storage-state file for the headless server on a machine with a desktop browser.

Usage:
  bun run session:export -- [options]

Options:
  --output PATH    Storage-state output path (default: ~/.codex-chatgpt-web/browser/storage-state.json)
  --chrome PATH    Google Chrome/Chromium executable (default: platform Chrome path)
  -h, --help

One normal Chrome window will open. Sign in to ChatGPT and leave that window open.
The exporter detects the authenticated composer, captures the session from that same Chrome
instance over a loopback DevTools connection, then closes the dedicated window automatically.
`;

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

function chromeExited(browser: ChildProcess): boolean {
  return browser.exitCode !== null || browser.signalCode !== null;
}

async function waitForDevToolsEndpoint(
  loginBrowser: ChildProcess,
  profileDir: string,
  timeoutMs = DEVTOOLS_READY_TIMEOUT_MS,
): Promise<string> {
  const activePortPath = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (chromeExited(loginBrowser)) {
      throw new Error("Dedicated Chrome exited before its local DevTools endpoint became ready");
    }
    if (existsSync(activePortPath)) {
      try {
        const [portRaw] = readFileSync(activePortPath, "utf8").trim().split(/\r?\n/);
        const port = Number(portRaw);
        if (Number.isInteger(port) && port > 0 && port <= 65_535) {
          return `http://127.0.0.1:${port}`;
        }
      } catch {
        // Chrome may still be replacing the file. Poll until the bounded deadline.
      }
    }
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out waiting ${timeoutMs}ms for Chrome's local DevTools endpoint`);
}

async function waitForAuthenticatedChatGptPage(
  context: BrowserContext,
  loginBrowser: ChildProcess,
  timeoutMs = LOGIN_READY_TIMEOUT_MS,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (chromeExited(loginBrowser)) {
      throw new Error("Dedicated Chrome was closed before the authenticated ChatGPT composer was captured");
    }
    for (const page of context.pages()) {
      const visibleComposer = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).first();
      if (await visibleComposer.isVisible().catch(() => false)) return page;
    }
    await sleep(250);
  }
  throw new Error(
    "Timed out waiting for the authenticated ChatGPT composer. Complete sign-in in the dedicated Chrome window and keep it open.",
  );
}

async function captureFromLiveChrome(
  chromeExecutablePath: string,
  profileDir: string,
): Promise<{
  storageState: ReturnType<typeof sanitizeBrowserLoginStorageState>;
  solAvailable: boolean;
  proAvailable: boolean;
}> {
  process.stdout.write(
    "A normal Chrome window is open. Sign in to ChatGPT and leave this dedicated window open; the exporter will close it after capture.\n",
  );
  const loginBrowser = spawn(chromeExecutablePath, [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--new-window",
    "--disable-background-mode",
    "--no-first-run",
    "--no-default-browser-check",
    CHATGPT_TEMPORARY_CHAT_URL,
  ], { env: process.env, stdio: "ignore" });

  let browser: Browser | undefined;
  try {
    const endpoint = await waitForDevToolsEndpoint(loginBrowser, profileDir);
    browser = await chromium.connectOverCDP(endpoint, { timeout: DEVTOOLS_READY_TIMEOUT_MS });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chrome DevTools connection exposed no browser context");

    let page = await waitForAuthenticatedChatGptPage(context, loginBrowser);
    if (page.url() !== CHATGPT_TEMPORARY_CHAT_URL) {
      process.stdout.write("Authenticated composer detected. Preparing Temporary Chat for export...\n");
      await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).first().waitFor({
        state: "visible",
        timeout: 60_000,
      });
    }
    await assertAuthenticatedChatGptPage(page);
    await assertTemporaryChatPage(page);

    process.stdout.write("Authenticated ChatGPT session detected. Capturing session state...\n");
    const capabilities = await detectChatGptAccountCapabilities(page);
    const storageState = sanitizeBrowserLoginStorageState(await context.storageState());
    if (storageState.cookies.length === 0) {
      throw new Error("The authenticated Chrome session contains no ChatGPT/OpenAI cookies");
    }
    return { storageState, ...capabilities };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (!chromeExited(loginBrowser)) loginBrowser.kill();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (takeFlag(args, "--help") || takeFlag(args, "-h")) {
    process.stdout.write(HELP);
    return;
  }

  const outputRaw = takeOption(args, "--output");
  const chromeRaw = takeOption(args, "--chrome");
  if (args.length > 0) throw new Error(`Unknown arguments: ${args.join(" ")}`);

  const config = defaultConfig("browser-only");
  const storageStatePath = resolve(expandUserPath(outputRaw || config.storageStatePath));
  const chromeExecutablePath = resolve(expandUserPath(chromeRaw || defaultChromeExecutable()));

  if (!existsSync(chromeExecutablePath)) {
    throw new Error(
      `Chrome/Chromium does not exist: ${chromeExecutablePath}. Pass --chrome with its executable path.`,
    );
  }

  const profileParent = dirname(storageStatePath);
  mkdirSync(profileParent, { recursive: true, mode: 0o700 });
  try { chmodSync(profileParent, 0o700); } catch {}
  const profileDir = mkdtempSync(join(profileParent, "login-profile-"));
  try { chmodSync(profileDir, 0o700); } catch {}

  try {
    const result = await captureFromLiveChrome(chromeExecutablePath, profileDir);
    atomicWriteFile(storageStatePath, `${JSON.stringify(result.storageState)}\n`);
    atomicWriteFile(loginVerificationMarkerPath(storageStatePath), `${JSON.stringify({
      version: 1,
      authenticated: true,
      verifiedAt: new Date().toISOString(),
      solAvailable: result.solAvailable,
      proAvailable: result.proAvailable,
    })}\n`);
    try { chmodSync(storageStatePath, 0o600); } catch {}
    process.stdout.write(`\nSession export complete: ${storageStatePath}\n`);
    process.stdout.write("Treat this file as a credential. Copy it to the headless server with scp or another secure transport.\n");
  } finally {
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      process.stderr.write(
        `Warning: could not remove temporary Chrome profile ${profileDir}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
