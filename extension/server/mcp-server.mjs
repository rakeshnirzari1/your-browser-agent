#!/usr/bin/env node
/**
 * Your Browser Agent — MCP server (stdio) + WebSocket bridge to the Chrome
 * extension. No manual "start the relay" step: your MCP client (Claude
 * Desktop, VS Code, Cursor, ...) launches this process for you and talks to
 * it over stdio using the Model Context Protocol. This process still opens a
 * tiny local WebSocket listener on 127.0.0.1 so the already-installed Chrome
 * extension can connect to it exactly as before.
 *
 * Add to your MCP client config, e.g.:
 *   { "mcpServers": { "your-browser-agent":
 *       { "command": "node", "args": ["<absolute path>/relay/mcp-server.mjs"] } } }
 *
 * Env:
 *   YBA_PORT   WebSocket port the extension connects to (default 7799)
 */

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PORT = Number(process.env.YBA_PORT) || Number(process.argv[2]) || 7799;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const HEARTBEAT_MS = 15000;
const LOCK_FILE = path.join(os.tmpdir(), "your-browser-agent-mcp-" + PORT + ".lock");
// Identifies this process (= one agent) to the extension, so it can remember
// each agent's own last-used tab instead of one shared "last tab" that any
// agent's activity can silently steal from another.
const SESSION_ID = crypto.randomUUID();

let extension = null; // connected extension socket wrapper
let nextCmdId = 0;
const pending = new Map(); // id -> {resolve, reject, timer}

// "hub" owns the real extension connection; "follower" proxies tool calls to
// whichever sibling instance is currently the hub (see the takeover section below).
let mode = "hub";
let agentSocket = null; // follower's outbound connection to the hub's /agents endpoint
let followerNextId = 0;
const followerPending = new Map(); // id -> {resolve, reject, timer}

/* ------------------------------ WebSocket conn ------------------------------ */

function makeConn(socket) {
  return {
    socket,
    alive: true,
    buffer: Buffer.alloc(0),
    send(obj) { sendText(this.socket, JSON.stringify(obj)); },
    close() {
      try { sendFrame(this.socket, 0x8, Buffer.alloc(0)); } catch (_) { }
      try { this.socket.destroy(); } catch (_) { }
    },
  };
}

function sendText(socket, text) { sendFrame(socket, 0x1, Buffer.from(text, "utf8")); }
function sendPing(socket) { sendFrame(socket, 0x9, Buffer.from("hb", "utf8")); }
function sendPong(socket, payload) { sendFrame(socket, 0xA, payload); }

function sendFrame(socket, opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    header.writeUInt32BE(len % 0x100000000, 6);
  }
  socket.write(Buffer.concat([header, payload]));
}

// RFC 6455: frames sent FROM a client (our follower role, dialing out to the
// hub's /agents endpoint) MUST be masked. Frames from a server (our normal
// hub role) must NOT be masked — that's what sendFrame above does.
function sendTextMasked(socket, text) { sendFrameMasked(socket, 0x1, Buffer.from(text, "utf8")); }
function sendFrameMasked(socket, opcode, payload) {
  const maskKey = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= maskKey[i & 3];
  const len = masked.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    header.writeUInt32BE(len % 0x100000000, 6);
  }
  socket.write(Buffer.concat([header, maskKey, masked]));
}

/* ---------------------------- frame parsing -------------------------------- */

function onSocketData(conn, chunk, onMsg) {
  conn.buffer = Buffer.concat([conn.buffer, chunk]);
  for (;;) {
    const buf = conn.buffer;
    if (buf.length < 2) return;
    const opcode = buf[0] & 0x0f;
    const fin = (buf[0] & 0x80) !== 0;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      const hi = buf.readUInt32BE(2);
      const lo = buf.readUInt32BE(6);
      len = hi * 0x100000000 + lo;
      off = 10;
    }
    let maskKey = null;
    if (masked) {
      if (buf.length < off + 4) return;
      maskKey = buf.slice(off, off + 4);
      off += 4;
    }
    if (buf.length < off + len) return;
    let payload = buf.slice(off, off + len);
    conn.buffer = buf.slice(off + len);
    if (maskKey) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }
    if (!fin) {
      conn.close(); // fragmented frames not expected here
      return;
    }
    handleFrame(conn, opcode, payload, onMsg);
  }
}

