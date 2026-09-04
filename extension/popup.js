"use strict";

const dot = document.getElementById("dot");
const state = document.getElementById("state");
const meta = document.getElementById("meta");
const urlInput = document.getElementById("url");
const connectBtn = document.getElementById("connect");
const testBtn = document.getElementById("test");

let lastRelayOk = null; // null = unknown, true/false = last known
let timer = null;

function setState(cls, html, metaText) {
  dot.className = "dot " + cls;
  state.innerHTML = html;
  meta.textContent = metaText || "";
}

function httpBase(wsUrl) {
  return wsUrl.replace(/^ws:\/\//, "http://").replace(/\/ext$/, "");
}

async function probeRelay(base) {
  try {
    const r = await fetch(base + "/status", { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  }
}

async function refresh() {
  const st = await chrome.runtime.sendMessage({ type: "ybaGetState" }).catch(() => null);
  const cfg = (st && st.configuredUrl) || "ws://127.0.0.1:7799/ext";
  urlInput.value = cfg;
  const base = httpBase(cfg);

  if (st && st.connected) {
    lastRelayOk = await probeRelay(base).then((j) => !!(j && j.extension));
    if (lastRelayOk) {
      setState("ok", "<span class=\"oktext\">Connected</span> — your agent can drive this browser", "WS " + (st.url || cfg));
    } else {
      setState("wait", "Extension connected, waiting for the relay…", "WS " + (st.url || cfg));
    }
  } else {
    const j = await probeRelay(base);
    if (j && j.extension) {
      setState("ok", "<span class=\"oktext\">Connected</span> — your agent can drive this browser", "relay on " + base);
    } else if (j) {
      setState("bad", "Relay is up but the extension is not connected — press <b>Connect</b>", "relay on " + base);
    } else {
      setState("bad", "Relay not reachable — is <code>node relay.js</code> running?", base + " did not answer");
    }
  }
}

connectBtn.addEventListener("click", async () => {
  connectBtn.disabled = true;
  const url = urlInput.value.trim();
  await chrome.runtime.sendMessage({ type: "ybaSetUrl", url }).catch(() => { });
  await new Promise((r) => setTimeout(r, 1200));
  await refresh();
  connectBtn.disabled = false;
});

testBtn.addEventListener("click", async () => {
  testBtn.disabled = true;
  testBtn.textContent = "…";
  const base = httpBase(urlInput.value.trim() || "ws://127.0.0.1:7799/ext");
  const t0 = performance.now();
  try {
    const r = await fetch(base + "/cmd", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "ping", params: {} }),
    });
    const j = await r.json();
    const ms = Math.round(performance.now() - t0);
    if (j && j.ok) setState("ok", "<span class=\"oktext\">Test passed</span> — browser answered in " + ms + "ms", "engine " + (j.result && j.result.engine));
    else setState("bad", "Test failed: " + ((j && j.error) || "unknown"), "");
  } catch (_) {
    setState("bad", "Test failed — relay not reachable", "");
  }
  testBtn.disabled = false;
  testBtn.textContent = "Test";
});

// keep the status live while the popup is open
refresh();
clearInterval(timer);
timer = setInterval(refresh, 2000);
window.addEventListener("unload", () => clearInterval(timer));
