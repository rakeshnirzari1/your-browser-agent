# Your Browser Agent

Connect AI apps to your browser to automate tasks and testing.

Your Browser Agent is an MCP server + Chrome extension that lets AI
applications like **Claude, Cursor, VS Code, and Windsurf** drive your real,
logged-in Chrome browser — automation happens locally on your machine, so
your browser activity stays private and you stay logged into everything.

## Why Your Browser Agent

- **Fast** — automation runs locally, no network hop to a remote browser.
- **Private** — nothing leaves `127.0.0.1`; no accounts, no cloud.
- **Logged in** — uses your existing Chrome profile and sessions.
- **Stealthy** — drives your real browser fingerprint, avoiding basic bot
  detection.

## How it works

```
┌──────────────┐      MCP       ┌────────────────┐   WebSocket    ┌──────────────────┐
│  AI app       │ ─────────────>│  MCP server     │ ─────────────> │ Chrome extension │
│ (Claude, ...) │  stdio        │ (spawned by     │  127.0.0.1     │ (your browser)   │
└──────────────┘                │  the AI app)    │  ws://…:7799/ext└──────────────────┘
                                 └────────────────┘
```

## Multiple agents, one browser

Each AI app spawns its own copy of the MCP server, but only one browser
connection can exist at a time. To make that transparent, the first instance
to start becomes the **hub** (it owns the real connection to the extension);
every later instance detects the hub and becomes a lightweight **follower**
that proxies its tool calls through it instead of fighting over the port.
Concurrently driving different tabs works too — the extension keeps a
separate debugger session per tab, so one agent's tab doesn't interrupt
another's. If the hub's AI app closes, the next follower automatically takes
over as the hub.

