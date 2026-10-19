#!/usr/bin/env node
// End-to-end проверка прототипа:
//   1) инструменты шлюза (list/read/grep/run/write/replace + защита путей);
//   2) мост в браузере: блок ```webcode на странице -> шлюз -> файл -> результат в поле ввода.
// Режимы: если Chrome всё ещё разрешает --load-extension, тестируется настоящее
// расширение; иначе content.js внедряется в страницу с шимом chrome.runtime
// (проверяется вся логика моста, кроме хоста расширения).
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.resolve(HERE, "..");
const EXT = path.join(BASE, "extension");
const TEST_ROOT = path.join(BASE, ".test-root");
const TEST_CONFIG = path.join(BASE, ".test-config.json");
const PROFILE = path.join(BASE, ".chrome-profile-test");
const LOGS = path.join(BASE, "logs");
const PORT = Number(process.env.WC_TEST_PORT || 8799);
const CDP_PORT = Number(process.env.WC_TEST_CDP || 9333);
const TOKEN = "test-token-e2e";
const MOCK_URL = `http://127.0.0.1:${PORT}/webcode-mock/chat.html?history=600`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let mode = "unknown";
let chromeProc = null;
let gatewayProc = null;

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function check(name, fn) {
  try {
    const d = await fn();
    record(name, true, typeof d === "string" ? d : "");
  } catch (e) {
    record(name, false, e && e.message ? e.message : String(e));
  }
}

// ------------------------------------------------------------- шлюз ----
async function api(tool, args, token = TOKEN) {
  const res = await fetch(`http://127.0.0.1:${PORT}/exec`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-webcode-token": token },
    body: JSON.stringify({ tool, args }),
  });
  return { status: res.status, body: await res.json() };
}

async function prepareRoot() {
  await fsp.rm(TEST_ROOT, { recursive: true, force: true });
  await fsp.mkdir(path.join(TEST_ROOT, "src"), { recursive: true });
  await fsp.writeFile(path.join(TEST_ROOT, "hello.txt"), "hello webcode\nsecond line\n");
  await fsp.writeFile(path.join(TEST_ROOT, "src", "app.py"), "def main():\n    print('TODO fix')\n");
  await fsp.writeFile(path.join(TEST_ROOT, "secret.txt"), "TOP SECRET\n");
  await fsp.writeFile(path.join(BASE, "outside-secret.txt"), "OUTSIDE SECRET\n");
  // Отдельный конфиг: тесты не зависят от рабочего gateway/config.json.
  await fsp.writeFile(
    TEST_CONFIG,
    JSON.stringify(
      {
        root: TEST_ROOT,
        port: PORT,
        sandbox: true,
        sandboxDir: "_fixes",
        allowWrite: true,
        allowRun: true,
        runTimeoutMs: 30000,
        mock: true,
      },
      null,
      2
    ),
    "utf8"
  );
}

async function startGateway() {
  await fsp.mkdir(LOGS, { recursive: true });
  const out = fs.createWriteStream(path.join(LOGS, "e2e-gateway.log"), { flags: "w" });
  gatewayProc = spawn(
    process.execPath,
    [path.join(BASE, "gateway", "server.mjs"), "--config", TEST_CONFIG, "--root", TEST_ROOT, "--port", String(PORT)],
    { env: { ...process.env, WEBCODE_TOKEN: TOKEN, WC_NO_OPEN: "1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );
  gatewayProc.stdout.pipe(out);
  gatewayProc.stderr.pipe(out);
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(120);
  }
  throw new Error("шлюз не поднялся на порту " + PORT);
}

// ----------------------------------------------------------- Chrome ----
function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe"),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

async function launchChrome() {
  const exe = chromePath();
  if (!exe) throw new Error("Chrome/Edge не найден");
  await fsp.rm(PROFILE, { recursive: true, force: true }).catch(() => {});
  const args = [
    "--headless=new",
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${CDP_PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-gpu",
    "--enable-unsafe-extension-debugging",
    "about:blank",
  ];
  chromeProc = spawn(exe, args, { stdio: "ignore", windowsHide: true });
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) return exe;
    } catch {}
    await sleep(250);
  }
  throw new Error("Chrome не открыл CDP на порту " + CDP_PORT);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.waiting = new Map();
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const pending = msg.id && this.waiting.get(msg.id);
      if (!pending) return;
      this.waiting.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else pending.resolve(msg.result);
    };
  }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("не удалось подключиться к " + url));
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.seq;
    const p = new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
    this.ws.send(JSON.stringify({ id, method, params }));
    return p;
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
    return r.result ? r.result.value : undefined;
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function targets() {
  return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).filter(Boolean);
}

async function findSw() {
  const ts = await targets();
  return ts.find(
    (t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://") && t.url.endsWith("/background.js")
  );
}

// Chrome 137+ игнорирует --load-extension, но CDP умеет ставить unpacked-расширение.
async function loadExtensionViaCdp() {
  const ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
  const browser = await Cdp.open(ver.webSocketDebuggerUrl);
  try {
    const r = await browser.send("Extensions.loadUnpacked", { path: EXT });
    console.log(`расширение загружено через CDP: ${r.id}`);
  } catch (e) {
    console.log("Extensions.loadUnpacked не сработал: " + e.message);
    browser.close();
    return null;
  }
  browser.close();
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const sw = await findSw();
    if (sw) return sw;
    await sleep(200);
  }
  return null;
}