function handleFrame(conn, opcode, payload, onMsg) {
  conn.alive = true;
  if (opcode === 0x1) {
    let msg;
    try { msg = JSON.parse(payload.toString("utf8")); } catch (_) { return; }
    onMsg(conn, msg);
  } else if (opcode === 0x8) {
    conn.socket.destroy();
  } else if (opcode === 0x9) {
    sendPong(conn.socket, payload);
  }
}

/* ------------------------------- messaging --------------------------------- */

function onMessage(conn, msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "hello") {
    extension = conn;
    conn.info = { name: msg.name || "unknown", version: msg.version || "" };
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("extension reconnected mid-request"));
    }
    pending.clear();
    console.error("[yba] extension connected:", conn.info.name, conn.info.version);
  } else if (msg.type === "resp") {
    const p = pending.get(msg.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || "extension reported an error"));
    }
  } else if (msg.type === "ping") {
    // app-level heartbeat reply, lets the extension detect a zombie
    // connection (readyState can lie if this process died uncleanly)
    try { conn.send({ type: "pong" }); } catch (_) { }
  }
}

function execute(cmd, params) {
  // Multiple agents (each its own MCP client spawning its own instance of this
  // process) share one extension connection: whichever instance bound the
  // port first is the "hub" and dispatches directly; every later instance is
  // a "follower" that proxies through the hub over the internal /agents link.
  return mode === "follower" ? followerExecute(cmd, params) : executeLocal(cmd, params, SESSION_ID);
}

function executeLocal(cmd, params, sessionId) {
  return new Promise((resolve, reject) => {
    if (!extension) {
      reject(new Error("no extension connected — open Chrome, click the Your Browser Agent icon and press Connect"));
      return;
    }
    const id = ++nextCmdId;
    const timeoutMs = Math.min(Number(params.timeoutMs) || 30000, 120000);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("command timed out after " + timeoutMs + "ms: " + cmd));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    extension.send({ type: "cmd", id, cmd, params, sessionId: sessionId || SESSION_ID });
  });
}

function dropExtension(conn) {
  if (extension === conn) {
    extension = null;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("extension disconnected"));
    }
    pending.clear();
    console.error("[yba] extension disconnected");
  }
}

/* ------------------------------ websocket server ---------------------------- */
// A plain http server with two WS routes:
//   /ext    the Chrome extension connects here (unchanged from before)
//   /agents other instances of this same server (spawned for other agents)
//           connect here as followers and proxy their MCP tool calls through
//           this one, so N agents can share a single extension connection.
// No HTTP command API is exposed — agents talk MCP over stdio to their own
// process, which either handles it locally (hub) or forwards it here (follower).

const wsServer = http.createServer((req, res) => {
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "this port only serves WebSocket upgrades at /ext and /agents" }));
});

function acceptUpgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return null; }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );
  return makeConn(socket);
}

wsServer.on("upgrade", (req, socket) => {
  if (req.url === "/ext") {
    const conn = acceptUpgrade(req, socket);
    if (!conn) return;
    socket.on("data", (chunk) => onSocketData(conn, chunk, onMessage));
    socket.on("close", () => dropExtension(conn));
    socket.on("error", () => dropExtension(conn));
  } else if (req.url === "/agents") {
    const conn = acceptUpgrade(req, socket);
    if (!conn) return;
    socket.on("data", (chunk) => onSocketData(conn, chunk, handleAgentMessage));
    socket.on("error", () => { try { socket.destroy(); } catch (_) { } });
  } else {
    socket.destroy();
  }
});

