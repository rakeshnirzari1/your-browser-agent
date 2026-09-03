"use strict";

const dot = document.getElementById("dot");
const state = document.getElementById("state");
const urlInput = document.getElementById("url");
const connectBtn = document.getElementById("connect");

function setConnected(ok, detail) {
  dot.className = "dot " + (ok ? "ok" : "bad");
  state.textContent = ok ? "Connected — your agent can drive this browser" : detail || "Not connected";
}

async function refresh() {
  const st = await chrome.runtime.sendMessage({ type: "ybaGetState" }).catch(() => null);
  const cfg = st && st.configuredUrl ? st.configuredUrl : "ws://127.0.0.1:7799/ext";
  urlInput.value = cfg;
  if (st && st.connected) {
    setConnected(true);
  } else {
    // ask the relay directly whether it sees an extension
    try {
      const base = cfg.replace(/^ws:\/\//, "http://").replace(/\/ext$/, "");
      const r = await fetch(base + "/status", { cache: "no-store" });
      const j = await r.json();
      if (j && j.extension) setConnected(true);
      else setConnected(false, "Relay is up but not connected — press Connect");
    } catch (_) {
      setConnected(false, "Relay not reachable — is node relay.js running?");
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

refresh();