async function newTab(url) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  return res.json();
}

// service worker после переустановки может быть ещё «старым»: пишем настройки
// с проверкой и повтором, иначе расширение останется на порту по умолчанию.
async function setStorage(values) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const t = await findSw();
    if (!t) {
      await sleep(300);
      continue;
    }
    try {
      const p = await Cdp.open(t.webSocketDebuggerUrl);
      await p.eval(`chrome.storage.local.set(${JSON.stringify(values)}).then(() => true)`);
      const got = JSON.parse(await p.eval(`chrome.storage.local.get(null).then((o) => JSON.stringify(o))`));
      p.close();
      if (got && got.token === values.token && got.port === values.port) return true;
    } catch {}
    await sleep(400);
  }
  return false;
}

async function waitTarget(type, match, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    for (const t of await targets()) {
      if (t.type === type && match(t)) return t;
    }
    await sleep(250);
  }
  throw new Error(`не найден target ${type}`);
}

async function waitFor(page, expr, timeout = 15000, label = "") {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await page.eval(expr);
    } catch (e) {
      last = undefined;
    }
    if (last) return last;
    await sleep(200);
  }
  throw new Error(`таймаут ${timeout} мс: ${label || expr}`);
}

const SHIM = (autoSend) => `(() => {
  const PORT = ${PORT};
  const TOKEN = ${JSON.stringify(TOKEN)};
  const base = "http://127.0.0.1:" + PORT;
  const cfg = { port: PORT, token: TOKEN, autoSend: ${autoSend ? "true" : "false"}, lang: "en" };
  window.chrome = window.chrome || {};
  window.chrome.runtime = {
    id: "wc-e2e",
    sendMessage: async (msg) => {
      if (msg.type === "config") return cfg;
      if (msg.type === "ping") return fetch(base + "/health").then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
      if (msg.type === "exec") {
        const r = await fetch(base + "/exec", {
          method: "POST",
          headers: { "content-type": "application/json", "x-webcode-token": TOKEN },
          body: JSON.stringify(msg.payload),
        });
        return r.json();
      }
      return null;
    },
    openOptionsPage: () => {},
  };
  return true;
})()`;

async function injectAll(page, { autoSend }) {
  await page.eval(SHIM(autoSend));
  const css = await fsp.readFile(path.join(EXT, "panel.css"), "utf8");
  await page.eval(
    `(() => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); return true; })()`
  );
  const i18n = await fsp.readFile(path.join(EXT, "i18n.js"), "utf8");
  await page.eval(`${i18n}\n//# sourceURL=webcode-i18n.js`);
  const js = await fsp.readFile(path.join(EXT, "content.js"), "utf8");
  await page.eval(`${js}\n//# sourceURL=webcode-content.js`);
  await waitFor(page, `!!document.querySelector("#wc-host")`, 5000, "панель WebCode");
}

async function simulate(page, call, opts = { stream: true, text: "Working…" }) {
  await page.eval(`window.__wcMock.simulate(${JSON.stringify(call)}, ${JSON.stringify(opts)})`);
}

async function composerValue(page) {
  return page.eval(`(document.querySelector("#composer") || {}).value || ""`);
}

