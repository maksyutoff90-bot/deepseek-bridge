// Инструменты локального шлюза. Все пути резолвятся относительно корня проекта
// и не могут выйти за его пределы (включая симлинки/джанкшены).
//
// Режим песочницы (sandbox, включён по умолчанию): write/replace/capture не
// трогают исходники, а складывают результат в <root>/_fixes/<тот же путь>.
// Применить — инструментом apply (с резервной копией) или кнопкой в панели.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolError";
  }
}

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache",
  ".mypy_cache", ".ruff_cache", ".idea", "dist", "build", ".next", "wandb",
  "site-packages", ".cache", ".tox", "_fixes", "_hk", "logs", ".dsh-pro", "voices",
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024; // не индексируем файлы больше 2 МБ
const MAX_READ_BYTES = 400 * 1024;
const MAX_OUT = 32 * 1024;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function isInside(root, abs) {
  const rel = path.relative(root.toLowerCase(), abs.toLowerCase());
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function makeResolver(root) {
  const realRoot = fs.realpathSync.native ? fs.realpathSync.native(root) : fs.realpathSync(root);
  const resolve = (rel) => {
    const abs = path.resolve(realRoot, rel == null || rel === "" ? "." : String(rel));
    if (!isInside(realRoot, abs)) {
      throw new ToolError(`путь выходит за пределы проекта: ${rel}`);
    }
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(abs) : fs.realpathSync(abs);
      if (!isInside(realRoot, real)) {
        throw new ToolError(`путь ведёт за пределы проекта через ссылку: ${rel}`);
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    return abs;
  };
  return { resolve, root: realRoot };
}

function statKind(st) {
  if (st.isDirectory()) return "dir";
  if (st.isSymbolicLink()) return "link";
  return "file";
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function readTextFile(abs, maxBytes = MAX_FILE_BYTES) {
  const st = await fsp.stat(abs);
  if (!st.isFile()) throw new ToolError(`это не файл: ${abs}`);
  if (st.size > maxBytes) throw new ToolError(`файл слишком большой (${fmtSize(st.size)})`);
  const buf = await fsp.readFile(abs);
  if (buf.slice(0, 8192).includes(0)) throw new ToolError("похоже на бинарный файл");
  return buf.toString("utf8");
}

function clip(text, limit = MAX_OUT) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[обрезано, всего ${text.length} символов]`;
}

function clipTail(text, limit) {
  if (text.length <= limit) return text;
  return `…[начало обрезано]\n${text.slice(-limit)}`;
}

function walk(dir, opts = {}) {
  const { maxDepth = 8, maxFiles = 5000, onFile, onDir } = opts;
  let files = 0;
  const stack = [{ dir, depth: 0 }];
  while (stack.length) {
    const { dir: d, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => cmp(a.name, b.name));
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith("tmp")) continue;
        onDir?.(abs, e.name, depth);
        if (depth + 1 < maxDepth) stack.push({ dir: abs, depth: depth + 1 });
      } else if (e.isFile()) {
        if (++files > maxFiles) return { truncated: true, files };
        onFile?.(abs, e.name, depth);
      }
    }
  }
  return { truncated: false, files };
}

function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export function createTools(rootDir, config = {}) {
  const { resolve, root } = makeResolver(rootDir);
  const sandbox = config.sandbox !== false;
  const sandboxDir = String(config.sandboxDir || "_fixes").replace(/[\\/]+$/, "");
  const metaDir = path.join(root, sandboxDir, ".meta");
  const manifestPath = path.join(metaDir, "manifest.json");

  const relOf = (abs) => path.relative(root, abs).split(path.sep).join("/");
  const norm = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "");
  const isInsideSandbox = (rel) => {
    const r = norm(rel);
    return r === sandboxDir || r.startsWith(sandboxDir + "/");
  };

  // ---------------------------------------------------------- манифест ----
  let manifestChain = Promise.resolve();

  async function readManifest() {
    try {
      const m = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
      if (!Array.isArray(m.entries)) m.entries = [];
      return m;
    } catch {
      return { version: 1, entries: [] };
    }
  }
  async function writeManifest(m) {
    await fsp.mkdir(metaDir, { recursive: true });
    await fsp.writeFile(manifestPath, JSON.stringify(m, null, 2), "utf8");
  }
  function saveManifest(m) {
    const run = manifestChain.then(() => writeManifest(m));
    manifestChain = run.catch(() => {});
    return run;
  }
  function mutateManifest(fn) {
    const run = manifestChain.then(async () => {
      const m = await readManifest();
      await fn(m);
      await writeManifest(m);
      return m;
    });
    manifestChain = run.catch(() => {});
    return run;
  }
  async function latestEntries() {
    const m = await readManifest();
    const map = new Map();
    for (const e of m.entries) {
      if (e.appliedAt) continue; // уже перенесено в проект
      map.set(e.original, e);
    }
    return [...map.values()].sort((a, b) => a.original.localeCompare(b.original, "ru"));
  }

  // ------------------------------------------------------------ запись ----
  const countLines = (buf) => buf.toString("utf8").split(/\r?\n/).length;

  async function stageWrite(tool, abs, content, extra = {}) {
    const rel = relOf(abs);
    if (isInsideSandbox(rel)) {
      throw new ToolError(`нельзя писать в папку исправлений: ${rel}`);
    }
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
    const stagedAbs = path.join(root, sandboxDir, rel);
    await fsp.mkdir(path.dirname(stagedAbs), { recursive: true });

    let existed = false;
    let beforeLines = 0;
    try {
      if ((await fsp.stat(abs)).isFile()) {
        existed = true;
        beforeLines = countLines(await fsp.readFile(abs));
      }
    } catch {}

    await fsp.writeFile(stagedAbs, buf);
    const lines = countLines(buf);
    const entry = {
      at: new Date().toISOString(),
      tool,
      original: rel,
      staged: `${sandboxDir}/${rel}`,
      bytes: buf.length,
      lines,
      beforeLines,
      existed,
      appliedAt: null,
      ...extra,
    };
    await mutateManifest((m) => {
      m.entries.push(entry);
    });
    return {
      staged: true,
      path: entry.staged,
      original: rel,
      existed,
      lines,
      beforeLines,
      note: "исходный файл не изменён — изменение лежит в папке исправлений",
    };
  }

  // -------------------------------------------------------- инструменты ----
  const list = async ({ path: p = "." } = {}) => {
    const abs = resolve(p);
    const st = await fsp.stat(abs);
    if (!st.isDirectory()) {
      return { path: p, type: statKind(st), size: st.size, sizeHuman: fmtSize(st.size) };
    }
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return cmp(a.name.toLowerCase(), b.name.toLowerCase());
    });
    const out = [];
    for (const e of entries.slice(0, 500)) {
      const eAbs = path.join(abs, e.name);
      let size = 0;
      try {
        size = (await fsp.stat(eAbs)).size;
      } catch {}
      out.push({
        name: e.name,
        type: e.isDirectory() ? "dir" : "file",
        size,
        sizeHuman: e.isDirectory() ? "" : fmtSize(size),
      });
    }
    return { path: relOf(abs) || ".", count: entries.length, entries: out };
  };

  const tree = async ({ path: p = ".", depth = 2 } = {}) => {
    const abs = resolve(p);
    const lines = [relOf(abs) || "."];
    const maxDepth = Math.max(1, Math.min(5, Number(depth) || 2));
    const walkDir = (dir, prefix, d) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries = entries.filter((e) => !SKIP_DIRS.has(e.name));
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return cmp(a.name.toLowerCase(), b.name.toLowerCase());
      });
      entries.slice(0, 60).forEach((e, i) => {
        const last = i === Math.min(entries.length, 60) - 1;
        lines.push(`${prefix}${last ? "└─ " : "├─ "}${e.name}${e.isDirectory() ? "/" : ""}`);
        if (e.isDirectory() && d < maxDepth) {
          walkDir(path.join(dir, e.name), `${prefix}${last ? "   " : "│  "}`, d + 1);
        }
      });
      if (entries.length > 60) lines.push(`${prefix}… ещё ${entries.length - 60}`);
    };
    walkDir(abs, "", 1);
    return { tree: lines.join("\n") };
  };

  const read = async ({ path: p, startLine, endLine } = {}) => {
    if (!p) throw new ToolError("не указан path");
    const abs = resolve(p);
    const text = await readTextFile(abs);
    if (Buffer.byteLength(text) > MAX_READ_BYTES && !startLine) {
      throw new ToolError(`файл большой (${fmtSize(Buffer.byteLength(text))}); укажите startLine/endLine`);
    }
    const all = text.split(/\r?\n/);
    const from = Math.max(1, Number(startLine) || 1);
    const to = Math.min(all.length, Number(endLine) || all.length);
    if (from > to) throw new ToolError("startLine больше endLine");
    const width = String(to).length;
    const body = all
      .slice(from - 1, to)
      .map((line, i) => `${String(from + i).padStart(width, " ")}| ${line}`)
      .join("\n");
    return {
      path: relOf(abs),
      lines: all.length,
      shown: `${from}-${to}`,
      content: clip(body),
    };
  };

  const write = async ({ path: p, content, createDirs = true, direct = false } = {}) => {
    if (!p) throw new ToolError("не указан path");
    if (typeof content !== "string") throw new ToolError("content должен быть строкой");
    if (config.allowWrite === false) throw new ToolError("запись отключена в конфиге шлюза");
    const abs = resolve(p);
    if (sandbox && !direct) return stageWrite("write", abs, content, { source: "tool" });
    let backup = null;
    if (direct) {
      // Сохранение «как в редакторе»: файл перезаписывается сразу, со старой копией.
      try {
        const prev = await fsp.readFile(abs);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupAbs = path.join(metaDir, "backup", stamp, relOf(abs));
        await fsp.mkdir(path.dirname(backupAbs), { recursive: true });
        await fsp.writeFile(backupAbs, prev);
        backup = relOf(backupAbs);
      } catch {}
    }
    if (createDirs) await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, "utf8");
    const st = await fsp.stat(abs);
    return {
      staged: false,
      path: relOf(abs),
      bytes: st.size,
      lines: content.split(/\r?\n/).length,
      ...(backup ? { backup } : {}),
    };
  };

  const replace = async ({ path: p, old, new: neu, all = false } = {}) => {
    if (!p || typeof old !== "string" || typeof neu !== "string") {
      throw new ToolError("нужны path, old, new");
    }
    if (config.allowWrite === false) throw new ToolError("запись отключена в конфиге шлюза");
    const abs = resolve(p);
    const text = await readTextFile(abs);
    const count = text.split(old).length - 1;
    if (count === 0) throw new ToolError("фрагмент old не найден в файле");
    if (count > 1 && !all) {
      throw new ToolError(`old встречается ${count} раз(а); уточните фрагмент или передайте all:true`);
    }
    const next = all ? text.split(old).join(neu) : text.replace(old, neu);
    if (sandbox) return stageWrite("replace", abs, next, { source: "tool", replaced: all ? count : 1 });
    await fsp.writeFile(abs, next, "utf8");
    return { staged: false, path: relOf(abs), replaced: all ? count : 1, bytes: Buffer.byteLength(next) };
  };

  // Приём готового файла из ответа модели (без блоков webcode).
  const capture = async ({ path: p, content, source = "code-block" } = {}) => {
    if (!sandbox) throw new ToolError("захват кода работает только в режиме песочницы (sandbox: true)");
    if (!p) throw new ToolError("не указан path");
    if (typeof content !== "string" || !content.trim()) throw new ToolError("пустой content");
    const abs = resolve(p);
    return stageWrite("capture", abs, content, { source });
  };

  // Приём файла, перетащенного из проводника (base64, до 2 МБ).
  const upload = async ({ path: p, contentBase64 } = {}) => {
    if (!sandbox) throw new ToolError("загрузка файлов работает только в песочнице (sandbox: true)");
    if (!p) throw new ToolError("не указан path");
    if (typeof contentBase64 !== "string" || !contentBase64) throw new ToolError("пустой файл");
    const buf = Buffer.from(contentBase64, "base64");
    if (!buf.length) throw new ToolError("пустой файл");
    if (buf.length > 2 * 1024 * 1024) throw new ToolError(`файл больше 2 МБ (${fmtSize(buf.length)})`);
    const abs = resolve(p);
    return stageWrite("upload", abs, buf, { source: "drop" });
  };

  const staged = async () => {
    const entries = await latestEntries();
    return { dir: sandboxDir, count: entries.length, entries };
  };

  const apply = async ({ path: p, force = false } = {}) => {
    if (config.allowWrite === false) throw new ToolError("запись отключена в конфиге шлюза");
    const m = await readManifest();
    const map = new Map();
    for (const e of m.entries) {
      if (e.appliedAt) continue;
      map.set(e.original, e);
    }
    let targets = [...map.values()];
    if (p) {
      const want = norm(p);
      targets = targets.filter((e) => norm(e.original) === want);
      if (!targets.length) throw new ToolError(`нет сохранённых изменений для ${p}`);
    } else if (!targets.length) {
      throw new ToolError("нет сохранённых изменений");
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const files = [];
    const skipped = [];
    for (const e of targets) {
      const stagedAbs = path.join(root, e.staged);
      if (!fs.existsSync(stagedAbs)) continue;
      // Защита от «фрагмента»: короткий кусок кода не должен затирать большой файл.
      if (!force && e.existed && e.beforeLines > 10 && e.lines < e.beforeLines * 0.3) {
        skipped.push({ path: e.original, reason: "похоже на фрагмент", lines: e.lines, beforeLines: e.beforeLines });
        continue;
      }
      const targetAbs = resolve(e.original);
      let backup = null;
      if (fs.existsSync(targetAbs)) {
        backup = `${sandboxDir}/.meta/backup/${ts}/${e.original}`;
        const backupAbs = path.join(root, backup);
        await fsp.mkdir(path.dirname(backupAbs), { recursive: true });
        await fsp.copyFile(targetAbs, backupAbs);
      }
      await fsp.mkdir(path.dirname(targetAbs), { recursive: true });
      await fsp.copyFile(stagedAbs, targetAbs);
      e.appliedAt = new Date().toISOString();
      e.backup = backup;
      files.push({ path: e.original, backup, existed: Boolean(backup) });
    }
    await saveManifest(m);
    if (!files.length && !skipped.length) throw new ToolError("сохранённые файлы не найдены на диске");
    return { applied: files.length, files, skipped };
  };

  const reveal = async ({ path: p = sandboxDir } = {}) => {
    const abs = resolve(p);
    if (!fs.existsSync(abs)) {
      // Папку правок создаём на месте — иначе кнопка «Папка» падает,
      // пока не сделано ни одной правки.
      if (!isInsideSandbox(relOf(abs))) throw new ToolError(`папки ещё нет: ${relOf(abs)}`);
      await fsp.mkdir(abs, { recursive: true });
    }
    const dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    if (process.env.WC_NO_OPEN !== "1") {
      const cmd = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
      try {
        spawn(cmd, [dir], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      } catch (e) {
        throw new ToolError(`не удалось открыть папку: ${e.message}`);
      }
    }
    return { opened: relOf(dir) || "." };
  };

  // Запуск VS Code CLI (открыть файл/строку или diff).
  function launchCode(args) {
    if (process.env.WC_NO_OPEN === "1") return;
    const isWin = process.platform === "win32";
    const quoted = args.map((a) => `"${String(a).replace(/"/g, '""')}"`).join(" ");
    const child = spawn(isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh", isWin ? ["/d", "/s", "/c", `code ${quoted}`] : ["-lc", `code ${quoted}`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  }

  const open = async ({ path: p, line } = {}) => {
    if (!p) throw new ToolError("не указан path");
    const abs = resolve(p);
    if (!fs.existsSync(abs)) throw new ToolError(`файла нет: ${relOf(abs)}`);
    const target = line ? `${abs}:${Number(line)}` : abs;
    launchCode(["-g", target]);
    return { opened: relOf(abs), line: Number(line) || null };
  };

  const diff = async ({ path: p } = {}) => {
    if (!p) throw new ToolError("не указан path");
    const abs = resolve(p);
    const rel = relOf(abs);
    const stagedAbs = path.join(root, sandboxDir, rel);
    if (!fs.existsSync(stagedAbs)) {
      throw new ToolError(`нет сохранённой правки для ${rel} — сравнивать нечего`);
    }
    launchCode(["--diff", stagedAbs, abs]);
    return { original: rel, staged: `${sandboxDir}/${rel}` };
  };

  // Удаление — в корзину внутри _fixes, чтобы можно было вернуть.
  const remove = async ({ path: p, permanent = false } = {}) => {
    if (!p) throw new ToolError("не указан path");
    if (config.allowWrite === false) throw new ToolError("запись отключена в конфиге шлюза");
    const abs = resolve(p);
    const rel = relOf(abs);
    if (isInsideSandbox(rel)) throw new ToolError("нельзя удалять из папки исправлений");
    if (!fs.existsSync(abs)) throw new ToolError(`нет такого файла: ${rel}`);
    const st = fs.statSync(abs);
    if (permanent) {
      fs.rmSync(abs, { recursive: st.isDirectory(), force: true });
      return { removed: rel, permanent: true };
    }
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const trashRel = `${sandboxDir}/.meta/trash/${ts}/${rel}`;
    const trashAbs = path.join(root, trashRel);
    await fsp.mkdir(path.dirname(trashAbs), { recursive: true });
    await fsp.rename(abs, trashAbs);
    return { removed: rel, trashed: trashRel };
  };

  // Пользовательские действия из plugins.json в корне проекта.
  const plugins = async () => {
    const file = path.join(root, "plugins.json");
    let raw;
    try {
      raw = await fsp.readFile(file, "utf8");
    } catch {
      return { items: [], file: "plugins.json" };
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new ToolError(`plugins.json: некорректный JSON (${e.message})`);
    }
    const list = Array.isArray(data) ? data : Array.isArray(data.plugins) ? data.plugins : [];
    const items = list
      .filter((item) => item && typeof item === "object" && item.name && item.tool)
      .map((item) => ({
        name: String(item.name),
        tool: String(item.tool),
        args: item.args && typeof item.args === "object" ? item.args : {},
      }));
    return { items, file: "plugins.json" };
  };

  // Быстрый обзор проекта: сколько файлов, какие расширения, где TODO.
  const scan = async ({ path: p = ".", maxFiles = 1200 } = {}) => {
    const abs = resolve(p);
    const ext = {};
    const largest = [];
    let files = 0;
    let total = 0;
    let todos = 0;
    walk(abs, {
      maxFiles: Math.max(50, Math.min(5000, Number(maxFiles) || 1200)),
      onFile: (file) => {
        let st;
        try {
          st = fs.statSync(file);
        } catch {
          return;
        }
        files++;
        total += st.size;
        const e = (path.extname(file) || "(no ext)").toLowerCase();
        ext[e] = (ext[e] || 0) + 1;
        if (st.size > 20 * 1024) largest.push({ file: relOf(file), size: st.size });
        if (st.size < 256 * 1024) {
          try {
            const buf = fs.readFileSync(file);
            if (!buf.slice(0, 8192).includes(0)) {
              const m = buf.toString("utf8").match(/\b(TODO|FIXME|HACK)\b/g);
              if (m) todos += m.length;
            }
          } catch {}
        }
      },
    });
    largest.sort((a, b) => b.size - a.size);
    const byExt = Object.entries(ext)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, count]) => ({ name, count }));
    return { files, totalBytes: total, byExt, todos, largest: largest.slice(0, 5) };
  };

  // Прогон тестов: по умолчанию ищет run_tests.bat / pytest.
  const test = async ({ command, cwd = ".", timeoutMs } = {}) => {
    if (config.allowRun === false) throw new ToolError("выполнение команд отключено в конфиге шлюза");
    const absCwd = resolve(cwd);
    let cmd = command;
    if (!cmd) {
      if (fs.existsSync(path.join(absCwd, "run_tests.bat"))) cmd = "run_tests.bat";
      else if (
        fs.existsSync(path.join(absCwd, "pytest.ini")) ||
        fs.existsSync(path.join(absCwd, "pyproject.toml")) ||
        fs.existsSync(path.join(absCwd, "tests"))
      ) {
        cmd = "python -m pytest -x -q";
      } else {
        throw new ToolError("не нашёл, чем запускать тесты — передайте command");
      }
    }
    const r = await run({ command: cmd, cwd, timeoutMs: Math.max(10000, Math.min(600000, Number(timeoutMs) || 180000)) });
    const tail = `${r.stdout || ""}\n${r.stderr || ""}`.split(/\r?\n/).filter(Boolean).slice(-12).join("\n");
    return { command: cmd, code: r.code, timedOut: r.timedOut, durationMs: r.durationMs, tail };
  };

  const grep = async ({ pattern, path: p = ".", glob, ignoreCase = true, maxResults = 100 } = {}) => {
    if (!pattern) throw new ToolError("не указан pattern");
    let re;
    try {
      re = new RegExp(pattern, ignoreCase ? "i" : "");
    } catch (e) {
      throw new ToolError(`плохое регулярное выражение: ${e.message}`);
    }
    const abs = resolve(p);
    const fileRe = glob ? globToRegex(glob) : null;
    const hits = [];
    let scanned = 0;
    walk(abs, {
      onFile: (file) => {
        if (fileRe && !fileRe.test(path.basename(file))) return;
        scanned++;
        let buf;
        try {
          const st = fs.statSync(file);
          if (st.size > MAX_FILE_BYTES) return;
          buf = fs.readFileSync(file);
        } catch {
          return;
        }
        if (buf.slice(0, 8192).includes(0)) return;
        const lines = buf.toString("utf8").split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            hits.push({
              file: relOf(file),
              line: i + 1,
              text: lines[i].trim().slice(0, 300),
            });
            if (hits.length >= maxResults) return;
          }
        }
      },
    });
    return { matches: hits.length, scanned, truncated: hits.length >= maxResults, hits };
  };

  const run = async ({ command, cwd = ".", timeoutMs } = {}) => {
    if (config.allowRun === false) throw new ToolError("выполнение команд отключено в конфиге шлюза");
    if (!command || typeof command !== "string") throw new ToolError("не указан command");
    const absCwd = resolve(cwd);
    const limit = Math.max(1000, Math.min(180000, Number(timeoutMs) || config.runTimeoutMs || 30000));
    const isWin = process.platform === "win32";
    const child = spawn(
      isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh",
      isWin ? ["/d", "/s", "/c", command] : ["-lc", command],
      { cwd: absCwd, windowsHide: true, env: process.env }
    );
    let stdout = "";
    let stderr = "";
    const t0 = Date.now();
    const onData = (which) => (chunk) => {
      if (which === "out") stdout = clipTail(stdout + chunk.toString(), MAX_OUT);
      else stderr = clipTail(stderr + chunk.toString(), MAX_OUT);
    };
    child.stdout.on("data", onData("out"));
    child.stderr.on("data", onData("err"));

    const result = await new Promise((res) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (isWin) {
          spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }).on("error", () => child.kill());
        } else {
          child.kill("SIGKILL");
        }
      }, limit);
      child.on("error", (e) => {
        clearTimeout(timer);
        res({ code: -1, error: e.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        res({ code: code ?? -1, timedOut });
      });
    });
    return {
      command,
      cwd: relOf(absCwd) || ".",
      code: result.code,
      timedOut: result.timedOut || false,
      durationMs: Date.now() - t0,
      stdout: clipTail(stdout, MAX_OUT),
      stderr: clipTail(stderr, MAX_OUT),
      error: result.error,
    };
  };

  return { list, tree, read, write, replace, capture, upload, staged, apply, reveal, open, diff, remove, grep, run, scan, test, plugins };
}
