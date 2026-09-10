#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loginToChatGpt } from "../src/browser-login";
import { defaultChromeExecutable, defaultConfig, expandUserPath } from "../src/config";
import { VERSION } from "../src/version";

const HELP = `codex-chatgpt-web session export ${VERSION}

Create a Playwright storage-state file for the headless server on a machine with a desktop browser.

Usage:
  bun run session:export -- [options]

Options:
  --output PATH    Storage-state output path (default: ~/.codex-chatgpt-web/browser/storage-state.json)
  --chrome PATH    Google Chrome/Chromium executable (default: platform Chrome path)
  -h, --help

A dedicated Chrome window will open. Sign in to ChatGPT, confirm the composer is visible,
then quit that dedicated Chrome instance completely. The resulting storage-state JSON can then
be copied to the headless server.
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
  config.browserHost = "managed-chrome";
  config.browserInteractionMode = "automatic";
  config.headed = true;
  config.storageStatePath = resolve(expandUserPath(outputRaw || config.storageStatePath));
  config.chromeExecutablePath = resolve(expandUserPath(chromeRaw || defaultChromeExecutable()));

  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(
      `Chrome/Chromium does not exist: ${config.chromeExecutablePath}. Pass --chrome with its executable path.`,
    );
  }

  const result = await loginToChatGpt(config);
  process.stdout.write(`\nSession export complete: ${result.storageStatePath}\n`);
  process.stdout.write("Treat this file as a credential. Copy it to the headless server with scp or another secure transport.\n");
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