// A follower forwards a tool call here; we run it locally and mirror the
// result back down that same follower's own connection.
function handleAgentMessage(conn, msg) {
  if (!msg || msg.type !== "cmd") return;
  executeLocal(msg.cmd, msg.params || {}, msg.sessionId).then(
    (result) => conn.send({ type: "resp", id: msg.id, ok: true, result }),
    (err) => conn.send({ type: "resp", id: msg.id, ok: false, error: (err && err.message) || String(err) })
  );
}

setInterval(() => {
  if (extension) {
    if (!extension.alive) {
      dropExtension(extension);
      extension.socket.destroy();
      return;
    }
    extension.alive = false;
    try { sendPing(extension.socket); } catch (_) { }
  }
}, HEARTBEAT_MS);

/* ------------------------- stale-instance takeover -------------------------
 * MCP clients (Claude Desktop, VS Code, ...) spawn a fresh instance of this
 * server per session. If a previous instance was orphaned — the client
 * crashed, was force-quit, or was killed without giving its child a chance to
 * exit — it keeps holding the port forever, and every future instance fails
 * to bind and silently never gets a working extension connection. To avoid
 * that turning into a permanent, confusing dead end, we track our own PID in
 * a lock file and, on startup, terminate a previous instance of *this exact
 * script* still holding it (never anything we can't positively identify as
 * our own process). */

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function looksLikeOurProcess(pid) {
  try {
    const out = process.platform === "win32"
      ? execFileSync("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        "(Get-CimInstance Win32_Process -Filter \"ProcessId=" + pid + "\").CommandLine",
      ], { encoding: "utf8", timeout: 3000 })
      : execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 3000 });
    return /mcp-server\.mjs|relay\.js/i.test(out);
  } catch (_) {
    return false; // can't confirm identity — leave it alone
  }
}

function reapStaleInstance() {
  let prev;
  try { prev = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")); } catch (_) { return; }
  if (!prev || !prev.pid || prev.pid === process.pid || !pidAlive(prev.pid)) return;
  if (!looksLikeOurProcess(prev.pid)) return;
  console.error("[yba] found an orphaned previous instance (pid " + prev.pid + ") holding port " + PORT + " — stopping it");
  try { process.kill(prev.pid, process.platform === "win32" ? undefined : "SIGTERM"); } catch (_) { }
}

function writeLock() {
  try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, port: PORT, startedAt: Date.now() })); } catch (_) { }
}

function removeLockIfOurs() {
  try {
    const prev = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    if (prev && prev.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (_) { }
}

for (const sig of ["exit", "SIGINT", "SIGTERM"]) {
  process.on(sig, () => { removeLockIfOurs(); if (sig !== "exit") process.exit(0); });
}
// Retry with backoff instead of crashing: MCP clients often restart this
// process while the previous instance is still releasing the port (or
// another local instance is briefly running), so treat EADDRINUSE as
// transient rather than fatal — the stdio/MCP side must stay alive either way.
let listenRetryMs = 500;
function startWsServer() {
  wsServer.listen(PORT, "127.0.0.1");
}
wsServer.on("listening", () => {
  listenRetryMs = 500;
  writeLock();
  console.error("[yba] extension link listening on ws://127.0.0.1:" + PORT + "/ext (hub)");
});
wsServer.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error("[yba] port " + PORT + " is in use (another instance running?) — retrying in " + listenRetryMs + "ms");
    setTimeout(() => {
      listenRetryMs = Math.min(listenRetryMs * 2, 15000);
      startWsServer();
    }, listenRetryMs);
  } else {
    console.error("[yba] extension link error:", err && err.message ? err.message : err);
  }
});

function becomeHub() {
  mode = "hub";
  reapStaleInstance();
  startWsServer();
}

/* --------------------------- multi-agent follower --------------------------
 * Each MCP client spawns its own instance of this process. Only one instance
 * can own the extension's WebSocket connection (the "hub"); every other
 * instance detects it via a quick handshake against the hub's internal
 * /agents endpoint and becomes a "follower" that proxies its own tool calls
 * through the hub instead of fighting it for the port — this is what lets
 * many agents concurrently drive the same browser. */

