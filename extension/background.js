// Service worker: единственное место, где расширение ходит в сеть.
// Так запросы к 127.0.0.1 не зависят от CSP страницы chat.deepseek.com.
const DEFAULTS = { port: 8787, token: "", autoSend: false, capture: true, noAutoExpand: false, lang: "en" };

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const patch = {};
  for (const [k, v] of Object.entries(DEFAULTS)) if (cur[k] === undefined) patch[k] = v;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  await cfg();
});

// Токен дозабираем при старте браузера, не дожидаясь открытия чата.
chrome.runtime.onStartup?.addListener(() => {
  cfg();
});

async function fetchToken(port) {
  const url = `http://127.0.0.1:${port}/token`;
  try {
    // Сначала простой GET (Firefox не любит preflight), затем с заголовком.
    let res = await fetch(url, { cache: "no-store" });
    if (res.status === 403) {
      res = await fetch(url, { headers: { "x-webcode-setup": "1" }, cache: "no-store" });
    }
    if (!res.ok) return "";
    const body = await res.json();
    return body && body.ok && body.token ? String(body.token) : "";
  } catch {
    return "";
  }
}

async function cfg() {
  const cur = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const conf = { ...DEFAULTS, ...cur };
  if (!conf.token) {
    const token = await fetchToken(conf.port);
    if (token) {
      await chrome.storage.local.set({ token });
      conf.token = token;
    }
  }
  return conf;
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

async function roots() {
  const { port, token } = await cfg();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/roots`, {
      headers: { "x-webcode-token": token },
      cache: "no-store",
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

async function setRoot(path) {
  const { port, token } = await cfg();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/root`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webcode-token": token },
      body: JSON.stringify({ path }),
      cache: "no-store",
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
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
  if (msg.type === "token") {
    cfg().then((c) => sendResponse({ ok: !!c.token, token: c.token }));
    return true;
  }
  if (msg.type === "ping") {
    ping().then(sendResponse);
    return true;
  }
  if (msg.type === "roots") {
    roots().then(sendResponse);
    return true;
  }
  if (msg.type === "setRoot") {
    setRoot(msg.path).then(sendResponse);
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
