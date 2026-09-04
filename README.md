# Your Browser Agent

Let any AI agent — **Claude Code, Cursor, Codex, Hermes**, or any agent that
can make HTTP requests — drive your **real, logged-in Chrome browser**.

A tiny Chrome MV3 extension + a zero-dependency local Node relay. No accounts,
no cloud, no Python, no Playwright/Puppeteer, no other dependencies.
Everything stays on `127.0.0.1`, and because it drives *your* browser, sites
you are signed into are already authenticated for the agent.

```
┌──────────────┐   HTTP JSON    ┌──────────────┐   WebSocket    ┌──────────────────┐
│  AI agent    │ ─────────────> │   relay.js   │ ─────────────> │ Chrome extension │
│ (Claude, ...)│  POST /cmd     │ (node, 0-dep)│  127.0.0.1     │ (your browser)   │
└──────────────┘               └──────────────┘  ws://…:7799/ext└──────────────────┘
```

## What an agent can do with it

Open tabs and navigate · click (real, trusted input) · type into forms ·
checkboxes/radios · `<select>` dropdowns (by label or value) · hover menus ·
keyboard shortcuts (Ctrl+A/C/V…) · read & run JS on the page · scroll ·
**upload files** · answer `alert()`/`confirm()`/`prompt()` dialogs · take
screenshots · save pages as PDF · go back/forward/reload · wait for elements
and text · drive **same-origin iframes** end-to-end · click into
**cross-origin frames** (captcha checkboxes) by coordinates — all through your
own logged-in sessions.

## Requirements

- **Google Chrome** (or Chromium / Edge / Brave — any Chromium browser)
- **Node.js ≥ 16** — only for the relay; the extension itself needs nothing

## Install (2 minutes)

### 1. Load the extension

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select the **`extension/`** folder from your
   copy of this repository (or unzip
   `your-browser-agent-extension-v1.0.0.zip` and select that folder)
4. Pin the **Your Browser Agent** icon to the toolbar

> No Chrome Web Store account needed. You will see a permission warning for the
> `debugger` API — that is what powers trusted clicks/typing; review
> [Security notes](#security-notes).

### 2. Start the relay

```sh
node relay.js          # from the relay/ folder — port 7799 by default
# or:  node relay.js 8123          custom port
# or:  YBA_PORT=8123 node relay.js
```

You should see:

```
[yba] relay listening on http://127.0.0.1:7799
[yba] extension connects to ws://127.0.0.1:7799/ext
```

**Windows users:** double-click `relay/start-hidden.vbs` to run it with no
console window, or drop a shortcut to it in the Startup folder
(`Win+R` → `shell:startup`) to auto-start at login. **macOS/Linux users:** add
`node /path/to/relay/relay.js` to your login items / `cron`, or use your
process manager (`pm2`, `launchd`, `systemd`).

### 3. Connect

Click the **Your Browser Agent** icon → press **Connect**. The dot turns green
(opening the popup also connects automatically). Verify from any terminal:

```sh
curl http://127.0.0.1:7799/status
# {"name":"your-browser-agent","version":"1.0.0","extension":true,"port":7799}
```

`"extension": true` means your agent can drive the browser. If you use a
different port, set the **Relay address** in the popup to
`ws://127.0.0.1:8123/ext` and press Connect (any local port works).

### 4. Tell your agent

Paste the contents of **`AGENT-INSTRUCTIONS.md`** into your agent (Claude Code,
Codex, Hermes, Cursor, …) or point it at the file. Then just ask: *"open gmail
and tell me the last email"*, *"post this job on my site"*, *"check my
account balance"*, etc.

## Try it

```sh
curl -X POST http://127.0.0.1:7799/cmd \
  -H "Content-Type: application/json" \
  -d '{"cmd":"newTab","params":{"url":"https://example.com"}}'

curl -X POST http://127.0.0.1:7799/cmd \
  -H "Content-Type: application/json" \
  -d '{"cmd":"snapshot","params":{}}'
```

Full command reference and agent playbook:
[`AGENT-INSTRUCTIONS.md`](AGENT-INSTRUCTIONS.md).

## Optional: Python client

`yba.py` is a tiny convenience client if your agent runs Python:

```sh
python3 yba.py status                      # GET /status
python3 yba.py '{"cmd":"tabs"}'
python3 yba.py cmd newTab '{"url":"https://x.com"}'
python3 yba.py eval <tabId> 'document.title'
```

## Optional: automated end-to-end test

`scripts/e2e.mjs` launches a throwaway Chromium profile with the extension,
connects a test relay, and exercises ~50 checks (trusted clicks, forms,
dialogs, uploads, iframes, cross-origin coordinate clicks, …). Requires a
Chromium browser that permits `--load-extension` (Edge works; official Google
Chrome blocks that flag — load the extension manually there):

```sh
node scripts/e2e.mjs                        # auto-detects Chrome/Edge
CHROME="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" node scripts/e2e.mjs
```

## Project layout

```
extension/              Chrome MV3 extension — load this folder unpacked
  manifest.json         permissions: tabs, storage, alarms, debugger + localhost
  background.js         service worker: relay link + CDP command engine (v3)
  popup.html / popup.js Connect button, live status, relay address, test ping
  icons/                16/48/128 px
relay/
  relay.js              zero-dependency Node relay (RFC 6455 hand-rolled)
  start-hidden.vbs      optional Windows hidden auto-start launcher
  package.json          metadata (npm start convenience)
AGENT-INSTRUCTIONS.md   paste this into your AI agent (the full playbook)
yba.py                  optional tiny Python client
scripts/e2e.mjs         automated end-to-end test
LICENSE                 MIT
```

## Security notes

- The relay listens on **127.0.0.1 only** — nothing leaves your machine.
- The extension asks for **no website permissions**. Driving pages works
  through the Chrome debugger protocol, which shows a brief *"started
  debugging this browser"* bar on the driven tab — that is expected and powers
  the trusted input. It auto-detaches after ~2 minutes idle.
- **Any local process that can reach the port can control your browser while
  the extension is connected.** Only run the relay while you are using it, and
  disconnect the extension when done.
- Don't paste the agent instructions into untrusted prompts: an agent with
  this access can read anything your logged-in sessions can see, send email as
  you, etc. Grant it only to agents you trust, and watch what you ask them to do.
- Known limitation: Chrome's extension debugger API cannot *read or script*
  cross-origin iframes (most third-party embeds/captchas). They are listed by
  the `frames` command and remain clickable by coordinates — see
  [AGENT-INSTRUCTIONS.md](AGENT-INSTRUCTIONS.md#frames--iframes-important) for
  the exact behaviour and workarounds.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `/status` shows `"extension": false` | Click the extension icon → **Connect** (opening the popup also reconnects) |
| Connection drops after idle | Normal — Chrome suspends idle extension workers (MV3). It reconnects automatically within ~30 s; you can also open the popup to force it |
| `/cmd` returns "no extension connected" | Same as above — reconnect, then retry |
| `curl`/`fetch` can't reach the port | Confirm `node relay.js` is still running; check the port in the popup matches |
| Changed port doesn't work | Popup → set Relay address to `ws://127.0.0.1:<port>/ext` → Connect (any localhost port is allowed) |
| A selector matches nothing | Snapshot again — refs (`e1`, …) die on navigation/DOM changes |
| Can't read a captcha / third-party iframe | Cross-origin frames can't be scripted by this API — click by coordinates (`frames` + `point`), and screenshot to aim |
| "started debugging this browser" bar | Expected while a tab is driven; disappears ~2 min after the last command |

## License

MIT — see [LICENSE](LICENSE).