Each spawned server instance is also its own identified agent: the extension
remembers each agent's own last-used tab separately, so if one agent omits
`tabId` on a call, it still lands on *that agent's* tab — not whichever tab
another agent (or the browser's focus) most recently touched.

Commands are queued **per tab**, not globally — a slow or stuck command on
one tab (e.g. a heavy news site still loading) no longer blocks unrelated
commands on other tabs. Within a single tab, commands still run one at a time
for CDP safety.

## Get started

### 0. Requirements

- **Google Chrome** (or another Chromium browser: Edge, Brave, ...)
- **Node.js ≥ 18** installed and on your `PATH` — that's it. The MCP server
  is a single pre-built file with everything bundled in; there's no
  `npm install` step for end users.

### 1. Install the extension

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select the **`extension/`** folder from this
   repository
4. Pin the **Your Browser Agent** icon to the toolbar

> You'll see a permission warning for the `debugger` API — that's what powers
> trusted clicks/typing on your behalf. See [Security](#security).

### 2. Set up the MCP server

Add Your Browser Agent to your AI app's MCP configuration, pointing at the
pre-built server bundle: `extension/server/dist/mcp-server.mjs` (no install
step — it's a single self-contained file).

**Claude Desktop** — edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "your-browser-agent": {
      "command": "node",
      "args": ["/absolute/path/to/YourBrowserAgent/extension/server/dist/mcp-server.mjs"]
    }
  }
}
```

**Cursor / Windsurf** — same `mcpServers` block in their MCP settings.

**VS Code** — add to `.vscode/mcp.json` (workspace) or User Settings → MCP:

```json
{
  "servers": {
    "your-browser-agent": {
      "command": "node",
      "args": ["/absolute/path/to/YourBrowserAgent/extension/server/dist/mcp-server.mjs"]
    }
  }
}
```

Restart/reload the app so it picks up the new server.

### 3. Connect the extension

Click the **Your Browser Agent** icon → press **Connect**. The dot turns
green once your AI app has started the MCP server and the extension can
reach it. Press **Disconnect** any time to stop the browser from being
controllable — it stays disconnected until you press Connect again.

### 4. Start automating

Ask your AI app to use the browser — e.g. *"open gmail and tell me the last
email"*, *"fill out this form and submit it"*, *"take a screenshot of this
page"*. It calls the tools below directly; no extra prompting needed.

## Browser tools

**Tabs & navigation**

| Tool | What it does |
| --- | --- |
| `tabs` | List open tabs |
| `newTab` / `goto` | Open a URL in a fresh tab / navigate an existing one |
| `activate` / `closeTab` | Focus a tab / close a tab |
| `reload` / `back` / `forward` | Reload / history navigation |

**Reading the page**

| Tool | What it does |
| --- | --- |
| `snapshot` | Accessibility-style snapshot with stable refs (e1, e2, ...) for interactive elements. Pass `diff:true` to get only what changed since your last snapshot of that tab |
| `snapshotMany` | Snapshot several tabs in one call (default: all open tabs) — handy when running multiple tasks/agents at once |
| `readPage` | Cheap alternative to `snapshot`: title, url, plain text, and links — for when you just need to *read*, not interact |
| `frames` | List iframes (same-origin + cross-origin) |
| `screenshot` / `pdf` | Visual capture / print-to-PDF |
| `getConsoleLogs` | This tab's captured console output (log/warn/error/exceptions) |

**Acting on the page**

| Tool | What it does |
| --- | --- |
| `click` / `hover` | Trusted pointer input, including clicking into cross-origin frames by coordinate |
| `fill` (`type`) / `press` | Type into fields, checkboxes/selects, keyboard shortcuts |
| `selectOptions` | List a `<select>`'s options |
| `upload` | Attach real files to a file input |
| `scroll` | Scroll the page or bring an element into view |
| `evaluate` | Run JavaScript in the page |
| `waitFor` | Poll for text/selector/URL/expression/dialog-closed |
| `dialog` | Answer an open alert/confirm/prompt |

**Network, cookies & storage**

| Tool | What it does |
| --- | --- |
| `getRequests` | List captured network requests (url, method, status) for this tab |
| `waitForResponse` | Wait for a request matching a URL substring (+ optional status) to complete |
| `waitForDownload` | Wait for a browser-triggered file download to finish and report where it landed |
| `getCookies` / `setCookie` / `deleteCookies` | Read/write cookies |
| `getLocalStorage` / `setLocalStorage` / `clearLocalStorage` | Read/write `localStorage` |

**Record & replay**

| Tool | What it does |
| --- | --- |
| `recordStart` / `recordStop` | Record a sequence of actions on a tab, get the steps back as JSON |
| `replay` | Re-run a list of `{cmd, params}` steps against a tab — e.g. steps saved from `recordStop` |

Full parameter reference (selectors, frames/iframes, dialogs, captchas) is in
[`extension/server/mcp-server.mjs`](extension/server/mcp-server.mjs)'s tool
descriptions, visible to your AI app once connected.

## Try the new features

Ask your AI app things like:
- *"Record my next few actions on this tab, then show me the recorded steps."* → `recordStart` → do stuff → `recordStop`
- *"Replay those exact steps on a new tab."* → `newTab` then `replay` with the saved `steps`
- *"What network requests has this page made to api.example.com?"* → `getRequests` with `urlContains`
- *"Download this file and tell me where it saved."* → click the download link, then `waitForDownload`
- *"What's in this page's localStorage / cookies?"* → `getLocalStorage` / `getCookies`
- *"Show me only what changed on the page after I submitted the form."* → `snapshot` with `diff:true`
- *"Snapshot all my open tabs at once."* → `snapshotMany`
- *"Show me this page's console errors."* → `getConsoleLogs`

## Security

- The MCP server only listens on **127.0.0.1** — nothing leaves your machine.
- The extension requests **no website permissions**; it drives pages through
  Chrome's debugger protocol, which shows a brief *"started debugging this
  browser"* bar on the driven tab. It auto-detaches after ~2 minutes idle.
- Any local process that can reach the WebSocket port can control your
  browser while the extension is connected — disconnect it when you're done.
- Only add this MCP server to AI apps/configs you trust: it can read anything
  your logged-in sessions can see and act on your behalf.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Extension popup shows disconnected | Click the extension icon → **Connect**; confirm your AI app actually started the MCP server (check its MCP logs) |
| AI app shows the server as failed/crashed | Run `node extension/server/dist/mcp-server.mjs` manually in a terminal to see the error |
| `EADDRINUSE` on port 7799 | Normal and self-healing: if it's a leftover instance of this same server (e.g. orphaned by a crashed/force-quit AI app), the new instance detects and stops it automatically within a few seconds. If it persists, something else on your machine is using port 7799 — set `YBA_PORT` in both the server's env and the extension popup's address |
| Tool calls return "no extension connected" | Reconnect the extension popup, then retry |
| Popup shows Connected but tool calls still fail (esp. after closing/reopening Chrome, or after hours idle) | The extension self-detects this within ~40s and reconnects automatically (an app-level heartbeat catches a "zombie" connection whose peer process died without a clean close). If you don't want to wait, press Disconnect then Connect to force it immediately |
| A selector matches nothing | Re-run `snapshot` — refs die on navigation/DOM changes |
| `waitForDownload` times out | Chrome's download events differ slightly by version; make sure you trigger the download (click) immediately before calling `waitForDownload`, and pass an explicit `downloadPath` if the default download folder is restricted |

## License

MIT
