import { expect, test } from "bun:test";
import { CHATGPT_COMPOSER_SELECTOR } from "../src/chatgpt-session";

test("composer selector accepts current ProseMirror and accessible textbox variants", () => {
  expect(CHATGPT_COMPOSER_SELECTOR).toContain('div.ProseMirror[contenteditable="true"]');
  expect(CHATGPT_COMPOSER_SELECTOR).toContain(
    'div[role="textbox"][aria-label="Chat with ChatGPT"][contenteditable="true"]',
  );
  expect(CHATGPT_COMPOSER_SELECTOR).toContain("#prompt-textarea");
});
