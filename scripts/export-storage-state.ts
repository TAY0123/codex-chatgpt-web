#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
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

const HELP = `codex-chatgpt-web session export ${VERSION}

Create a Playwright storage-state file for the headless server on a machine with a desktop browser.

Usage:
  bun run session:export -- [options]

Options:
  --output PATH    Storage-state output path (default: ~/.codex-chatgpt-web/browser/storage-state.json)
  --chrome PATH    Google Chrome/Chromium executable (default: platform Chrome path)
  -h, --help

One normal Chrome window will open. Sign in to ChatGPT, confirm the composer is visible,
then quit that dedicated Chrome instance completely. Session capture and verification continue
headlessly; no second browser window should appear.
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

function removeTemporaryChromeTabSessions(profileDir: string): void {
  const defaultProfile = join(profileDir, "Default");
  rmSync(join(defaultProfile, "Sessions"), { recursive: true, force: true });
  for (const name of ["Current Session", "Current Tabs", "Last Session", "Last Tabs"]) {
    rmSync(join(defaultProfile, name), { force: true });
  }
}

async function waitForLoginChrome(
  chromeExecutablePath: string,
  profileDir: string,
): Promise<void> {
  process.stdout.write(
    "A normal Chrome window is open. Sign in to ChatGPT, confirm that the composer is visible, then quit this dedicated Chrome instance completely.\n",
  );
  const loginBrowser = spawn(chromeExecutablePath, [
    `--user-data-dir=${profileDir}`,
    "--new-window",
    "--disable-background-mode",
    "--no-first-run",
    "--no-default-browser-check",
    CHATGPT_TEMPORARY_CHAT_URL,
  ], { env: process.env, stdio: "ignore" });
  const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
    loginBrowser.once("error", rejectExit);
    loginBrowser.once("exit", (code, signal) => {
      if (signal) rejectExit(new Error(`Normal Chrome login window exited from signal ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
  if (exitCode !== 0) throw new Error(`Normal Chrome login window exited with status ${exitCode}`);
}

async function captureAndVerifyHeadlessly(
  chromeExecutablePath: string,
  profileDir: string,
): Promise<{
  storageState: ReturnType<typeof sanitizeBrowserLoginStorageState>;
  solAvailable: boolean;
  proAvailable: boolean;
}> {
  // Chrome normally discards session-only cookies on a plain restart. Restore session state so
  // those cookies are loaded, but remove tab-session files first so no authenticated/IdP tabs are
  // reopened during the automated capture.
  removeTemporaryChromeTabSessions(profileDir);
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromeExecutablePath,
    headless: true,
    chromiumSandbox: true,
    ignoreDefaultArgs: [
      "--no-sandbox",
      "--password-store=basic",
      "--use-mock-keychain",
    ],
    args: [
      "--disable-background-mode",
      "--no-first-run",
      "--no-default-browser-check",
      "--restore-last-session",
    ],
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).first().waitFor({
      state: "visible",
      timeout: 60_000,
    });
    await assertAuthenticatedChatGptPage(page);
    await assertTemporaryChatPage(page);
    const capabilities = await detectChatGptAccountCapabilities(page);
    const storageState = sanitizeBrowserLoginStorageState(await context.storageState());
    if (storageState.cookies.length === 0) {
      throw new Error("The authenticated Chrome profile contains no ChatGPT/OpenAI cookies");
    }
    return { storageState, ...capabilities };
  } finally {
    await context.close();
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

  let contextForCleanup: BrowserContext | undefined;
  try {
    await waitForLoginChrome(chromeExecutablePath, profileDir);
    process.stdout.write("Capturing and verifying the authenticated session headlessly...\n");
    const result = await captureAndVerifyHeadlessly(chromeExecutablePath, profileDir);
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
    if (contextForCleanup && !contextForCleanup.isClosed()) await contextForCleanup.close().catch(() => {});
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