async function clearComposer(page) {
  await page.eval(`(() => { const t = document.querySelector("#composer"); t.value = ""; t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
}

// Имитация первого действия пользователя: без него мост считает всё
// отрисованное историей и ничего не обрабатывает.
async function markUserActivity(page) {
  await page.eval(`(() => {
    const t = document.querySelector("#composer");
    t.focus();
    t.value = "проверка";
    t.dispatchEvent(new Event("input", { bubbles: true }));
    t.value = "";
    t.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
}

async function main() {
  console.log("\n=== WebCode Bridge · e2e ===\n");
  await prepareRoot();

  // ---- 1. шлюз ----
  const health = await startGateway();
  await check("шлюз: /health отвечает и корень верный", async () => {
    assert(health.ok === true, "health.ok !== true");
    assert(path.resolve(health.root).toLowerCase() === TEST_ROOT.toLowerCase(), "корень не совпал: " + health.root);
    return health.root;
  });

  await check("инструмент list", async () => {
    const { body } = await api("list", { path: "." });
    const names = (body.entries || []).map((e) => e.name);
    assert(body.ok && names.includes("hello.txt") && names.includes("src"), "нет ожидаемых записей");
    return names.join(", ");
  });

  await check("инструмент read (с номерами строк)", async () => {
    const { body } = await api("read", { path: "hello.txt" });
    assert(body.ok, body.error);
    assert(/second line/.test(body.content), "нет содержимого");
    assert(/^1\| hello webcode/m.test(body.content), "нет нумерации строк");
    return body.shown + " строк";
  });

  await check("инструмент grep", async () => {
    const { body } = await api("grep", { pattern: "TODO", path: "." });
    assert(body.ok && body.matches === 1, "ожидалось 1 совпадение, получено " + JSON.stringify(body));
    assert(body.hits[0].file.endsWith("app.py") && body.hits[0].line === 2, "неверная позиция совпадения");
    return body.hits[0].file + ":" + body.hits[0].line;
  });

  await check("инструмент run", async () => {
    const { body } = await api("run", { command: "echo bridge-ok" });
    assert(body.ok && body.code === 0 && /bridge-ok/.test(body.stdout), JSON.stringify(body));
    return "exit 0, stdout ок";
  });

  await check("песочница: write не трогает исходник", async () => {
    const w = await api("write", { path: "src/from-api.txt", content: "написано тестом" });
    assert(w.body.ok, w.body.error);
    assert(w.body.staged === true, "ожидалась запись в песочницу");
    const staged = await fsp.readFile(path.join(TEST_ROOT, "_fixes", "src", "from-api.txt"), "utf8");
    assert(staged === "написано тестом", "нет файла в _fixes");
    assert(!fs.existsSync(path.join(TEST_ROOT, "src", "from-api.txt")), "исходник создан напрямую!");
    return w.body.path;
  });

  await check("песочница: replace не трогает исходник", async () => {
    const r = await api("replace", { path: "src/app.py", old: "TODO", new: "DONE" });
    assert(r.body.ok && r.body.staged === true, JSON.stringify(r.body));
    const original = await fsp.readFile(path.join(TEST_ROOT, "src", "app.py"), "utf8");
    assert(original.includes("TODO"), "исходник изменён без применения");
    const staged = await fsp.readFile(path.join(TEST_ROOT, "_fixes", "src", "app.py"), "utf8");
    assert(staged.includes("DONE"), "в песочнице нет результата замены");
    return "_fixes/src/app.py";
  });

  await check("staged: список сохранённых правок", async () => {
    const { body } = await api("staged", {});
    assert(body.ok && body.count === 2, "ожидалось 2 файла, получено " + body.count);
    const paths = body.entries.map((e) => e.original).sort();
    assert(paths.join(",") === "src/app.py,src/from-api.txt", "неверный список: " + paths.join(","));
    return paths.join(", ");
  });

  await check("apply: переносит в проект и делает бэкап", async () => {
    const { body } = await api("apply", {});
    assert(body.ok && body.applied === 2, JSON.stringify(body));
    const app = await fsp.readFile(path.join(TEST_ROOT, "src", "app.py"), "utf8");
    assert(app.includes("DONE"), "app.py не обновлён");
    const created = await fsp.readFile(path.join(TEST_ROOT, "src", "from-api.txt"), "utf8");
    assert(created === "написано тестом", "from-api.txt не создан");
    const withBackup = body.files.find((f) => f.backup);
    assert(withBackup, "бэкап не сделан");
    assert(fs.existsSync(path.join(TEST_ROOT, withBackup.backup)), "файла бэкапа нет");
    return "2 файла + бэкап";
  });

  await check("capture: файл из обычного кода", async () => {
    const { body } = await api("capture", { path: "notes/todo.md", content: "# Заметки\n- пункт\n", source: "code-block" });
    assert(body.ok && body.staged === true, JSON.stringify(body));
    const staged = await fsp.readFile(path.join(TEST_ROOT, "_fixes", "notes", "todo.md"), "utf8");
    assert(staged.includes("пункт"), "нет захваченного файла");
    assert(!fs.existsSync(path.join(TEST_ROOT, "notes", "todo.md")), "capture записал напрямую");
    return body.path;
  });

  await check("upload: бинарный файл из проводника (base64)", async () => {
    const raw = "binary-like\u0000data";
    const b64 = Buffer.from(raw, "latin1").toString("base64");
    const r = await api("upload", { path: "src/uploaded.bin", contentBase64: b64 });
    assert(r.body.ok && r.body.staged === true, JSON.stringify(r.body));
    const a = await api("apply", { path: "src/uploaded.bin" });
    assert(a.body.ok && a.body.applied === 1, JSON.stringify(a.body));
    const buf = await fsp.readFile(path.join(TEST_ROOT, "src", "uploaded.bin"));
    assert(buf.toString("latin1") === raw, "содержимое не совпало");
    return "bin ok";
  });

  await check("apply: короткий фрагмент не затирает большой файл", async () => {
    const big = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    await fsp.writeFile(path.join(TEST_ROOT, "src", "big.py"), big, "utf8");
    await api("capture", { path: "src/big.py", content: "def f():\n    return 1\n" });
    const { body } = await api("apply", { path: "src/big.py" });
    assert(body.ok && body.applied === 0 && body.skipped.length === 1, JSON.stringify(body));
    const still = await fsp.readFile(path.join(TEST_ROOT, "src", "big.py"), "utf8");
    assert(still === big, "большой файл всё-таки перезаписан");
    return "фрагмент пропущен, файл цел";
  });

  await check("remove: файл уходит в корзину _fixes", async () => {
    await fsp.writeFile(path.join(TEST_ROOT, "to_delete.txt"), "delete me", "utf8");
    const { body } = await api("remove", { path: "to_delete.txt" });
    assert(body.ok && body.removed === "to_delete.txt", JSON.stringify(body));
    assert(!fs.existsSync(path.join(TEST_ROOT, "to_delete.txt")), "файл не удалён");
    assert(fs.existsSync(path.join(TEST_ROOT, body.trashed)), "нет копии в корзине");
    return body.trashed;
  });

  await check("diff: без сохранённой правки — понятная ошибка", async () => {
    const { body } = await api("diff", { path: "hello.txt" });
    assert(body.ok === false && /нет сохранённой правки/.test(body.error), JSON.stringify(body));
    return body.error;
  });

  await check("scan: обзор проекта", async () => {
    await fsp.writeFile(path.join(TEST_ROOT, "todo_probe.py"), "# TODO probe`n", "utf8");
    const { body } = await api("scan", {});
    assert(body.ok && body.files >= 3, JSON.stringify(body));
    assert(body.byExt.some((e) => e.name === ".py"), "нет .py в статистике");
    assert(body.todos >= 1, "TODO не найден");
    return `${body.files} файлов, TODO=${body.todos}`;
  });

  await check("test: прогон команды", async () => {
    const { body } = await api("test", { command: "echo test-ok" });
    assert(body.ok && body.code === 0 && /test-ok/.test(body.tail), JSON.stringify(body));
    return "exit 0";
  });

  await check("gateway: /token только по заголовку", async () => {
    const bad = await fetch(`http://127.0.0.1:${PORT}/token`);
    assert(bad.status === 403, "без заголовка: " + bad.status);
    const good = await fetch(`http://127.0.0.1:${PORT}/token`, { headers: { "x-webcode-setup": "1" } });
    const body = await good.json();
    assert(good.status === 200 && body.token === TOKEN, "токен не совпал");
    return "403 / 200";
  });

  await check("проекты: список и переключение", async () => {
    const bad = await fetch(`http://127.0.0.1:${PORT}/roots`);
    assert(bad.status === 401, "без токена: " + bad.status);
    const list = await fetch(`http://127.0.0.1:${PORT}/roots`, {
      headers: { "x-webcode-token": TOKEN },
    }).then((r) => r.json());
    assert(list.ok && list.root, JSON.stringify(list));
    const target = path.join(TEST_ROOT, "src");
    const set = await fetch(`http://127.0.0.1:${PORT}/root`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webcode-token": TOKEN },
      body: JSON.stringify({ path: target }),
    }).then((r) => r.json());
    assert(set.ok && path.resolve(set.root) === path.resolve(target), JSON.stringify(set));
    const back = await fetch(`http://127.0.0.1:${PORT}/root`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webcode-token": TOKEN },
      body: JSON.stringify({ path: TEST_ROOT }),
    }).then((r) => r.json());
    assert(back.ok && path.resolve(back.root) === path.resolve(TEST_ROOT), JSON.stringify(back));
    const missing = await fetch(`http://127.0.0.1:${PORT}/root`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webcode-token": TOKEN },
      body: JSON.stringify({ path: path.join(TEST_ROOT, "no-such-dir") }),
    }).then((r) => r.json());
    assert(missing.ok === false, "несуществующая папка принята");
    return "roots ok";
  });

  await check("unit: sandbox=false пишет напрямую", async () => {
    const { createTools } = await import(pathToFileURL(path.join(BASE, "gateway", "tools.mjs")).href);
    const dir = path.join(BASE, ".test-nosandbox");
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    const t = createTools(dir, { sandbox: false });
    const r = await t.write({ path: "a/b.txt", content: "hi" });
    assert(r.staged === false, "ожидалась прямая запись");
    const text = await fsp.readFile(path.join(dir, "a", "b.txt"), "utf8");
    assert(text === "hi", "файл не записан");
    await fsp.rm(dir, { recursive: true, force: true });
    return "ok";
  });

  await check("защита: выход за root через ..", async () => {
    const { body } = await api("read", { path: "../outside-secret.txt" });
    assert(body.ok === false, "чтение вне корня разрешено!");
    assert(/выход|предел/i.test(body.error), "неожиданная ошибка: " + body.error);
    return body.error;
  });

  await check("защита: абсолютный путь вне root", async () => {
    const { body } = await api("read", { path: "C:\\Windows\\win.ini" });
    assert(body.ok === false, "абсолютный путь вне корня разрешён!");
    return body.error;
  });

  await check("защита: неверный токен", async () => {
    const { status, body } = await api("list", {}, "wrong-token");
    assert(status === 401 && body.ok === false, "ожидался 401, получен " + status);
    return "401";
  });

  await check("background.js: config / ping / exec / отказ по токену", async () => {
    const src = await fsp.readFile(path.join(EXT, "background.js"), "utf8");
    const store = {};
    const listeners = [];
    const fakeChrome = {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener: (fn) => listeners.push(fn) },
        openOptionsPage() {},
      },
      storage: {
        local: {
          async get(keys) {
            const out = {};
            for (const k of Array.isArray(keys) ? keys : [keys]) if (k in store) out[k] = store[k];
            return out;
          },
          async set(obj) {
            Object.assign(store, obj);
          },
        },
      },
    };
    const vm = await import("node:vm");
    vm.runInNewContext(src, { chrome: fakeChrome, fetch, console, setTimeout, performance, URL });
    assert(listeners.length === 1, "обработчик сообщений не зарегистрирован");
    const send = (msg) => new Promise((res) => listeners[0](msg, {}, res));

    const cfg0 = await send({ type: "config" });
    assert(cfg0.port === 8787 && typeof cfg0.token === "string" && cfg0.autoSend === false, "дефолты неверные: " + JSON.stringify(cfg0));
    const tok = await send({ type: "token" });
    assert(tok && tok.ok === Boolean(tok.token), "ответ token неверный: " + JSON.stringify(tok));

    store.port = PORT;
    store.token = TOKEN;
    const pong = await send({ type: "ping" });
    assert(pong.ok === true, "ping: " + JSON.stringify(pong));

    const read = await send({ type: "exec", payload: { tool: "read", args: { path: "hello.txt" } } });
    assert(read.ok === true && /second line/.test(read.content), "exec не вернул файл");

    store.token = "nope";
    const denied = await send({ type: "exec", payload: { tool: "read", args: { path: "hello.txt" } } });
    assert(denied.ok === false, "неверный токен не отбит background.js");
    return "4/4";
  });

  // ---- 2. браузер ----
  await launchChrome();
  let sw = await findSw();
  if (!sw) sw = await loadExtensionViaCdp();
  mode = sw ? "extension" : "shim";
  console.log(
    `\nрежим браузера: ${mode === "extension" ? "настоящее расширение (service worker в Chrome)" : "шим chrome.runtime"}\n`
  );

  const pageTarget = await newTab(MOCK_URL);
  const page = await Cdp.open(pageTarget.webSocketDebuggerUrl);
  await waitFor(page, `document.readyState === "complete"`, 20000, "загрузка mock-страницы");

  if (mode === "extension") {
    // Первая загрузка страницы «будит» service worker (нужно для chrome.storage),
    // затем сохраняем конфиг и перезагружаем вкладку уже с ним.
    await waitFor(page, `!!document.querySelector("#wc-host")`, 15000, "панель расширения");
    const okSet = await setStorage({ port: PORT, token: TOKEN, autoSend: false, capture: true, noAutoExpand: false });
    assert(okSet, "не удалось записать настройки расширения");
    await page.send("Page.reload", {});
    await sleep(600);
    await waitFor(page, `document.readyState === "complete"`, 20000, "перезагрузка mock-страницы");
    await waitFor(page, `!!document.querySelector("#wc-host")`, 15000, "панель после перезагрузки");
  } else {
    await injectAll(page, { autoSend: false });
  }

  await waitFor(page, `document.documentElement.dataset.wcReady === "1"`, 20000, "снимок истории");
  await markUserActivity(page);

  await check("панель WebCode появилась на странице", async () => {
    const v = await page.eval(`document.querySelector("#wc-host") ? "есть" : ""`);
    assert(v, "панели нет");
    return v;
  });

  await check("история чата не выполняется и не сохраняется", async () => {
    await sleep(2500);
    const junk = ["_fixes/history_a.py", "_fixes/history_b.py", "_fixes/history_write.txt"].filter((p) =>
      fs.existsSync(path.join(TEST_ROOT, p))
    );
    assert(!junk.length, "история обработана: " + junk.join(", "));
    return "history пропущена";
  });

  await check("мост: read-блок -> содержимое файла в поле ввода", async () => {
    await clearComposer(page);
    await simulate(page, { tool: "read", args: { path: "hello.txt" } });
    try {
      await waitFor(page, `((document.querySelector("#composer")||{}).value||"").includes("second line")`, 20000, "результат read в поле ввода");
    } catch (e) {
      const dbg = await page.eval(`JSON.stringify({
        log: (document.querySelector("#wc-log")||{}).innerText || "",
        composer: (document.querySelector("#composer")||{}).value || "",
        pres: document.querySelectorAll("pre").length
      })`);
      throw new Error(e.message + " | " + dbg);
    }
    const val = await composerValue(page);
    assert(val.includes("[webcode:result]"), "нет маркера результата");
    assert(val.includes("tool: read"), "нет имени инструмента");
    return `${val.length} символов в поле ввода`;
  });

  await check("блок помечен как выполненный (без повторов)", async () => {
    const v = await page.eval(`document.querySelectorAll('pre[data-wc-done="1"]').length`);
    assert(v === 1, "ожидался 1 выполненный блок, найден " + v);
    return "1";
  });

  await check("мост: write-блок → файл в _fixes, исходник не тронут", async () => {
    await clearComposer(page);
    await simulate(page, { tool: "write", args: { path: "src/from-model.txt", content: "написано DeepSeek через мост" } });
    const stagedPath = path.join(TEST_ROOT, "_fixes", "src", "from-model.txt");
    const t0 = Date.now();
    let content = "";
    while (Date.now() - t0 < 15000) {
      try {
        content = await fsp.readFile(stagedPath, "utf8");
        if (content) break;
      } catch {}
      await sleep(200);
    }
    assert(content === "написано DeepSeek через мост", "нет файла в _fixes: " + JSON.stringify(content));
    assert(!fs.existsSync(path.join(TEST_ROOT, "src", "from-model.txt")), "исходник создан напрямую!");
    await waitFor(
      page,
      `((document.querySelector("#composer")||{}).value||"").includes("staged: _fixes/src/from-model.txt")`,
      15000,
      "результат write в поле ввода"
    );
    const val = await composerValue(page);
    assert(val.includes("staged: _fixes/src/from-model.txt"), "в результате нет пометки о песочнице: " + val.slice(0, 240));
    return "staged";
  });

  await check("панель: спрашивает подтверждение перед применением", async () => {
    await page.eval(`document.querySelector("#wc-apply").click()`);
    await waitFor(page, `!document.querySelector("#wc-confirm").hidden`, 10000, "блок подтверждения");
    const text = await page.eval(`document.querySelector("#wc-confirm").innerText`);
    assert(text.includes("src/from-model.txt"), "в подтверждении нет файла: " + text);
    await page.eval(`document.querySelector("#wc-confirm-no").click()`);
    await sleep(300);
    assert(!fs.existsSync(path.join(TEST_ROOT, "src", "from-model.txt")), "файл применён без подтверждения!");
    return "список файлов показан, отмена работает";
  });

  await check("мост: apply переносит правку в проект", async () => {
    const { body } = await api("apply", { path: "src/from-model.txt" });
    assert(body.ok && body.applied === 1, JSON.stringify(body));
    const text = await fsp.readFile(path.join(TEST_ROOT, "src", "from-model.txt"), "utf8");
    assert(text === "написано DeepSeek через мост", "файл не применён");
    return "применено";
  });

  await check("мост: обычный код без команд → файл в _fixes", async () => {
    const p = "src/captured.py";
    const content = "def hello():\n    return 'from plain code'\n";
    await page.eval(`window.__wcMock.code(${JSON.stringify(p)}, ${JSON.stringify(content)}, "python")`);
    const stagedPath = path.join(TEST_ROOT, "_fixes", "src", "captured.py");
    const t0 = Date.now();
    let text = "";
    while (Date.now() - t0 < 20000) {
      try {
        text = await fsp.readFile(stagedPath, "utf8");
        if (text) break;
      } catch {}
      await sleep(200);
    }
    assert(text.includes("from plain code"), "файл не захвачен: " + JSON.stringify(text));
    assert(!fs.existsSync(path.join(TEST_ROOT, "src", "captured.py")), "записано напрямую!");
    return "_fixes/src/captured.py";
  });

  await check("кнопка «Записать»: код без пути → указать файл → запись", async () => {
    await clearComposer(page);
    await page.eval(`window.__wcMock.plainCode("def manual():\\n    return 'manual write'\\n", "python")`);
    await sleep(500);
    await page.eval(`document.querySelector("#wc-write").click()`);
    await waitFor(page, `!document.querySelector("#wc-assign").hidden`, 5000, "форма записи");
    const title = await page.eval(`document.querySelector("#wc-assign .wc-confirm-title").textContent`);
    assert(/Pick a file/.test(title), "ожидалась форма выбора файла: " + title);
    await page.eval(`(() => {
      const i = document.querySelector("#wc-assign input");
      i.value = "src/manual_write.py";
      i.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await page.eval(`document.querySelector("#wc-assign-yes").click()`);
    const t0 = Date.now();
    let text = "";
    while (Date.now() - t0 < 15000) {
      try {
        text = await fsp.readFile(path.join(TEST_ROOT, "src", "manual_write.py"), "utf8");
        if (text) break;
      } catch {}
      await sleep(200);
    }
    assert(text.includes("manual write"), "файл не записан: " + JSON.stringify(text));
    return "src/manual_write.py";
  });

  await check("кнопка «Записать»: путь из ответа подставляется", async () => {
    await page.eval(`window.__wcMock.code("src/auto_path.py", "def auto():\\n    return 42\\n", "python")`);
    await sleep(600);
    await page.eval(`document.querySelector("#wc-write").click()`);
    await waitFor(page, `!document.querySelector("#wc-assign").hidden`, 5000, "форма записи");
    const val = await page.eval(`document.querySelector("#wc-assign input").value`);
    assert(val === "src/auto_path.py", "путь не подставлен: " + val);
    await page.eval(`document.querySelector("#wc-assign-yes").click()`);
    const t0 = Date.now();
    let text = "";
    while (Date.now() - t0 < 15000) {
      try {
        text = await fsp.readFile(path.join(TEST_ROOT, "src", "auto_path.py"), "utf8");
        if (text) break;
      } catch {}
      await sleep(200);
    }
    assert(text.includes("return 42"), "файл не записан: " + JSON.stringify(text));
    return "src/auto_path.py";
  });

  await check("дерево файлов: открывается и раскрывает папки", async () => {
    await page.eval(`document.querySelector("#wc-tree-btn").click()`);
    await waitFor(page, `document.querySelectorAll(".wc-tree-row").length > 0`, 10000, "дерево файлов");
    const hasSrc = await page.eval(`!!document.querySelector('.wc-tree-row[data-path="src"][data-type="dir"]')`);
    assert(hasSrc, "в дереве нет папки src");
    await page.eval(`document.querySelector('.wc-tree-row[data-path="src"]').click()`);
    await waitFor(page, `!!document.querySelector('.wc-tree-row[data-path="src/app.py"]')`, 10000, "содержимое src");
    return "src/app.py виден";
  });

  await check("drag&drop: код из чата в папку → файл", async () => {
    await page.eval(`window.__wcMock.code("src/dnd_source.py", "def dropped():\\n    return 'dnd ok'\\n", "python")`);
    await sleep(500);
    const dbg = await page.eval(`(() => {
      const pres = [...document.querySelectorAll("pre")].filter((p) => !p.closest("#wc-host"));
      const pre = pres[pres.length - 1];
      const dt = new DataTransfer();
      pre.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      const row = document.querySelector('.wc-tree-row[data-path="src"][data-type="dir"]');
      if (!row) return JSON.stringify({ row: false, pres: pres.length });
      row.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      row.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      return JSON.stringify({ row: true, types: [...dt.types], codeLen: (dt.getData("application/x-wc-code") || "").length });
    })()`);
    try {
      await waitFor(page, `!document.querySelector("#wc-assign").hidden`, 8000, "форма дропа");
    } catch (e) {
      const logText = await page.eval(`(document.querySelector("#wc-log")||{}).innerText || ""`);
      throw new Error(e.message + " | " + dbg + " | log: " + logText.slice(-200));
    }
    const name = await page.eval(`document.querySelector("#wc-drop-name").value`);
    assert(name === "dnd_source.py", "имя не подставлено: " + name);
    await page.eval(`(() => { document.querySelector("#wc-drop-name").value = "dropped.py"; return true; })()`);
    await page.eval(`document.querySelector("#wc-drop-yes").click()`);
    const t0 = Date.now();
    let text = "";
    while (Date.now() - t0 < 15000) {
      try {
        text = await fsp.readFile(path.join(TEST_ROOT, "src", "dropped.py"), "utf8");
        if (text) break;
      } catch {}
      await sleep(200);
    }
    assert(text.includes("dnd ok"), "файл не записан: " + JSON.stringify(text));
    return "src/dropped.py";
  });

  await check("дерево: ПКМ-меню и предпросмотр файла", async () => {
    await page.eval(`(() => {
      const r = document.querySelector('.wc-tree-row[data-path="hello.txt"]');
      const rect = r.getBoundingClientRect();
      r.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.top + 5 }));
      return true;
    })()`);
    await waitFor(page, `!!document.querySelector("#wc-menu")`, 5000, "контекстное меню");
    const items = await page.eval(`[...document.querySelectorAll(".wc-menu-item")].map((i) => i.textContent)`);
    assert(
      items.includes("Open in VS Code") && items.includes("Preview") && items.includes("Delete (to trash)"),
      "неполное меню: " + items.join(", ")
    );
    await page.eval(`(() => {
      [...document.querySelectorAll(".wc-menu-item")].find((i) => i.textContent === "Preview").click();
      return true;
    })()`);
    await waitFor(page, `!document.querySelector("#wc-preview").hidden`, 8000, "предпросмотр");
    const text = await page.eval(`document.querySelector("#wc-preview-body").textContent`);
    assert(text.includes("hello webcode"), "предпросмотр пуст: " + text.slice(0, 80));
    return "меню и предпросмотр ок";
  });

  await check("кнопка «Проверить»: скан проекта", async () => {
    await page.eval(`document.querySelector("#wc-check").click()`);
    await waitFor(page, `!!document.querySelector("#wc-menu")`, 5000, "меню проверок");
    const items = await page.eval(`[...document.querySelectorAll(".wc-menu-item")].map((i) => i.textContent)`);
    assert(items.includes("Scan project") && items.includes("Run tests"), "нет пунктов: " + items.join(", "));
    await page.eval(`(() => {
      [...document.querySelectorAll(".wc-menu-item")].find((i) => i.textContent === "Scan project").click();
      return true;
    })()`);
    await waitFor(page, `((document.querySelector("#wc-log")||{}).innerText||"").includes("scan:")`, 20000, "результат скана");
    return "scan ok";
  });

  await check("дерево: файл → в чат (модель видит код)", async () => {
    await clearComposer(page);
    await page.eval(`(() => {
      const r = document.querySelector('.wc-tree-row[data-path="hello.txt"]');
      const rect = r.getBoundingClientRect();
      r.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.top + 5 }));
      return true;
    })()`);
    await waitFor(page, `!!document.querySelector("#wc-menu")`, 5000, "меню");
    await page.eval(`(() => {
      [...document.querySelectorAll(".wc-menu-item")].find((i) => i.textContent === "Send to chat").click();
      return true;
    })()`);
    await waitFor(page, `((document.querySelector("#composer")||{}).value||"").includes("hello webcode")`, 8000, "файл в поле ввода");
    const val = await composerValue(page);
    assert(val.includes("File: hello.txt"), "нет заголовка файла: " + val.slice(0, 140));
    return "ok";
  });

  await check("мост: выход за root не выполняется", async () => {
    await clearComposer(page);
    await simulate(page, { tool: "read", args: { path: "../outside-secret.txt" } });
    await waitFor(page, `((document.querySelector("#composer")||{}).value||"").includes("ok: false")`, 20000, "ошибка в поле ввода");
    const val = await composerValue(page);
    assert(!val.includes("OUTSIDE SECRET"), "секрет всё-таки прочитан!");
    return "чтение отклонено шлюзом";
  });

  await check("мост: run-блок", async () => {
    await clearComposer(page);
    await simulate(page, { tool: "run", args: { command: "echo bridge-ok" } });
    await waitFor(page, `((document.querySelector("#composer")||{}).value||"").includes("bridge-ok")`, 20000, "stdout в поле ввода");
    return "stdout вернулся";
  });

  await check("скриншот панели", async () => {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(400);
    const box = await page.eval(`(() => {
      const r = document.querySelector("#wc-panel").getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), vh: innerHeight };
    })()`);
    console.log("       панель:", JSON.stringify(box));
    const data = await page.send("Page.captureScreenshot", { format: "png" });
    await fsp.writeFile(path.join(BASE, "screenshot.png"), Buffer.from(data.data, "base64"));
    return "screenshot.png";
  });

  await check("кнопка «Папка» создаёт _fixes и открывает её", async () => {
    const dir = path.join(TEST_ROOT, "_fixes");
    await fsp.rm(dir, { recursive: true, force: true });
    await page.eval(`document.querySelector("#wc-folder").click()`);
    await sleep(600);
    assert(fs.existsSync(dir), "папка _fixes не создана");
    const log = await page.eval(`document.querySelector("#wc-log").innerText`);
    assert(/opened _fixes/.test(log), "в логе нет подтверждения: " + log.slice(-200));
    return "ok";
  });

  await check("кнопка «Очистить» очищает лог", async () => {
    await page.eval(`document.querySelector("#wc-clear").click()`);
    await sleep(200);
    const len = await page.eval(`document.querySelector("#wc-log").textContent.length`);
    assert(len === 0, "лог не очистился, длина " + len);
    return "пусто";
  });

  await check("панель: закрепление справа и изменение ширины", async () => {
    await page.eval(`document.querySelector("#wc-dock").click()`);
    await sleep(300);
    const docked = await page.eval(`document.querySelector("#wc-host").classList.contains("wc-docked")`);
    assert(docked, "панель не закрепилась");
    const w1 = await page.eval(`Math.round(document.querySelector("#wc-host").getBoundingClientRect().width)`);
    assert(w1 >= 300, "ширина закреплённой панели мала: " + w1);
    const w2 = await page.eval(`(() => {
      const r = document.querySelector("#wc-resize");
      const rect = r.getBoundingClientRect();
      const x = rect.left + 3;
      const y = rect.top + 10;
      r.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x - 90, clientY: y }));
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x - 90, clientY: y }));
      return Math.round(document.querySelector("#wc-host").getBoundingClientRect().width);
    })()`);
    assert(w2 > w1 + 40, `ширина не изменилась: ${w1} -> ${w2}`);
    await page.eval(`document.querySelector("#wc-dock").click()`);
    await sleep(200);
    const undocked = await page.eval(`!document.querySelector("#wc-host").classList.contains("wc-docked")`);
    assert(undocked, "панель не открепилась");
    return `${w1} → ${w2}px`;
  });

  // ---- 3. автоотправка ----
  {
    if (mode === "extension") {
      const okSet2 = await setStorage({ port: PORT, token: TOKEN, autoSend: true, capture: true, noAutoExpand: false });
      assert(okSet2, "не удалось включить автоотправку");
    }
    const nt = await newTab(MOCK_URL);
    const page2 = await Cdp.open(nt.webSocketDebuggerUrl);
    await waitFor(page2, `document.readyState === "complete"`, 20000, "вторая вкладка");
    if (mode === "extension") {
      await waitFor(page2, `!!document.querySelector("#wc-host")`, 15000, "панель во второй вкладке");
    } else {
      await injectAll(page2, { autoSend: true });
    }
    await waitFor(page2, `document.documentElement.dataset.wcReady === "1"`, 20000, "снимок истории во второй вкладке");
    await markUserActivity(page2);
    await simulate(page2, { tool: "read", args: { path: "hello.txt" } });
    await waitFor(page2, `(document.querySelectorAll(".msg.user").length||0) > 1`, 25000, "автоотправленное сообщение");
    await check("автоотправка: результат реально отправлен в чат", async () => {
      const text = await page2.eval(`document.querySelector("#chat").innerText`);
      assert(text.includes("second line"), "в истории чата нет результата");
      const val = await page2.eval(`(document.querySelector("#composer")||{}).value || ""`);
      assert(val.trim() === "", "поле ввода не очистилось после отправки");
      return "сообщение в истории, поле пустое";
    });
    page2.close();
  }

  await check("переключение чата (SPA) не обрабатывает историю", async () => {
    await page.eval(`history.pushState({}, "", "?chat=2"); true`);
    await sleep(2200); // сброс снимка + ожидание тишины
    await simulate(page, { tool: "write", args: { path: "src/after_nav.txt", content: "nav" } });
    await sleep(2500);
    assert(
      !fs.existsSync(path.join(TEST_ROOT, "_fixes", "src", "after_nav.txt")),
      "после переключения чата блок выполнился без действия пользователя"
    );
    return "пропущено до первого ввода";
  });

  page.close();
}

// ------------------------------------------------------------- main ----
try {
  await main();
} catch (e) {
  record("фатальная ошибка", false, e && e.message ? e.message : String(e));
} finally {
  if (chromeProc) {
    try {
      spawn("taskkill", ["/pid", String(chromeProc.pid), "/t", "/f"], { windowsHide: true });
    } catch {}
    await sleep(1200);
  }
  if (gatewayProc) {
    try {
      gatewayProc.kill();
    } catch {}
  }
  await sleep(300);
  for (let i = 0; i < 5; i++) {
    try {
      await fsp.rm(PROFILE, { recursive: true, force: true });
      break;
    } catch {
      await sleep(500);
    }
  }
  await fsp.rm(path.join(BASE, ".test-nosandbox"), { recursive: true, force: true }).catch(() => {});
  await fsp.rm(TEST_CONFIG, { force: true }).catch(() => {});
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\nИТОГ: ${passed}/${results.length} проверок пройдено${failed ? `, провалено: ${failed}` : ""}\n`);
  process.exit(failed ? 1 : 0);
}
