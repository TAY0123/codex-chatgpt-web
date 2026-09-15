import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../scripts/export-storage-state.ts", import.meta.url), "utf8");

test("session export uses one visible login window then headless sandboxed verification", () => {
  expect(source).toContain("headless: true");
  expect(source).toContain("chromiumSandbox: true");
  expect(source).toContain('"--restore-last-session"');
  expect(source).toContain('"--no-sandbox"');
  expect(source).not.toContain("loginToChatGpt");
});