function tryBecomeFollower() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    const key = crypto.randomBytes(16).toString("base64");
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: "/agents",
      headers: {
        Connection: "Upgrade", Upgrade: "websocket",
        "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13",
      },
    });
    req.on("upgrade", (res, socket) => {
      const conn = makeConn(socket);
      conn.send = (obj) => sendTextMasked(socket, JSON.stringify(obj)); // follower must mask outgoing frames
      mode = "follower";
      agentSocket = conn;
      socket.on("data", (chunk) => onSocketData(conn, chunk, onFollowerMessage));
      socket.on("close", () => {
        agentSocket = null;
        for (const [, p] of followerPending) { clearTimeout(p.timer); p.reject(new Error("hub connection lost")); }
        followerPending.clear();
        console.error("[yba] lost the hub connection — reconnecting or taking over");
        tryBecomeFollower().then((ok) => { if (!ok) becomeHub(); });
      });
      socket.on("error", () => { try { socket.destroy(); } catch (_) { } });
      console.error("[yba] an existing instance is already serving the extension link — running as a follower");
      finish(true);
    });
    req.on("error", () => finish(false));
    req.setTimeout(1200, () => { req.destroy(); finish(false); });
    req.end();
  });
}

function followerExecute(cmd, params) {
  return new Promise((resolve, reject) => {
    if (!agentSocket) {
      reject(new Error("no extension connected (not linked to a hub) — open Chrome, click the Your Browser Agent icon and press Connect"));
      return;
    }
    const id = ++followerNextId;
    const timeoutMs = Math.min(Number(params.timeoutMs) || 30000, 120000);
    const timer = setTimeout(() => {
      followerPending.delete(id);
      reject(new Error("command timed out after " + timeoutMs + "ms: " + cmd));
    }, timeoutMs);
    followerPending.set(id, { resolve, reject, timer });
    agentSocket.send({ type: "cmd", id, cmd, params, sessionId: SESSION_ID });
  });
}

function onFollowerMessage(_conn, msg) {
  if (!msg || msg.type !== "resp") return;
  const p = followerPending.get(msg.id);
  if (p) {
    clearTimeout(p.timer);
    followerPending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || "hub reported an error"));
  }
}

const becameFollower = await tryBecomeFollower();
if (!becameFollower) becomeHub();

/* ---------------------------------- MCP ------------------------------------- */

const server = new McpServer({ name: "your-browser-agent", version: "1.0.0" });

const frameParam = z.union([z.number(), z.string()]).optional()
  .describe("Frame index/frameId/URL substring from the frames tool (default: main frame)");
const tabIdParam = z.number().optional().describe("Target tab id (default: last used tab)");
const timeoutParam = z.number().optional().describe("Timeout in ms (default 30000, max 120000)");

function tool(name, description, shape, mapParams) {
  server.registerTool(
    name,
    { description, inputSchema: shape },
    async (args) => {
      try {
        const params = mapParams ? mapParams(args) : args;
        const result = await execute(name, params || {});
        return { content: [{ type: "text", text: JSON.stringify(result ?? null) }] };
      } catch (e) {
        return { content: [{ type: "text", text: "Error: " + (e && e.message ? e.message : String(e)) }], isError: true };
      }
    }
  );
}

tool("ping", "Liveness check for the extension link.", {});

tool("tabs", "List open browser tabs.", {});

tool("newTab", "Open a fresh tab (does not disturb the user's existing tabs).", {
  url: z.string().describe("URL to open"),
});

tool("goto", "Navigate an existing tab to a URL.", {
  url: z.string(),
  tabId: tabIdParam,
  timeoutMs: timeoutParam,
});

tool("activate", "Bring a tab to the front and focus its window.", { tabId: tabIdParam });

tool("closeTab", "Close a tab that was opened for automation.", { tabId: tabIdParam });

tool("reload", "Reload the current page.", {
  ignoreCache: z.boolean().optional(),
  tabId: tabIdParam,
  timeoutMs: timeoutParam,
});

