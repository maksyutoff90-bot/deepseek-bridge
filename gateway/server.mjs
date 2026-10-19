#!/usr/bin/env node
// Локальный HTTP-шлюз WebCode Bridge.
// Слушает 127.0.0.1, авторизует по токену, отдаёт инструменты из tools.mjs.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { createTools, ToolError } from "./tools.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOTDIR = path.join(HERE, "..");
const VERSION = "0.1.0";

// ---------- конфиг ----------
const argv = process.argv.slice(2);
const cli = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : def;
};
const configPath = path.resolve(cli("--config", path.join(HERE, "config.json")));
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (e) {
  if (e.code !== "ENOENT") {
    console.error(`не удалось прочитать ${configPath}: ${e.message}`);
    process.exit(1);
  }
}
const ROOTS_FILE = path.join(path.dirname(configPath), "roots.json");
let savedRoots = { root: "", roots: [] };
try {
  savedRoots = JSON.parse(fs.readFileSync(ROOTS_FILE, "utf8"));
} catch {}
let ROOT = path.resolve(cli("--root", cfg.root || savedRoots.root || process.cwd()));
if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
  console.error(`корень проекта не найден: ${ROOT}`);
  process.exit(1);
}
let KNOWN_ROOTS = Array.isArray(savedRoots.roots) ? savedRoots.roots.slice() : [];
if (!KNOWN_ROOTS.includes(ROOT)) KNOWN_ROOTS.unshift(ROOT);

function saveRoots() {
  try {
    fs.writeFileSync(ROOTS_FILE, JSON.stringify({ root: ROOT, roots: KNOWN_ROOTS }, null, 2));
  } catch {}
}
const PORT = Number(cli("--port", cfg.port || 8787));
const ALLOW_WRITE = cfg.allowWrite !== false;
const ALLOW_RUN = cfg.allowRun !== false;

let TOKEN = String(cfg.token || process.env.WEBCODE_TOKEN || "");
const TOKEN_FILE = path.join(HERE, ".token");
// Токен переживает перезапуск: берём сохранённый, иначе генерируем новый.
if (!TOKEN) {
  try {
    TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {}
}
if (!TOKEN) {
  TOKEN = crypto.randomBytes(20).toString("hex");
  fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
}

let tools = createTools(ROOT, cfg);
let TOOL_NAMES = Object.keys(tools);
const startedAt = new Date().toISOString();
const LOG_DIR = path.join(ROOTDIR, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "gateway.jsonl");

function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  // Папку логов могут удалить на ходу — пересоздаём при каждой записи.
  fs.mkdir(LOG_DIR, { recursive: true }, () => fs.appendFile(LOG_FILE, line + "\n", () => {}));
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-webcode-token",
  "Access-Control-Max-Age": "600",
};

function reply(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...CORS,
    ...extra,
  });
  res.end(body);
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("тело запроса слишком большое");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function pickFolder() {
  return new Promise((resolve) => {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
      '$d.Description = "WebCode: выберите рабочую папку"',
      "$d.ShowNewFolderButton = $true",
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath } else { "" }',
    ].join("\r\n");
    const file = path.join(LOG_DIR, "pick-folder.ps1");
    try {
      fs.writeFileSync(file, "\uFEFF" + script, "utf8");
    } catch {
      resolve("");
      return;
    }
    execFile(
      "powershell.exe",
      ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", file],
      { timeout: 180000 },
      (err, stdout) => {
        try {
          fs.unlinkSync(file);
        } catch {}
        resolve(err ? "" : String(stdout || "").trim());
      }
    );
  });
}

