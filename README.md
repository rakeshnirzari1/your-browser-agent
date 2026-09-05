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

| Tool | What it does |
| --- | --- |
| `navigate` (`goto`) | Navigate to a URL |
| `back` / `forward` | Go back/forward in history |
| `waitFor` | Wait for an element, text, or URL condition |
| `press` | Press a key on the keyboard |
| `snapshot` | Capture an accessibility snapshot of the current page |
| `click` | Perform a trusted click on an element |
| `upload` | Drag & drop / attach files to an element |
| `hover` | Hover over an element |
| `fill` (`type`) | Type text into an editable element |
| `evaluate` | Get the console logs / run JS in the page |
| `screenshot` | Take a screenshot of the current page |

Full command reference (selectors, frames/iframes, dialogs, captchas) is in
[`extension/server/mcp-server.mjs`](extension/server/mcp-server.mjs)'s tool
descriptions, visible to your AI app once connected.

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
| A selector matches nothing | Re-run `snapshot` — refs die on navigation/DOM changes |

## License

MIT
