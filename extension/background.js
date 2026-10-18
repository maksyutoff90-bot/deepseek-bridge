// Service worker: единственное место, где расширение ходит в сеть.
// Так запросы к 127.0.0.1 не зависят от CSP страницы chat.deepseek.com.
const DEFAULTS = { port: 8787, token: "", autoSend: false, capture: true, noAutoExpand: false };

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const patch = {};
  for (const [k, v] of Object.entries(DEFAULTS)) if (cur[k] === undefined) patch[k] = v;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});

async function cfg() {
  const cur = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...cur };
}

async function ping() {
  const { port, token } = await cfg();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    return { ...body, ok: res.ok && body.ok !== false, port };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), port };
  }
}

async function exec(payload) {
  const { port, token } = await cfg();
  if (!token) return { ok: false, error: "токен не задан: откройте настройки расширения" };
  const t0 = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webcode-token": token },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ...body, ok: false, error: body.error || `HTTP ${res.status}`, ms: Date.now() - t0 };
    }
    return { ...body, ms: Date.now() - t0 };
  } catch (e) {
    return {
      ok: false,
      error: `шлюз недоступен на 127.0.0.1:${port} — запустите start-gateway.cmd (${e.message || e})`,
      ms: Date.now() - t0,
    };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "config") {
    cfg().then(sendResponse);
    return true;
  }
  if (msg.type === "ping") {
    ping().then(sendResponse);
    return true;
  }
  if (msg.type === "exec") {
    exec(msg.payload || {}).then(sendResponse);
    return true;
  }
  if (msg.type === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return true;
  }
});