async function serveMock(req, res, urlPath) {
  const rel = urlPath.replace(/^\/webcode-mock\/?/, "") || "chat.html";
  const file = path.resolve(ROOTDIR, "mock", rel);
  const mockRoot = path.resolve(ROOTDIR, "mock");
  if (!file.toLowerCase().startsWith(mockRoot.toLowerCase())) return reply(res, 403, { ok: false, error: "forbidden" });
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
      ...CORS,
    });
    res.end(data);
  } catch {
    reply(res, 404, { ok: false, error: "not found" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return reply(res, 200, {
      ok: true,
      name: "webcode-gateway",
      version: VERSION,
      root: ROOT,
      sandbox: cfg.sandbox !== false,
      sandboxDir: cfg.sandbox !== false ? cfg.sandboxDir || "_fixes" : null,
      allowWrite: ALLOW_WRITE,
      allowRun: ALLOW_RUN,
      directWrite: cfg.directWrite === true,
      tools: TOOL_NAMES,
      pid: process.pid,
      startedAt,
    });
  }

  // Автонастройка расширения: токен отдаётся только по специальному заголовку.
  // Обычные сайты такой запрос отправить не могут (preflight не разрешён).
  if (req.method === "GET" && url.pathname === "/token") {
    // Заголовок обязателен: сайт не сможет его отправить (preflight не разрешает),
    // поэтому CORS-заголовки здесь безопасны и нужны Firefox-расширениям.
    const origin = String(req.headers.origin || "");
    const fromExtension =
      origin.startsWith("moz-extension://") || origin.startsWith("chrome-extension://");
    if (req.headers["x-webcode-setup"] !== "1" && !fromExtension) {
      return reply(res, 403, { ok: false, error: "forbidden" });
    }
    log({ event: "token_issued", ip: req.socket.remoteAddress, origin: origin || null });
    return reply(res, 200, { ok: true, token: TOKEN });
  }

  // Список проектов и переключение рабочей папки (только с токеном).
  if (req.method === "GET" && url.pathname === "/roots") {
    const token = req.headers["x-webcode-token"] || "";
    if (!safeEqual(String(token), TOKEN)) return reply(res, 401, { ok: false, error: "неверный токен" });
    const roots = [ROOT, ...KNOWN_ROOTS.filter((r) => r !== ROOT && fs.existsSync(r))];
    return reply(res, 200, { ok: true, root: ROOT, roots });
  }

  if (req.method === "POST" && url.pathname === "/mode") {
    const token = req.headers["x-webcode-token"] || "";
    if (!safeEqual(String(token), TOKEN)) return reply(res, 401, { ok: false, error: "неверный токен" });
    let msg;
    try {
      msg = JSON.parse(await readBody(req));
    } catch (e) {
      return reply(res, 400, { ok: false, error: `некорректный JSON: ${e.message}` });
    }
    cfg.directWrite = msg.direct === true;
    saveRoots();
    log({ event: "mode", directWrite: cfg.directWrite });
    return reply(res, 200, { ok: true, directWrite: cfg.directWrite });
  }

  if (req.method === "POST" && url.pathname === "/pick-folder") {
    const token = req.headers["x-webcode-token"] || "";
    if (!safeEqual(String(token), TOKEN)) return reply(res, 401, { ok: false, error: "неверный токен" });
    const picked = await pickFolder();
    return reply(res, 200, { ok: true, path: picked });
  }

  if (req.method === "POST" && url.pathname === "/root") {
    const token = req.headers["x-webcode-token"] || "";
    if (!safeEqual(String(token), TOKEN)) return reply(res, 401, { ok: false, error: "неверный токен" });
    let msg;
    try {
      msg = JSON.parse(await readBody(req));
    } catch (e) {
      return reply(res, 400, { ok: false, error: `некорректный JSON: ${e.message}` });
    }
    const raw = String(msg.path || "").trim();
    if (!raw) return reply(res, 400, { ok: false, error: "не указана папка" });
    const target = path.resolve(path.isAbsolute(raw) ? raw : path.join(ROOT, raw));
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      return reply(res, 400, { ok: false, error: `папка не найдена: ${target}` });
    }
    if (!stat.isDirectory()) return reply(res, 400, { ok: false, error: `это не папка: ${target}` });
    ROOT = target;
    tools = createTools(ROOT, cfg);
    TOOL_NAMES = Object.keys(tools);
    KNOWN_ROOTS = [ROOT, ...KNOWN_ROOTS.filter((r) => path.resolve(r) !== ROOT)].slice(0, 12);
    saveRoots();
    log({ event: "root_changed", root: ROOT });
    return reply(res, 200, { ok: true, root: ROOT, roots: KNOWN_ROOTS });
  }

  if (req.method === "POST" && url.pathname === "/exec") {
    let msg;
    try {
      msg = JSON.parse(await readBody(req));
    } catch (e) {
      return reply(res, 400, { ok: false, error: `некорректный JSON: ${e.message}` });
    }
    const token = req.headers["x-webcode-token"] || msg.token;
    if (!safeEqual(String(token || ""), TOKEN)) {
      log({ event: "auth_failed", ip: req.socket.remoteAddress });
      return reply(res, 401, { ok: false, error: "неверный токен" });
    }
    const tool = String(msg.tool || "");
    const args = msg.args && typeof msg.args === "object" ? msg.args : {};
    if (!TOOL_NAMES.includes(tool)) {
      return reply(res, 400, { ok: false, error: `неизвестный инструмент: ${tool}`, tools: TOOL_NAMES });
    }
    const t0 = Date.now();
    try {
      const out = await tools[tool](args);
      log({ event: "exec", tool, args: summarizeArgs(args), ok: true, ms: Date.now() - t0 });
      return reply(res, 200, { ok: true, tool, ms: Date.now() - t0, ...out });
    } catch (e) {
      const isTool = e instanceof ToolError;
      log({
        event: "exec",
        tool,
        args: summarizeArgs(args),
        ok: false,
        ms: Date.now() - t0,
        error: e.message,
      });
      return reply(res, isTool ? 400 : 500, {
        ok: false,
        tool,
        error: e.message,
        ...(isTool ? {} : { stack: process.env.WEBCODE_DEBUG ? e.stack : undefined }),
      });
    }
  }

  if (req.method === "GET" && (url.pathname === "/webcode-mock" || url.pathname.startsWith("/webcode-mock/"))) {
    if (cfg.mock === false) return reply(res, 404, { ok: false, error: "not found" });
    return serveMock(req, res, url.pathname);
  }

  return reply(res, 404, { ok: false, error: `не найдено: ${req.method} ${url.pathname}` });
});

function summarizeArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" && v.length > 120 ? `${v.slice(0, 120)}…(${v.length})` : v;
  }
  return out;
}

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`Порт ${PORT} занят. Укажите другой: --port 8788`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("");
  console.log("  WebCode gateway " + VERSION);
  console.log("  корень : " + ROOT);
  console.log("  адрес  : http://127.0.0.1:" + PORT);
  console.log("  токен  : " + TOKEN);
  console.log("  токен сохранён в " + TOKEN_FILE);
  console.log("  запись : " + (ALLOW_WRITE ? "разрешена" : "запрещена") + ", команды: " + (ALLOW_RUN ? "разрешены" : "запрещены"));
  console.log(
    "  правки : " +
      (cfg.sandbox !== false
        ? `в папку ${ROOT}\\${cfg.sandboxDir || "_fixes"} (исходники не меняются)`
        : "напрямую в проект")
  );
  console.log("");
  console.log("  Ctrl+C — остановить.");
  console.log("");
  log({ event: "start", port: PORT, root: ROOT, pid: process.pid });
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log({ event: "stop", pid: process.pid });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
