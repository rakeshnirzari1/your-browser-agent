#!/usr/bin/env node
/**
 * Your Browser Agent — local relay (zero dependencies, Node >= 16).
 *
 * The Chrome extension connects OUT to this relay over WebSocket; AI agents
 * (Claude Code, Codex, Hermes, ...) send plain HTTP JSON to it. This keeps
 * everything on 127.0.0.1 — no cloud, no accounts, no extra tooling.
 *
 * Run:  node relay.js            (port 7799 by default)
 *       node relay.js 8123       (custom port)
 *       YBA_PORT=8123 node relay.js
 *
 * API:
 *   GET  /status          -> { extension: bool, port, ... }
 *   POST /cmd             -> body { "cmd": "...", "params": {...} }
 *   WebSocket /ext        -> the extension's outbound connection
 */
"use strict";

const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.argv[2]) || Number(process.env.YBA_PORT) || 7799;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const HEARTBEAT_MS = 15000;

let extension = null;      // connected extension socket wrapper
let nextCmdId = 0;
const pending = new Map(); // id -> {resolve, reject, timer}

/* ------------------------------ WebSocket conn ------------------------------ */

function makeConn(socket) {
  return {
    socket,
    alive: true,
    buffer: Buffer.alloc(0),
    send(obj) { sendText(this.socket, JSON.stringify(obj)); },
    close() {
      try {
        sendFrame(this.socket, 0x8, Buffer.alloc(0));
      } catch (_) { }
      try { this.socket.destroy(); } catch (_) { }
    },
  };
}

function sendText(socket, text) {
  sendFrame(socket, 0x1, Buffer.from(text, "utf8"));
}

function sendPing(socket) {
  sendFrame(socket, 0x9, Buffer.from("hb", "utf8"));
}

function sendPong(socket, payload) {
  sendFrame(socket, 0xA, payload);
}

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

/* ---------------------------- frame parsing -------------------------------- */

function onSocketData(conn, chunk) {
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
      // fragmented frames not expected from the extension — drop connection
      conn.close();
      return;
    }
    handleFrame(conn, opcode, payload);
  }
}

function handleFrame(conn, opcode, payload) {
  conn.alive = true; // any frame (incl. browser auto-pongs) means the peer is alive
  if (opcode === 0x1) {
    let msg;
    try { msg = JSON.parse(payload.toString("utf8")); } catch (_) { return; }
    onMessage(conn, msg);
  } else if (opcode === 0x8) {
    conn.socket.destroy();
  } else if (opcode === 0x9) {
    sendPong(conn.socket, payload);
  } else if (opcode === 0xA) {
    // pong — connection alive
  }
}

/* ------------------------------- messaging --------------------------------- */

function onMessage(conn, msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "hello") {
    extension = conn;
    conn.info = { name: msg.name || "unknown", version: msg.version || "" };
    // a fresh extension took over — fail any straggler requests
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("extension reconnected mid-request"));
    }
    pending.clear();
    console.log("[yba] extension connected:", conn.info.name, conn.info.version);
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
  return new Promise((resolve, reject) => {
    if (!extension) {
      reject(new Error("no extension connected — click the Your Browser Agent icon and press Connect"));
      return;
    }
    const id = ++nextCmdId;
    const timeoutMs = Math.min(Number(params.timeoutMs) || 30000, 120000);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("command timed out after " + timeoutMs + "ms: " + cmd));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    extension.send({ type: "cmd", id, cmd, params });
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
    console.log("[yba] extension disconnected");
  }
}

/* -------------------------------- HTTP API --------------------------------- */

const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(body);
  };

  if (req.method === "OPTIONS") { send(204, {}); return; }

  if (req.method === "GET" && (req.url === "/status" || req.url === "/")) {
    send(200, {
      name: "your-browser-agent",
      version: "1.0.0",
      extension: !!extension,
      extensionVersion: extension && extension.info ? extension.info.version : null,
      pending: pending.size,
      port: PORT,
      docs: "POST /cmd with {cmd, params}",
    });
    return;
  }

  if (req.method === "POST" && req.url === "/cmd") {
    let raw = "";
    req.on("data", (d) => { raw += d; if (raw.length > 1e6) req.destroy(); });
    req.on("end", () => {
      let body;
      try { body = JSON.parse(raw); } catch (_) {
        send(400, { ok: false, error: "invalid JSON body" });
        return;
      }
      const cmd = body && body.cmd;
      const params = (body && body.params) || {};
      if (typeof cmd !== "string" || !cmd) {
        send(400, { ok: false, error: "missing cmd" });
        return;
      }
      execute(cmd, params)
        .then((result) => send(200, { ok: true, result }))
        .catch((e) => send(502, { ok: false, error: e.message || String(e) }));
    });
    return;
  }

  send(404, { ok: false, error: "not found — try GET /status or POST /cmd" });
});

/* ------------------------------ websocket handshake ------------------------ */

server.on("upgrade", (req, socket) => {
  if (req.url !== "/ext") {
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );
  const conn = makeConn(socket);
  socket.on("data", (chunk) => onSocketData(conn, chunk));
  socket.on("close", () => dropExtension(conn));
  socket.on("error", () => dropExtension(conn));
});

/* --------------------------------- heartbeat -------------------------------- */

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

server.listen(PORT, "127.0.0.1", () => {
  console.log("[yba] relay listening on http://127.0.0.1:" + PORT);
  console.log("[yba] extension connects to ws://127.0.0.1:" + PORT + "/ext");
  console.log("[yba] agents POST commands to http://127.0.0.1:" + PORT + "/cmd");
});
