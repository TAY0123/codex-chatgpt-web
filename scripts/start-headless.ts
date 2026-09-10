#!/usr/bin/env bun
import { chmodSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { closeChatGptBrowserWorkers } from "../src/adapters/chatgpt-web/browser-worker";
import { atomicWriteFile, defaultChromeExecutable, defaultConfig, expandUserPath } from "../src/config";
import { loginVerificationMarkerPath } from "../src/browser-login";
import {
  assertAuthenticatedChatGptPage,
  assertTemporaryChatPage,
  CHATGPT_TEMPORARY_CHAT_URL,
  detectChatGptAccountCapabilities,
} from "../src/chatgpt-session";
import { startServer } from "../src/server";
import { VERSION } from "../src/version";

const HELP = `codex-chatgpt-web headless ${VERSION}

Run the browser-only Responses bridge on a server with no desktop session.

Usage:
  bun run headless -- [options]

Options:
  --storage-state PATH   Authenticated ChatGPT storage state
                         (default: ~/.codex-chatgpt-web/browser/storage-state.json)
  --chrome PATH          Chrome/Chromium executable (default: platform Chrome path)
  --port NUMBER          Loopback Responses port (default: 17841)
  -h, --help

If storage state is missing, create it on a desktop machine with:
  bun run session:export

The listener intentionally binds to 127.0.0.1. Use SSH port forwarding for remote access.
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

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 17_841;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  return port;
}

async function verifyStorageState(
  chromeExecutablePath: string,
  storageStatePath: string,
): Promise<{ solAvailable: boolean; proAvailable: boolean }> {
  const browser = await chromium.launch({
    executablePath: chromeExecutablePath,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const context = await browser.newContext({ storageState: storageStatePath });
    try {
      const page = await context.newPage();
      await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      const composer = page.getByRole("textbox", { name: "Chat with ChatGPT" }).or(
        page.locator('[data-testid="prompt-textarea"], [contenteditable="true"][data-lexical-editor="true"]'),
      ).first();
      await composer.waitFor({ state: "visible", timeout: 60_000 });
      await assertAuthenticatedChatGptPage(page);
      await assertTemporaryChatPage(page);
      return await detectChatGptAccountCapabilities(page);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (takeFlag(args, "--help") || takeFlag(args, "-h")) {
    process.stdout.write(HELP);
    return;
  }

  const storageStateRaw = takeOption(args, "--storage-state");
  const chromeRaw = takeOption(args, "--chrome");
  const port = parsePort(takeOption(args, "--port"));
  if (args.length > 0) throw new Error(`Unknown arguments: ${args.join(" ")}`);

  const config = defaultConfig("browser-only");
  const storageStatePath = resolve(expandUserPath(storageStateRaw || config.storageStatePath));
  const chromeExecutablePath = resolve(expandUserPath(chromeRaw || defaultChromeExecutable()));
  if (!existsSync(storageStatePath)) {
    throw new Error(
      `Storage state does not exist: ${storageStatePath}\n`
      + "Create it on a machine with a desktop browser using `bun run session:export`, then copy "
      + "storage-state.json to this server with scp or another secure transport.",
    );
  }
  if (!existsSync(chromeExecutablePath)) {
    throw new Error(`Chrome/Chromium does not exist: ${chromeExecutablePath}. Pass --chrome with its executable path.`);
  }
  try { chmodSync(storageStatePath, 0o600); } catch {}

  process.stdout.write("Verifying the copied ChatGPT session in headless Chromium...\n");
  const capabilities = await verifyStorageState(chromeExecutablePath, storageStatePath);
  atomicWriteFile(loginVerificationMarkerPath(storageStatePath), `${JSON.stringify({
    version: 1,
    authenticated: true,
    verifiedAt: new Date().toISOString(),
    ...capabilities,
  })}\n`);

  config.host = "127.0.0.1";
  config.port = port;
  config.browserHost = "managed-chrome";
  config.browserInteractionMode = "automatic";
  config.chromeExecutablePath = chromeExecutablePath;
  config.storageStatePath = storageStatePath;
  config.headed = false;
  config.solAvailable = capabilities.solAvailable;
  config.proAvailable = capabilities.proAvailable;

  const server = startServer(config);
  process.stdout.write(
    `codex-chatgpt-web ${VERSION} headless server listening on http://127.0.0.1:${server.port}/v1 (browser-only)\n`,
  );
  process.stdout.write(
    `Remote access: ssh -N -L ${server.port}:127.0.0.1:${server.port} <user>@<server>\n`,
  );

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await server.stop(true);
      await closeChatGptBrowserWorkers();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  await new Promise<void>(() => {});
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
