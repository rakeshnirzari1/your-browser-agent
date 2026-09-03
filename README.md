# Your Browser Agent

Let any AI agent — Claude Code, Codex, Cursor, Hermes, or any agent that can
make HTTP requests — drive your **real, logged-in Chrome browser**.

A tiny Chrome MV3 extension + a zero-dependency local Node relay. No accounts,
no cloud, no Python, no Playwright/Puppeteer, no other dependencies. Everything
stays on `127.0.0.1`, and because it drives *your* browser, sites you're signed
into are already authenticated for the agent.

```
┌──────────────┐   HTTP JSON    ┌──────────────┐   WebSocket    ┌──────────────────┐
│  AI agent    │ ─────────────> │   relay.js   │ ─────────────> │ Chrome extension │
│ (Hermes, ...)│  POST /cmd     │  (node, 0-dep)│  127.0.0.1     │ (your browser)   │
└──────────────┘               └──────────────┘  ws://…:7799/ext└──────────────────┘
```

## Features

- **Real trusted input** — clicks, typing and key presses are dispatched over
  the Chrome DevTools Protocol, so they pass `isTrusted` checks: form
  validation, autocomplete, dropdowns and payment flows behave as if a human
  did them.
- **CSP-proof evaluation** — `evaluate` runs in the page's main world and can
  see the page's own JavaScript variables (works on Gmail, Google, etc.).
- **Fast** — optional `waitUntil: "none"`, text-free snapshots, small
  `maxNodes`: nothing unnecessary happens between you and the result.
- **Zero dependencies** — the relay hand-rolls its RFC 6455 WebSocket server;
  no `npm install` needed.
- **Local only** — the relay binds `127.0.0.1`. Nothing leaves your machine.
- **Works with any agent** that can speak HTTP/JSON (see `AGENT-INSTRUCTIONS.md`).

## Requirements

- **Google Chrome** (recent version; Chromium/Edge work too)
- **Node.js ≥ 16** — only for the relay; the extension itself needs nothing

## Install

### 1. Load the extension

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension/` folder from your clone
   of this repository
4. Pin the **Your Browser Agent** icon to the toolbar

### 2. Start the relay

```sh
node relay.js          # from the relay/ folder — port 7799 by default
# or:  node relay.js 8123     custom port
```

You should see:

```
[yba] relay listening on http://127.0.0.1:7799
[yba] extension connects to ws://127.0.0.1:7799/ext
```

### 3. Connect

Click the **Your Browser Agent** icon → press **Connect**. The dot turns green.
Verify from any terminal:

```sh
curl http://127.0.0.1:7799/status
# {"name":"your-browser-agent","version":"0.2.0","engine":"cdp-v2","extension":true,"port":7799}
```

`"extension": true` means your agent can drive the browser.

### 4. Tell your agent

Paste the contents of **`AGENT-INSTRUCTIONS.md`** into your agent (Claude Code,
Codex, Hermes, …) or point it at the file. Then just ask: *"open gmail and tell
me the last email"*, *"find the cashback rate for Agoda on ShopBack"*, *"post
this job on my site"*, etc.

## Usage example

```sh
curl -X POST http://127.0.0.1:7799/cmd \
  -H "Content-Type: application/json" \
  -d '{"cmd":"newTab","params":{"url":"https://example.com"}}'

curl -X POST http://127.0.0.1:7799/cmd \
  -H "Content-Type: application/json" \
  -d '{"cmd":"snapshot","params":{}}'
```

Full command reference (commands, params, selector syntax): see
[`AGENT-INSTRUCTIONS.md`](AGENT-INSTRUCTIONS.md).

## Optional: Python client

`yba.py` is a tiny convenience client if your agent runs Python:

```sh
python3 yba.py status                 # GET /status
python3 yba.py cmd '{"cmd":"tabs"}'
python3 yba.py eval <tabId> 'document.title'
```

## Changing the port

- Start the relay on another port (`node relay.js 8123`), then
- click the extension icon, update the **Relay address** to
  `ws://127.0.0.1:8123/ext` and press **Connect**.

## Optional: auto-start the relay (Windows)

The repo ships `relay/start-hidden.vbs` — a hidden, no-console launcher. Copy a
shortcut to it into the Startup folder
(`Win+R` → `shell:startup`) to have the relay start at login. It runs from its
own folder, so your clone can live anywhere. (Requires Node on your `PATH`.)

## Security notes

- The relay listens on **127.0.0.1 only** — no external access.
- Any local process that can reach the port can control your browser while the
  extension is connected. Only run the relay while you are using it, and
  disconnect the extension when done.
- The extension asks for **no site permissions** (`tabs`, `storage`, `alarms`,
  `debugger`, plus the local relay host only). Driving pages works through the
  Chrome debugger protocol, which shows a brief *"started debugging this
  browser"* bar on the active tab — that's expected and powers the trusted
  input. It auto-detaches after ~2 minutes idle.
- Don't paste your agent instructions into untrusted prompts: the agent can
  read anything your logged-in sessions can see.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `/status` shows `"extension": false` | Click the extension icon → **Connect** |
| Connection drops after idle | Normal — Chrome suspends idle extension workers. Reconnect via the icon, or it reconnects automatically within ~30s (heartbeat alarm) |
| `/cmd` returns "no extension connected" | Same as above — press Connect and retry |
| `curl`/`fetch` can't reach the port | Confirm `node relay.js` is still running |
| A selector matches nothing | Snapshot again — refs (`e1`, …) are invalidated by navigation |
| Elements inside an iframe don't respond | Top-level actions target the main document for now — use `evaluate` to reach into `iframe.contentDocument` |

## Project layout

```
extension/              Chrome MV3 extension (load this folder unpacked)
  manifest.json         permissions: tabs, storage, alarms, debugger
  background.js         service worker: relay link + command execution (CDP v2 engine)
  popup.html / popup.js Connect button, status dot, relay address
  icons/                16/48/128 px icons
relay/
  relay.js              zero-dependency Node relay (RFC 6455 hand-rolled)
  start-hidden.vbs      optional Windows hidden auto-start launcher
  package.json          minimal metadata (npm start convenience)
AGENT-INSTRUCTIONS.md   paste this into your AI agent
yba.py                  optional tiny Python client
LICENSE                 MIT
```

## License

MIT — see [LICENSE](LICENSE).