tool("back", "Go back to the previous page in history.", { tabId: tabIdParam });
tool("forward", "Go forward to the next page in history.", { tabId: tabIdParam });

tool(
  "snapshot",
  "Capture an accessibility-style snapshot of the page: interactive elements with refs (e1, e2, ...), role, name, tag and selector. Always re-snapshot after any action that changes the page.",
  {
    maxNodes: z.number().optional().describe("Max nodes to return (default 100)"),
    includeText: z.boolean().optional().describe("Include page text (default true)"),
    frame: frameParam,
    tabId: tabIdParam,
  }
);

tool("frames", "List frames/iframes on the page (0 = main frame).", { tabId: tabIdParam });

tool(
  "click",
  "Trusted pointer click at the centre of an element (auto-scrolls into view).",
  {
    selector: z.string().describe("ref (e1), CSS selector, text=, or role= selector"),
    frame: frameParam,
    method: z.string().optional(),
    button: z.string().optional(),
    double: z.boolean().optional(),
    point: z.object({
      x: z.number().optional(),
      y: z.number().optional(),
      fx: z.number().optional(),
      fy: z.number().optional(),
    }).optional().describe("Pixel or box-fraction offset, needed for cross-origin frames"),
    tabId: tabIdParam,
  }
);

tool("hover", "Real pointer move over an element (opens hover menus/tooltips).", {
  selector: z.string(),
  frame: frameParam,
  tabId: tabIdParam,
});

tool(
  "fill",
  "Type into inputs/textareas/contenteditable, check checkboxes/radios, or select an <option> by value or visible label.",
  {
    selector: z.string(),
    value: z.string(),
    frame: frameParam,
    method: z.string().optional(),
    tabId: tabIdParam,
  }
);

tool("selectOptions", "List a <select> element's options.", {
  selector: z.string(),
  frame: frameParam,
  tabId: tabIdParam,
});

tool(
  "press",
  "Send a key or keyboard shortcut (e.g. Control+A).",
  {
    key: z.string(),
    modifiers: z.array(z.enum(["Control", "Shift", "Alt", "Meta"])).optional(),
    selector: z.string().optional(),
    frame: frameParam,
    tabId: tabIdParam,
  }
);

tool("evaluate", "Run JavaScript in the page's main world; must return a JSON-serializable value.", {
  expression: z.string(),
  frame: frameParam,
  tabId: tabIdParam,
});

tool(
  "waitFor",
  "Poll until a condition is true: expr (JS), text, selector, urlContains, or dialogGone.",
  {
    expr: z.string().optional(),
    text: z.string().optional(),
    selector: z.string().optional(),
    urlContains: z.string().optional(),
    dialogGone: z.boolean().optional(),
    timeoutMs: timeoutParam,
    frame: frameParam,
    tabId: tabIdParam,
  }
);

tool(
  "scroll",
  "Scroll the page/frame, or bring an element into view.",
  {
    direction: z.enum(["up", "down"]).optional(),
    amount: z.number().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    selector: z.string().optional(),
    frame: frameParam,
    tabId: tabIdParam,
  }
);

tool("upload", "Attach real file(s) to an <input type=\"file\"> (fires change).", {
  selector: z.string(),
  files: z.union([z.string(), z.array(z.string())]).describe("Absolute path(s)"),
  frame: frameParam,
  tabId: tabIdParam,
});

tool("screenshot", "Take a screenshot of the current page.", {
  format: z.enum(["png", "jpeg"]).optional(),
  fullPage: z.boolean().optional(),
  quality: z.number().optional(),
  tabId: tabIdParam,
});

tool("pdf", "Save the current page as a PDF.", {
  printBackground: z.boolean().optional(),
  landscape: z.boolean().optional(),
  scale: z.number().optional(),
  tabId: tabIdParam,
});

tool("dialog", "Answer an open alert()/confirm()/prompt() dialog.", {
  accept: z.boolean(),
  promptText: z.string().optional(),
  tabId: tabIdParam,
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[yba] MCP server ready on stdio (" + mode + ")");

