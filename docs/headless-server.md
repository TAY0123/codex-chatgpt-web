# Headless server deployment

The normal terminal setup path is intentionally desktop-oriented and the managed background service is currently macOS-only. For a Linux server with no graphical session, use the standalone headless entrypoint instead.

## What this mode does

- Runs Chromium with `headless: true`.
- Runs the browser-only Responses bridge in the foreground.
- Binds only to `127.0.0.1`.
- Verifies a copied ChatGPT Playwright storage state before accepting requests.
- Detects the account's currently available Web model capabilities during startup.

This mode does not install launchd/systemd services, does not create the full MCP tunnel configuration, and does not expose the Responses API directly to the network.

## 1. Install Bun and Chrome/Chromium on the server

Use Bun 1.4.0, matching `package.json`, then install Google Chrome or a compatible Chromium build.

Typical executable paths are:

```text
/usr/bin/google-chrome
/usr/bin/chromium
/usr/bin/chromium-browser
```

## 2. Copy an authenticated storage state to the server

On a machine where `codex-chatgpt-web` has already completed ChatGPT login, copy the Playwright storage state file:

```text
~/.codex-chatgpt-web/browser/storage-state.json
```

Copy only the JSON file. The headless entrypoint performs a fresh verification and writes a new local verification marker beside it.

Treat this file like a credential: it contains authenticated browser session material. Keep it outside the repository, set restrictive permissions, and never commit it.

Example:

```bash
mkdir -p ~/.codex-chatgpt-web/browser
chmod 700 ~/.codex-chatgpt-web/browser
scp storage-state.json server:~/.codex-chatgpt-web/browser/storage-state.json
chmod 600 ~/.codex-chatgpt-web/browser/storage-state.json
```

If ChatGPT later requires interactive sign-in again, refresh the storage state on a machine with a browser UI and copy the new file to the server.

## 3. Start the headless server

From the repository checkout on the server:

```bash
bun install --frozen-lockfile
bun run headless -- \
  --storage-state "$HOME/.codex-chatgpt-web/browser/storage-state.json" \
  --chrome /usr/bin/google-chrome
```

Use another Chromium path if needed:

```bash
bun run headless -- \
  --storage-state "$HOME/.codex-chatgpt-web/browser/storage-state.json" \
  --chrome /usr/bin/chromium \
  --port 17841
```

Startup fails if the copied session cannot open authenticated ChatGPT Temporary Chat in headless Chromium.

## 4. Reach it from another machine with SSH forwarding

The `/v1` Responses surface is not designed to be exposed directly to an untrusted network. The headless entrypoint therefore stays on loopback.

From the client machine:

```bash
ssh -N -L 17841:127.0.0.1:17841 user@server
```

Then use:

```text
http://127.0.0.1:17841/v1
```

from the client as though the bridge were local.

## Running it as a service

Use the server's normal process supervisor rather than the project's macOS launchd installer. For example, a systemd unit can run the same `bun run headless -- ...` command under a dedicated unprivileged user.

Do not put the ChatGPT storage state in the unit file or environment. Pass only its filesystem path and keep the file readable only by that service account.
