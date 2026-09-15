import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../scripts/export-storage-state.ts", import.meta.url), "utf8");

test("session export captures from the same visible Chrome instance over loopback CDP", () => {
  expect(source).toContain('"--remote-debugging-port=0"');
  expect(source).toContain('"--remote-debugging-address=127.0.0.1"');
  expect(source).toContain("DevToolsActivePort");
  expect(source).toContain("chromium.connectOverCDP");
  expect(source).toContain("Authenticated ChatGPT session detected. Capturing session state...");
  expect(source).not.toContain("launchPersistentContext");
  expect(source).not.toContain("headless: true");
  expect(source).not.toContain('"--no-sandbox"');
  expect(source).not.toContain("loginToChatGpt");
});
