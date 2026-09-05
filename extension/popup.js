"use strict";

const dot = document.getElementById("dot");
const state = document.getElementById("state");
const meta = document.getElementById("meta");
const urlInput = document.getElementById("url");
const connectBtn = document.getElementById("connect");
const disconnectBtn = document.getElementById("disconnect");

let timer = null;

function setState(cls, html, metaText) {
  dot.className = "dot " + cls;
  state.innerHTML = html;
  meta.textContent = metaText || "";
}

async function refresh() {
  const st = await chrome.runtime.sendMessage({ type: "ybaGetState" }).catch(() => null);
  const cfg = (st && st.configuredUrl) || "ws://127.0.0.1:7799/ext";
  urlInput.value = cfg;

  if (st && st.connected) {
    setState("ok", "<span class=\"oktext\">Connected</span> — your agent can drive this browser", "WS " + (st.url || cfg));
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
  } else if (st && st.manualDisconnect) {
    setState("bad", "Disconnected — press <b>Connect</b> to let your agent drive this browser again", cfg);
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
  } else {
    setState("wait", "Not connected — waiting for the MCP server, or press <b>Connect</b>", cfg);
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
  }
}

connectBtn.addEventListener("click", async () => {
  connectBtn.disabled = true;
  const url = urlInput.value.trim();
  await chrome.runtime.sendMessage({ type: "ybaSetUrl", url }).catch(() => { });
  await new Promise((r) => setTimeout(r, 1200));
  await refresh();
});

disconnectBtn.addEventListener("click", async () => {
  disconnectBtn.disabled = true;
  await chrome.runtime.sendMessage({ type: "ybaDisconnect" }).catch(() => { });
  await refresh();
});

// keep the status live while the popup is open
refresh();
clearInterval(timer);
timer = setInterval(refresh, 2000);
window.addEventListener("unload", () => clearInterval(timer));

window.addEventListener("unload", () => clearInterval(timer));
