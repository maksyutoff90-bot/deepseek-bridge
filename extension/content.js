// WebCode Bridge — content script.
// Два режима работы:
//   1) блок ```webcode с JSON  → выполнить инструменты шлюза;
//   2) обычный ответ с кодом   → сохранить файл в папку исправлений (_fixes),
//      если рядом с блоком указан путь (заголовок, подпись или комментарий).
// Исходники в песочнице не меняются: применить можно кнопкой «Применить».
(() => {
  "use strict";
  if (window.__webcodeBridgeLoaded) return;
  window.__webcodeBridgeLoaded = true;
  // Запасной вариант, если i18n.js не загрузился (например, при ручной инъекции).
  window.__wcI18n = window.__wcI18n || {
    tr: (s) => s,
    apply: () => {},
    setLang: () => {},
    lang: "en",
  };

  const VERSION = "0.2.0";
  const STABLE_MS = 1200;      // блок должен не меняться столько времени (стриминг)
  const RESULT_LIMIT = 6000;   // сколько символов результата отдаём модели
  const MAX_BLOCK_CHARS = 60000;
  const MIN_CAPTURE_CHARS = 30;

  const state = {
    pending: "",
    busy: false,
    queue: [],
    stagedCount: 0,
    baseCount: 0,
    baselineReady: false,
    userTouched: false,
  };

  // ---------------------------------------------------------------- UI ----
  const host = document.createElement("div");
  host.id = "wc-host";
  host.innerHTML = `
    <div class="wc-resize" id="wc-resize" title="Потяните, чтобы изменить ширину"></div>
    <div class="wc-panel wc-collapsed" id="wc-panel">
      <div class="wc-head" id="wc-head">
        <span class="wc-dot" id="wc-dot"></span>
        <span class="wc-name">WebCode</span>
        <span class="wc-count" id="wc-count" hidden>0</span>
        <span class="wc-spacer"></span>
        <button class="wc-icon" id="wc-dock" title="Закрепить справа">⇥</button>
        <button class="wc-icon" id="wc-min" title="Развернуть">+</button>
      </div>
      <div class="wc-body">
        <div class="wc-log" id="wc-log"></div>
        <div class="wc-actions">
          <button class="wc-btn" id="wc-send">Отправить</button>
          <button class="wc-btn" id="wc-write" title="Записать код из последнего ответа в файлы">Записать</button>
          <button class="wc-btn wc-ghost" id="wc-apply" title="Перенести файлы из _fixes в проект">Применить</button>
          <button class="wc-btn wc-ghost" id="wc-folder" title="Открыть папку исправлений">Папка</button>
          <button class="wc-btn wc-ghost" id="wc-tree-btn" title="Файлы проекта и перетаскивание">Файлы</button>
          <button class="wc-btn wc-ghost" id="wc-check" title="Сканировать проект и запустить тесты">Проверить</button>
          <button class="wc-btn wc-ghost" id="wc-clear" title="Очистить лог">Очистить</button>
          <button class="wc-btn wc-ghost" id="wc-opts" title="Настройки">⚙</button>
        </div>
        <div class="wc-confirm" id="wc-confirm" hidden></div>
        <div class="wc-assign" id="wc-assign" hidden></div>
        <div class="wc-tree" id="wc-tree" hidden>
          <div class="wc-tree-head">
            <span id="wc-tree-root">проект</span>
            <span class="wc-spacer"></span>
            <button class="wc-icon" id="wc-tree-reload" title="Обновить">⟳</button>
            <button class="wc-icon" id="wc-tree-close" title="Закрыть">×</button>
          </div>
          <div class="wc-tree-body" id="wc-tree-body"></div>
          <div class="wc-tree-hint">ПКМ по файлу — меню · перетащите код из чата в папку</div>
        </div>
        <div class="wc-preview" id="wc-preview" hidden>
          <div class="wc-preview-head">
            <span id="wc-preview-title"></span>
            <span class="wc-spacer"></span>
            <button class="wc-icon" id="wc-preview-open" title="Открыть в VS Code">↗</button>
            <button class="wc-icon" id="wc-preview-close" title="Закрыть">×</button>
          </div>
          <pre class="wc-preview-body" id="wc-preview-body"></pre>
        </div>
        <div class="wc-foot" id="wc-foot">ожидание блока webcode</div>
      </div>
    </div>`;
  (document.body || document.documentElement).appendChild(host);
  window.__wcI18n.setLang("en", host);

  const $ = (id) => host.querySelector("#" + id);
  const panel = $("wc-panel");
  const logEl = $("wc-log");
  const dotEl = $("wc-dot");
  const countEl = $("wc-count");
  const footEl = $("wc-foot");
  const sendBtn = $("wc-send");
  const minBtn = $("wc-min");
  const dockBtn = $("wc-dock");
  const resizeEl = $("wc-resize");
  const treeEl = $("wc-tree");
  const treeBody = $("wc-tree-body");

  const W_KEY = "wc:width";
  const D_KEY = "wc:dock";

  function applyDock(on, persist = true) {
    host.classList.toggle("wc-docked", on);
    dockBtn.textContent = on ? "⇤" : "⇥";
    dockBtn.title = on ? "Открепить" : "Закрепить справа";
    let saved = 0;
    try {
      saved = Number(localStorage.getItem(W_KEY)) || 0;
    } catch {}
    const w = Math.min(Math.max(280, saved || (on ? 420 : 380)), Math.max(320, window.innerWidth - 40));
    host.style.width = `${w}px`;
    if (persist) {
      try {
        localStorage.setItem(D_KEY, on ? "1" : "0");
      } catch {}
    }
  }

  dockBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    applyDock(!host.classList.contains("wc-docked"));
  });

  resizeEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = host.getBoundingClientRect().width;
    const move = (ev) => {
      const w = Math.min(Math.max(260, startW + (startX - ev.clientX)), window.innerWidth - 40);
      host.style.width = `${w}px`;
    };
    const up = () => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      try {
        localStorage.setItem(W_KEY, String(Math.round(host.getBoundingClientRect().width)));
      } catch {}
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
  });

  try {
    applyDock(localStorage.getItem(D_KEY) === "1", false);
  } catch {}

  function log(text, kind = "info") {
    const line = document.createElement("div");
    line.className = "wc-line wc-" + kind;
    const t = new Date().toLocaleTimeString();
    const timeEl = document.createElement("span");
    timeEl.textContent = `${t}  `;
    const msgEl = document.createElement("span");
    msgEl.textContent = text; // перевод делает apply(), чтобы работало переключение
    line.append(timeEl, msgEl);
    logEl.appendChild(line);
    while (logEl.childElementCount > 80) logEl.firstElementChild.remove();
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setDot(kind, title) {
    dotEl.className = "wc-dot" + (kind ? " wc-" + kind : "");
    dotEl.title = title || "";
  }

  function expand() {
    panel.classList.remove("wc-collapsed");
    minBtn.textContent = "–";
  }
  function toggle() {
    const collapsed = panel.classList.toggle("wc-collapsed");
    minBtn.textContent = collapsed ? "+" : "–";
  }

  function updateBadge() {
    if (state.stagedCount > 0) {
      countEl.hidden = false;
      countEl.textContent = String(state.stagedCount);
      countEl.title = `${state.stagedCount} файл(ов) в папке исправлений`;
    } else {
      countEl.hidden = true;
    }
  }

  function updateSend() {
    sendBtn.disabled = false;
    footEl.textContent = state.pending ? "результат готов — нажмите «Отправить»" : "ожидание блока webcode";
  }

  $("wc-head").addEventListener("click", toggle);
  minBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });
  $("wc-opts").addEventListener("click", (e) => {
    e.stopPropagation();
    try {
      chrome.runtime.sendMessage({ type: "openOptions" });
    } catch {}
  });
  $("wc-apply").addEventListener("click", (e) => {
    e.stopPropagation();
    applyAll();
  });
  $("wc-clear").addEventListener("click", (e) => {
    e.stopPropagation();
    logEl.textContent = "";
  });
  $("wc-check").addEventListener("click", (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(r.left, r.top - 6, [
      { label: "Сканировать проект", action: runScan },
      { label: "Запустить тесты", action: runTests },
    ]);
  });
  $("wc-write").addEventListener("click", (e) => {
    e.stopPropagation();
    openWriteForm();
  });
  $("wc-tree-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleTree();
  });
  $("wc-tree-close").addEventListener("click", (e) => {
    e.stopPropagation();
    treeEl.hidden = true;
  });
  $("wc-tree-reload").addEventListener("click", (e) => {
    e.stopPropagation();
    fillTree();
  });
  $("wc-preview-close").addEventListener("click", (e) => {
    e.stopPropagation();
    $("wc-preview").hidden = true;
  });
  $("wc-preview-open").addEventListener("click", (e) => {
    e.stopPropagation();
    if (previewPath) openInEditor(previewPath);
  });
  $("wc-folder").addEventListener("click", (e) => {
    e.stopPropagation();
    openFolder();
  });
  sendBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    sendPending();
  });

  // ------------------------------------------------------------ конфиг ----
  // Читаем каждый раз: смена порта/токена не требует перезагрузки вкладки.
  async function getCfg() {
    const def = { port: 8787, token: "", autoSend: false, capture: true, noAutoExpand: false, lang: "en" };
    try {
      const r = await chrome.runtime.sendMessage({ type: "config" });
      return { ...def, ...(r || {}) };
    } catch {
      return def;
    }
  }

  async function exec(tool, args) {
    const r = await chrome.runtime.sendMessage({ type: "exec", payload: { tool, args } });
    if (!r) throw new Error("service worker не ответил");
    return r;
  }

  let pingState = null;
  async function ping() {
    try {
      const cfg = await getCfg();
      const r = await chrome.runtime.sendMessage({ type: "ping" });
      if (r && r.ok) {
        setDot("ok", `шлюз ${r.root || ""}`);
        if (!state.pending) footEl.textContent = `шлюз: ${r.root || "127.0.0.1:" + cfg.port}`;
        if (pingState !== true) log(`шлюз на связи: ${r.root || ""}`, "ok");
        pingState = true;
      } else {
        setDot("err", (r && r.error) || "нет связи");
        if (pingState !== false) log(`нет связи со шлюзом: ${(r && r.error) || "?"}`, "err");
        pingState = false;
      }
    } catch (e) {
      setDot("err", String(e));
      pingState = false;
    }
  }

  async function refreshStaged() {
    try {
      const r = await exec("staged", {});
      if (r && r.ok) {
        state.stagedCount = r.count || 0;
        updateBadge();
      }
    } catch {}
  }

  async function applyAll() {
    // Сначала показываем, что именно будет изменено, и ждём подтверждения.
    let r;
    try {
      r = await exec("staged", {});
    } catch (e) {
      log(`✗ ${e}`, "err");
      return;
    }
    if (!r || !r.ok) {
      log(`✗ ${(r && r.error) || "?"}`, "err");
      return;
    }
    if (!r.count) {
      log("нет сохранённых правок", "dim");
      return;
    }
    showConfirm(r.entries);
  }

  function showConfirm(entries) {
    const box = $("wc-confirm");
    box.textContent = "";
    const title = document.createElement("div");
    title.className = "wc-confirm-title";
    title.textContent = `Изменить ${entries.length} файл(ов) в проекте?`;
    box.appendChild(title);

    const list = document.createElement("div");
    list.className = "wc-confirm-list";
    for (const e of entries.slice(0, 10)) {
      const row = document.createElement("div");
      row.className = "wc-confirm-item";
      const stat = e.existed ? `${e.beforeLines} → ${e.lines} стр.` : `новый, ${e.lines} стр.`;
      row.textContent = `${e.original}  (${stat})`;
      list.appendChild(row);
    }
    if (entries.length > 10) {
      const more = document.createElement("div");
      more.className = "wc-confirm-item";
      more.textContent = `… ещё ${entries.length - 10}`;
      list.appendChild(more);
    }
    box.appendChild(list);

    const actions = document.createElement("div");
    actions.className = "wc-confirm-actions";
    const yes = document.createElement("button");
    yes.className = "wc-btn";
    yes.id = "wc-confirm-yes";
    yes.textContent = "Применить";
    yes.addEventListener("click", async () => {
      box.hidden = true;
      await doApply();
    });
    const no = document.createElement("button");
    no.className = "wc-btn wc-ghost";
    no.id = "wc-confirm-no";
    no.textContent = "Отмена";
    no.addEventListener("click", () => {
      box.hidden = true;
      log("применение отменено", "dim");
    });
    actions.append(yes, no);
    box.appendChild(actions);
    box.hidden = false;
    expand();
  }

  async function doApply() {
    try {
      const r = await exec("apply", {});
      if (r && r.ok) {
        log(`✓ применено файлов: ${r.applied}`, "ok");
        if (r.skipped && r.skipped.length) {
          log(`⚠ пропущено (похоже на фрагмент): ${r.skipped.map((s) => s.path).join(", ")}`, "warn");
        }
      } else {
        log(`✗ применить: ${(r && r.error) || "?"}`, "err");
      }
      await refreshStaged();
    } catch (e) {
      log(`✗ применить: ${e}`, "err");
    }
  }

  // ------------------------------------------- запись кода из ответа ----
  // Ручной сценарий: модель написала код → «Записать» → подтверждение →
  // файлы перезаписываются в проекте (с бэкапом).
  function lastBlocks() {
    const msgs = [...document.querySelectorAll(".ds-markdown")];
    const md = msgs[msgs.length - 1];
    if (!md) return [];
    const out = [];
    for (const pre of md.querySelectorAll("pre")) {
      const text = pre.textContent || "";
      if (text.trim().length < 20) continue;
      if (looksLikeWebcode(pre, text)) continue;
      out.push({ text, guess: detectFilePath(pre, md, text) || "" });
    }
    return out;
  }

  function openWriteForm() {
    const blocks = lastBlocks();
    if (!blocks.length) {
      log("в последнем ответе нет кода для записи", "dim");
      return;
    }
    renderWrite(blocks);
  }

  function renderWrite(blocks) {
    const box = $("wc-assign");
    box.textContent = "";
    const guessed = blocks.every((b) => b.guess);
    const title = document.createElement("div");
    title.className = "wc-confirm-title";
    title.textContent = guessed
      ? `Перезаписать ${blocks.length === 1 ? "файл" : `${blocks.length} файла(ов)`} в проекте?`
      : "Укажите файл для каждого блока:";
    box.appendChild(title);

    const list = document.createElement("div");
    list.className = "wc-assign-list";
    const inputs = [];
    blocks.slice(0, 6).forEach((b) => {
      const row = document.createElement("div");
      row.className = "wc-assign-row";
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "wc-assign-input";
      inp.placeholder = "путь, напр. englishrus/utils.py";
      inp.value = b.guess || "";
      inp.spellcheck = false;
      inputs.push(inp);
      const prev = document.createElement("div");
      prev.className = "wc-assign-prev";
      const first = b.text.trim().split(/\r?\n/)[0].slice(0, 48);
      prev.textContent = `${b.text.trim().split(/\r?\n/).length} стр. · ${first}`;
      row.appendChild(inp);
      row.appendChild(prev);
      list.appendChild(row);
    });
    box.appendChild(list);

    const actions = document.createElement("div");
    actions.className = "wc-confirm-actions";
    const yes = document.createElement("button");
    yes.className = "wc-btn";
    yes.id = "wc-assign-yes";
    yes.textContent = "Записать";
    yes.addEventListener("click", () => runWrite(blocks, inputs, box));
    const no = document.createElement("button");
    no.className = "wc-btn wc-ghost";
    no.id = "wc-assign-no";
    no.textContent = "Отмена";
    no.addEventListener("click", () => {
      box.hidden = true;
    });
    actions.append(yes, no);
    box.appendChild(actions);
    box.hidden = false;
    expand();
  }

  async function runWrite(blocks, inputs, box) {
    const items = [];
    for (let i = 0; i < blocks.length && i < inputs.length; i++) {
      const p = cleanPath(inputs[i].value.trim());
      if (!p) {
        log(`✗ блок ${i + 1}: укажите путь вида englishrus/utils.py`, "err");
        return;
      }
      items.push({ path: p, content: blocks[i].text });
    }
    box.hidden = true;
    let ok = 0;
    let skipped = 0;
    for (const it of items) {
      try {
        const c = await exec("capture", { path: it.path, content: it.content, source: "manual" });
        if (!c || !c.ok) {
          log(`✗ ${it.path}: ${(c && c.error) || "?"}`, "err");
          continue;
        }
        const a = await exec("apply", { path: it.path });
        if (a && a.ok && a.applied) {
          ok++;
          log(`✓ записано: ${it.path}${a.files && a.files[0] && a.files[0].backup ? " (бэкап есть)" : ""}`, "ok");
        } else if (a && a.ok && a.skipped && a.skipped.length) {
          skipped++;
          log(`⚠ ${it.path}: похоже на фрагмент — пропущено`, "warn");
        } else {
          log(`✗ ${it.path}: ${(a && a.error) || "?"}`, "err");
        }
      } catch (e) {
        log(`✗ ${it.path}: ${e}`, "err");
      }
    }
    await refreshStaged();
    footEl.textContent = `записано: ${ok}${skipped ? `, пропущено: ${skipped}` : ""}`;
  }

  async function openFolder() {
    try {
      const r = await exec("reveal", {});
      if (r && r.ok) log(`открыл ${r.opened}`, "dim");
      else log(`✗ папка: ${(r && r.error) || "?"}`, "err");
    } catch (e) {
      log(String(e), "err");
    }
  }

  // ------------------------------------------------------- файлы проекта ----
  let dragCode = null;

  async function toggleTree() {
    if (!treeEl.hidden) {
      treeEl.hidden = true;
      return;
    }
    treeEl.hidden = false;
    expand();
    if (!treeBody.childElementCount) await fillTree();
  }

  function treeRow(entry, depth, parent) {
    const row = document.createElement("div");
    row.className = "wc-tree-row";
    row.dataset.path = parent ? `${parent}/${entry.name}` : entry.name;
    row.dataset.type = entry.type;
    row.dataset.depth = String(depth);
    row.style.paddingLeft = `${6 + depth * 12}px`;
    row.textContent = `${entry.type === "dir" ? "📁" : "📄"} ${entry.name}`;
    row.title = row.dataset.path;
    if (entry.type === "file") row.draggable = true;
    return row;
  }

  async function listDir(path) {
    try {
      const r = await exec("list", { path });
      if (r && r.ok) return r.entries || [];
      log(`✗ ${path}: ${(r && r.error) || "?"}`, "err");
    } catch (e) {
      log(`✗ ${path}: ${e}`, "err");
    }
    return [];
  }

  const TREE_SKIP = new Set(["_fixes", ".git", "node_modules", "__pycache__", ".venv", ".pytest_cache", "dist", "build"]);

  async function renderDir(path, depth, parent) {
    const entries = (await listDir(path)).filter((e) => !TREE_SKIP.has(e.name));
    const sorted = [...entries].sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1
    );
    const frag = document.createDocumentFragment();
    for (const e of sorted.slice(0, 300)) frag.appendChild(treeRow(e, depth, parent));
    return frag;
  }

  async function fillTree() {
    treeBody.textContent = "";
    treeBody.appendChild(await renderDir(".", 0, ""));
  }

  treeBody.addEventListener("click", async (e) => {
    const row = e.target.closest(".wc-tree-row");
    if (!row || row.dataset.type !== "dir") return;
    const depth = Number(row.dataset.depth);
    if (row.dataset.loaded === "1") {
      let n = row.nextElementSibling;
      while (n && Number(n.dataset.depth) > depth) {
        const next = n.nextElementSibling;
        n.remove();
        n = next;
      }
      row.dataset.loaded = "0";
      row.textContent = row.textContent.replace("📂", "📁");
      return;
    }
    row.dataset.loaded = "1";
    row.textContent = row.textContent.replace("📁", "📂");
    const parent = row.dataset.path === "." ? "" : row.dataset.path;
    row.after(await renderDir(row.dataset.path, depth + 1, parent));
  });

  treeBody.addEventListener("dragstart", (e) => {
    const row = e.target.closest?.(".wc-tree-row[data-type='file']");
    if (!row) return;
    e.dataTransfer.setData("text/plain", "wc-file:" + row.dataset.path);
    e.dataTransfer.effectAllowed = "copy";
  });

  const dirOf = (e) => e.target.closest?.(".wc-tree-row[data-type='dir']");

  treeBody.addEventListener("dragover", (e) => {
    const row = dirOf(e);
    if (!row) return;
    const types = [...(e.dataTransfer ? e.dataTransfer.types : [])];
    if (!types.includes("application/x-wc-code") && !types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    row.classList.add("wc-drop");
  });

  treeBody.addEventListener("dragleave", (e) => {
    const row = dirOf(e);
    if (row) row.classList.remove("wc-drop");
  });

  treeBody.addEventListener("drop", async (e) => {
    const row = dirOf(e);
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove("wc-drop");
    const dir = row.dataset.path;
    let code = "";
    try {
      code = e.dataTransfer.getData("application/x-wc-code") || "";
    } catch {}
    if (code) {
      openDropForm(dir, code);
      return;
    }
    for (const f of [...(e.dataTransfer.files || [])]) await uploadDropped(dir, f);
  });

  // ---------------------------------------------------- контекстное меню ----
  let previewPath = "";

  function closeMenu() {
    const m = $("wc-menu");
    if (m) m.remove();
  }

  function showMenu(x, y, items) {
    closeMenu();
    const menu = document.createElement("div");
    menu.className = "wc-menu";
    menu.id = "wc-menu";
    for (const it of items) {
      if (it.sep) {
        const s = document.createElement("div");
        s.className = "wc-menu-sep";
        menu.appendChild(s);
        continue;
      }
      const row = document.createElement("div");
      row.className = "wc-menu-item";
      row.textContent = it.label;
      row.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeMenu();
        Promise.resolve(it.action()).catch((e) => log(String(e), "err"));
      });
      menu.appendChild(row);
    }
    host.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
  }

  document.addEventListener(
    "click",
    (e) => {
      if (e.target && e.target.closest && e.target.closest("#wc-menu")) return;
      closeMenu();
    },
    true
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") {
        closeMenu();
        treeEl.hidden = true;
      }
    },
    true
  );

  treeBody.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".wc-tree-row");
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    const p = row.dataset.path;
    if (row.dataset.type === "dir") {
      showMenu(e.clientX, e.clientY, [
        { label: "Открыть папку", action: () => openFolderPath(p) },
        { label: "Скопировать путь", action: () => copyPath(p) },
      ]);
      return;
    }
    showMenu(e.clientX, e.clientY, [
      { label: "Открыть в VS Code", action: () => openInEditor(p) },
      { label: "Показать diff", action: () => showDiff(p) },
      { label: "Прочитать", action: () => openPreview(p) },
      { label: "Отправить в чат", action: () => sendFileToChat(p) },
      { sep: true },
      { label: "Скопировать путь", action: () => copyPath(p) },
      { label: "Удалить (в корзину)", action: () => removeFile(p) },
    ]);
  });

  async function openInEditor(path) {
    const r = await exec("open", { path });
    if (r && r.ok) log(`открыл в VS Code: ${path}`, "dim");
    else log(`✗ открыть: ${(r && r.error) || "?"}`, "err");
  }

  async function showDiff(path) {
    const r = await exec("diff", { path });
    if (r && r.ok) log(`diff: ${r.original} (VS Code)`, "dim");
    else log(`✗ diff: ${(r && r.error) || "?"}`, "err");
  }

  async function copyPath(path) {
    try {
      await navigator.clipboard.writeText(path);
      log(`скопировано: ${path}`, "dim");
    } catch {
      fillComposer(path);
      log("буфер недоступен — путь вставлен в поле ввода", "warn");
    }
  }

  async function removeFile(path) {
    const r = await exec("remove", { path });
    if (r && r.ok) {
      log(`в корзину: ${r.removed}`, "ok");
      await fillTree();
    } else {
      log(`✗ удалить: ${(r && r.error) || "?"}`, "err");
    }
  }

  async function openFolderPath(path) {
    const r = await exec("reveal", { path });
    if (r && r.ok) log(`открыл ${r.opened}`, "dim");
    else log(`✗ папка: ${(r && r.error) || "?"}`, "err");
  }

  async function openPreview(path) {
    previewPath = path;
    const r = await exec("read", { path, startLine: 1, endLine: 80 });
    if (!r || !r.ok) {
      log(`✗ ${path}: ${(r && r.error) || "?"}`, "err");
      return;
    }
    $("wc-preview-title").textContent = `${path} · ${r.lines} стр.`;
    $("wc-preview-body").textContent = r.content;
    $("wc-preview").hidden = false;
    expand();
  }

  // Локальные проверки без модели: обзор проекта и тесты.
  async function runScan() {
    log("сканирую проект…", "dim");
    const r = await exec("scan", {});
    if (!r || !r.ok) {
      log(`✗ скан: ${(r && r.error) || "?"}`, "err");
      return;
    }
    const mb = (r.totalBytes / 1024 / 1024).toFixed(1);
    log(`скан: ${r.files} файлов, ${mb} МБ`, "ok");
    if (r.byExt && r.byExt.length) log(`расширения: ${r.byExt.map((e) => `${e.name} ${e.count}`).join(", ")}`, "dim");
    if (r.todos) log(`TODO/FIXME/HACK: ${r.todos}`, "warn");
    if (r.largest && r.largest.length) {
      log(`крупнейшие: ${r.largest.map((f) => `${f.file} (${Math.round(f.size / 1024)} КБ)`).join(", ")}`, "dim");
    }
  }

  async function runTests() {
    log("запускаю тесты…", "dim");
    const r = await exec("test", {});
    if (!r || !r.ok) {
      log(`✗ тесты: ${(r && r.error) || "?"}`, "err");
      return;
    }
    log(`тесты: код ${r.code}${r.timedOut ? " (таймаут)" : ""}, ${(r.durationMs / 1000).toFixed(1)} с`, r.code === 0 ? "ok" : "err");
    if (r.tail) {
      for (const line of String(r.tail).split("\n").slice(-8)) log(line, r.code === 0 ? "dim" : "err");
    }
  }

  // Отправить содержимое файла в поле ввода чата (модель сразу видит код).
  async function sendFileToChat(path) {
    const r = await exec("read", { path });
    if (!r || !r.ok) {
      log(`✗ ${path}: ${(r && r.error) || "?"}`, "err");
      return;
    }
    const raw = String(r.content || "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\d+\| /, ""))
      .join("\n");
    const cut = raw.length > 20000 ? `${raw.slice(0, 20000)}\n…[truncated]` : raw;
    const lang = (path.split(".").pop() || "").toLowerCase();
    const block = `File: ${path}\n\`\`\`${lang}\n${cut}\n\`\`\``;
    const ta = composer();
    if (!ta) {
      state.pending = block;
      updateSend();
      log("не нашёл поле ввода — текст сохранён в панели", "warn");
      return;
    }
    const text = ta.value ? `${ta.value.replace(/\s+$/, "")}\n\n${block}` : block;
    fillComposer(text);
    log(`отправил в чат: ${path}`, "ok");
  }

  // Код из чата можно тащить: помечаем все <pre> перетаскиваемыми.
  function markDraggable() {
    for (const pre of document.querySelectorAll("pre")) if (!pre.draggable) pre.draggable = true;
  }

  document.addEventListener(
    "dragstart",
    (e) => {
      const pre = e.target && e.target.closest ? e.target.closest("pre") : null;
      if (!pre || host.contains(pre)) return;
      const text = pre.textContent || "";
      if (text.trim().length < 10) return;
      const md = pre.closest(".ds-markdown");
      const guess = md ? detectFilePath(pre, md, text) || "" : "";
      dragCode = { text, guess };
      try {
        e.dataTransfer.setData("application/x-wc-code", text);
        e.dataTransfer.setData("text/plain", text.slice(0, 200));
        e.dataTransfer.effectAllowed = "copyMove";
      } catch {}
    },
    true
  );

  // Файл из дерева можно перетащить в поле ввода — вставится путь.
  document.addEventListener(
    "drop",
    (e) => {
      if (host.contains(e.target)) return;
      let data = "";
      try {
        data = e.dataTransfer.getData("text/plain") || "";
      } catch {}
      if (!data.startsWith("wc-file:")) return;
      e.preventDefault();
      const ta = composer();
      if (!ta) return;
      const p = data.slice(8);
      fillComposer(ta.value ? `${ta.value.replace(/\s+$/, "")} ${p}` : p);
    },
    true
  );

  function openDropForm(dir, code) {
    const box = $("wc-assign");
    box.textContent = "";
    const base = dragCode && dragCode.guess ? dragCode.guess.split("/").pop() : "";
    const title = document.createElement("div");
    title.className = "wc-confirm-title";
    title.textContent = `Записать в ${dir === "." ? "корень проекта" : dir + "/"}:`;
    box.appendChild(title);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "wc-assign-input";
    input.id = "wc-drop-name";
    input.placeholder = "имя файла, напр. utils.py";
    input.value = base;
    input.spellcheck = false;
    box.appendChild(input);

    const prev = document.createElement("div");
    prev.className = "wc-assign-prev";
    prev.textContent = `${code.trim().split(/\r?\n/).length} стр. · ${code.trim().split(/\r?\n/)[0].slice(0, 48)}`;
    box.appendChild(prev);

    const actions = document.createElement("div");
    actions.className = "wc-confirm-actions";
    const yes = document.createElement("button");
    yes.className = "wc-btn";
    yes.id = "wc-drop-yes";
    yes.textContent = "Записать";
    yes.addEventListener("click", async () => {
      const name = input.value.trim().replace(/^\/+/, "");
      if (!name || !/^[\w.@-]+$/.test(name)) {
        log("✗ укажите имя файла без папок", "err");
        return;
      }
      const p = dir === "." ? name : `${dir}/${name}`;
      box.hidden = true;
      await writeOne(p, code);
      await fillTree();
    });
    const no = document.createElement("button");
    no.className = "wc-btn wc-ghost";
    no.id = "wc-drop-no";
    no.textContent = "Отмена";
    no.addEventListener("click", () => {
      box.hidden = true;
    });
    actions.append(yes, no);
    box.appendChild(actions);
    box.hidden = false;
    expand();
  }

  async function writeOne(path, code) {
    try {
      const c = await exec("capture", { path, content: code, source: "drop" });
      if (!c || !c.ok) {
        log(`✗ ${path}: ${(c && c.error) || "?"}`, "err");
        return;
      }
      const a = await exec("apply", { path });
      if (a && a.ok && a.applied) log(`✓ записано: ${path}`, "ok");
      else if (a && a.ok && a.skipped && a.skipped.length) log(`⚠ ${path}: похоже на фрагмент — пропущено`, "warn");
      else log(`✗ ${path}: ${(a && a.error) || "?"}`, "err");
      await refreshStaged();
    } catch (e) {
      log(`✗ ${path}: ${e}`, "err");
    }
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || "").split(",")[1] || "");
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(file);
    });
  }

  async function uploadDropped(dir, file) {
    const p = dir === "." ? file.name : `${dir}/${file.name}`;
    if (file.size > 2 * 1024 * 1024) {
      log(`✗ ${file.name}: больше 2 МБ`, "err");
      return;
    }
    try {
      const b64 = await fileToBase64(file);
      const r = await exec("upload", { path: p, contentBase64: b64 });
      if (!r || !r.ok) {
        log(`✗ ${file.name}: ${(r && r.error) || "?"}`, "err");
        return;
      }
      const a = await exec("apply", { path: p });
      if (a && a.ok && a.applied) log(`✓ записано: ${p}`, "ok");
      else log(`✗ ${p}: ${(a && a.error) || "?"}`, "err");
      await refreshStaged();
    } catch (e) {
      log(`✗ ${file.name}: ${e}`, "err");
    }
  }

  // ------------------------------------------------------- разбор блока ----
  const ALIASES = {
    read_file: "read",
    write_file: "write",
    list_dir: "list",
    list_files: "list",
    search: "grep",
    bash: "run",
    shell: "run",
    exec: "run",
    edit: "replace",
  };

  function matchBracket(text, start) {
    const open = text[start];
    const close = open === "{" ? "}" : open === "[" ? "]" : null;
    if (!close) return -1;
    let depth = 0;
    let inStr = false;
    let quote = "";
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === quote) inStr = false;
        continue;
      }
      if (ch === '"') {
        inStr = true;
        quote = ch;
        continue;
      }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function parseCalls(raw) {
    const text = String(raw || "");
    let start = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "{" || text[i] === "[") {
        start = i;
        break;
      }
    }
    if (start < 0) return null;
    const end = matchBracket(text, start);
    if (end < 0) return null;
    let data;
    try {
      data = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
    const list = Array.isArray(data) ? data : [data];
    if (!list.length) return null;
    const calls = [];
    for (const item of list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const rawTool = String(item.tool || item.name || "").toLowerCase().trim();
      if (!rawTool) return null;
      const args = item.args || item.input || item.arguments || {};
      if (typeof args !== "object" || Array.isArray(args)) return null;
      calls.push({ tool: ALIASES[rawTool] || rawTool, args });
    }
    return calls;
  }

  function looksLikeWebcode(pre, text) {
    if (text.length > MAX_BLOCK_CHARS) return false;
    const code = pre.querySelector("code");
    const cls = (code && code.className) || "";
    if (/(^|\s)(language-)?webcode(\s|$)/i.test(cls)) return true;
    const block = pre.closest('[class*="code-block"]') || pre.parentElement;
    const head = block ? String(block.innerText || "").slice(0, 80) : "";
    if (/webcode/i.test(head)) return true;
    return /^\s*`{0,3}\s*webcode\b/i.test(text);
  }

  // ----------------------------------------------- захват файла из ответа ----
  const FILE_EXT =
    "py|pyi|js|mjs|cjs|ts|tsx|jsx|json|jsonc|md|markdown|txt|toml|cfg|ini|yaml|yml|html|htm|css|scss|less|sql|bat|cmd|ps1|sh|bash|rs|go|java|cc|cpp|hpp|cs|rb|php|lua|vue|svelte|xml|gradle";
  const FILE_RE = new RegExp(`((?:[\\w.@-]+[\\\\/])*[\\w.@-]+\\.(?:${FILE_EXT}))(?![\\w])`, "gi");

  const LANG_EXT = {
    python: ["py", "pyi"],
    javascript: ["js", "mjs", "cjs", "jsx"],
    typescript: ["ts", "tsx"],
    json: ["json", "jsonc"],
    html: ["html", "htm"],
    css: ["css", "scss", "less"],
    bash: ["sh", "bash", "ps1", "bat", "cmd"],
    shell: ["sh", "bash"],
    powershell: ["ps1"],
    markdown: ["md", "markdown"],
    md: ["md"],
    yaml: ["yml", "yaml"],
    toml: ["toml"],
    sql: ["sql"],
    rust: ["rs"],
    go: ["go"],
    java: ["java"],
    c: ["c", "h"],
    cpp: ["cpp", "cc", "hpp"],
    csharp: ["cs"],
    ruby: ["rb"],
    php: ["php"],
    lua: ["lua"],
    vue: ["vue"],
    svelte: ["svelte"],
    xml: ["xml"],
    ini: ["ini", "cfg"],
  };

  function lastPathToken(text) {
    if (!text) return null;
    const re = new RegExp(FILE_RE.source, "gi");
    let m;
    let last = null;
    while ((m = re.exec(text))) {
      last = m[1];
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    return last;
  }

  function cleanPath(p) {
    const s = String(p).replace(/\\/g, "/").trim().replace(/^\.\//, "");
    if (!s || s.length < 3 || s.length > 150) return null;
    if (s.includes("..") || s.startsWith("/") || /^[a-z]:/i.test(s)) return null;
    if (/\s/.test(s) || s.includes("://")) return null;
    return s;
  }

  function langMatches(lang, p) {
    if (!lang) return true;
    const allowed = LANG_EXT[String(lang).toLowerCase()];
    if (!allowed) return true; // text/plain и прочее — не ограничиваем
    const ext = (p.split(".").pop() || "").toLowerCase();
    return allowed.includes(ext);
  }

  function detectFilePath(pre, md, text) {
    const code = pre.querySelector("code");
    const lang = ((code && code.className.match(/language-([\w+-]+)/)) || [])[1] || "";
    let before = "";
    try {
      const idx = md.innerText.indexOf(text.slice(0, 30));
      if (idx > 0) before = md.innerText.slice(Math.max(0, idx - 400), idx);
    } catch {}
    const firstLines = text.split(/\r?\n/).slice(0, 2).join("\n");
    const banner =
      (pre.closest('[class*="code-block"]') || {}).querySelector?.('[class*="banner"]')?.textContent || "";
    for (const candidate of [before, firstLines, banner]) {
      const raw = lastPathToken(candidate);
      const p = raw && cleanPath(raw);
      if (p && langMatches(lang, p)) return p;
    }
    return null;
  }

  const capturedHashes = new Set();

  async function captureBlock(pre) {
    const cfg = await getCfg();
    if (cfg.capture === false) return;
    const md = pre.closest(".ds-markdown");
    if (!md) return; // только ответы ассистента
    const code = pre.querySelector("code") || pre;
    const text = code.textContent || "";
    if (text.trim().length < MIN_CAPTURE_CHARS || text.length > 200000) return;
    const p = detectFilePath(pre, md, text);
    if (!p) return;
    const hash = p + "\u0000" + text.length + "\u0000" + text.slice(0, 300);
    if (capturedHashes.has(hash)) return;
    capturedHashes.add(hash);
    try {
      const r = await exec("capture", { path: p, content: text, source: "code-block" });
      if (r && r.ok) {
        state.stagedCount += 1;
        updateBadge();
        log(`📥 ${p} → ${r.path}`, "ok");
        expand();
      } else {
        log(`✗ захват ${p}: ${(r && r.error) || "?"}`, "err");
      }
    } catch (e) {
      log(`✗ захват ${p}: ${e}`, "err");
    }
  }

  // ---------------------------------------------------------- исполнение ----
  function previewArgs(args) {
    const keys = Object.keys(args);
    if (!keys.length) return "";
    const first = keys[0];
    const v = args[first];
    return typeof v === "string" ? `${first}=${v.slice(0, 60)}` : first;
  }

  function truncate(s, n) {
    s = String(s);
    return s.length <= n ? s : s.slice(0, n) + `\n…[обрезано, всего ${s.length} символов]`;
  }

  function pickOutput(res) {
    const clean = { ...res };
    delete clean.ok;
    delete clean.tool;
    delete clean.ms;
    if (typeof clean.content === "string") {
      return `path: ${clean.path}\nlines: ${clean.lines} (${clean.shown})\n${clean.content}`;
    }
    if (typeof clean.tree === "string") return clean.tree;
    if (Array.isArray(clean.entries)) {
      return clean.entries
        .map((e) => `${e.type === "dir" ? "d" : "f"} ${String(e.sizeHuman || "").padStart(8)}  ${e.name}`)
        .join("\n");
    }
    if (Array.isArray(clean.hits)) {
      if (!clean.hits.length) return "(совпадений нет)";
      return clean.hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n");
    }
    if (typeof clean.stdout === "string") {
      return [
        `$ ${clean.command}`,
        `exit: ${clean.code}${clean.timedOut ? " (таймаут)" : ""}`,
        clean.stdout,
        clean.stderr ? `[stderr]\n${clean.stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    if (clean.staged === true) {
      return [
        `staged: ${clean.path}`,
        `original: ${clean.original} (не изменён)`,
        `lines: ${clean.lines}${clean.beforeLines ? `, было: ${clean.beforeLines}` : ""}`,
        clean.note ? `note: ${clean.note}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    if (Array.isArray(clean.files)) {
      return clean.files.map((f) => `applied: ${f.path}${f.backup ? ` (бэкап: ${f.backup})` : ""}`).join("\n");
    }
    if (typeof clean.path === "string" && clean.bytes != null) {
      return `path: ${clean.path}\nbytes: ${clean.bytes}${
        clean.replaced != null ? `\nreplaced: ${clean.replaced}` : ""
      }`;
    }
    return JSON.stringify(clean, null, 2);
  }

  function formatResult(call, res) {
    const ok = res && res.ok === true;
    const lines = ["[webcode:result]", `tool: ${call.tool}`, `ok: ${ok ? "true" : "false"}`];
    if (ok) {
      lines.push("output:");
      lines.push(truncate(pickOutput(res), RESULT_LIMIT));
    } else {
      lines.push(`error: ${truncate((res && res.error) || "неизвестная ошибка", 2000)}`);
    }
    lines.push("[/webcode:result]");
    return lines.join("\n");
  }

  async function runJob(job) {
    const parts = [];
    for (const call of job.calls) {
      setDot("busy", "выполняю " + call.tool);
      log(`→ ${call.tool} ${previewArgs(call.args)}`, "dim");
      let res;
      try {
        res = await exec(call.tool, call.args);
      } catch (e) {
        res = { ok: false, error: String((e && e.message) || e) };
      }
      const ok = res && res.ok === true;
      if (ok) {
        if (res.staged) {
          log(`📥 ${res.original} → ${res.path}`, "ok");
          await refreshStaged();
        } else {
          log(`✓ ${call.tool} (${res.ms != null ? res.ms + " мс" : "ok"})`, "ok");
        }
      } else {
        log(`✗ ${call.tool}: ${(res && res.error) || "ошибка"}`, "err");
      }
      parts.push(formatResult(call, res));
    }
    job.pre.dataset.wcDone = "1";
    const chunk = parts.join("\n\n");
    const cfg = await getCfg();
    if (cfg.noAutoExpand !== true) expand();
    setDot("ok", "готово");
    await deliver(chunk, cfg);
  }

  async function pump() {
    if (state.busy) return;
    state.busy = true;
    try {
      while (state.queue.length) {
        const job = state.queue.shift();
        try {
          await runJob(job);
        } catch (e) {
          log(`сбой обработки блока: ${(e && e.message) || e}`, "err");
        }
      }
    } finally {
      state.busy = false;
    }
  }

  // ------------------------------------------------------- поле ввода ----
  function composer() {
    const areas = [...document.querySelectorAll("textarea")].filter((t) => {
      const r = t.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && t.getClientRects().length > 0;
    });
    if (!areas.length) return null;
    const byPlaceholder = areas.find((t) => /сообщ|message|send|deepseek|prompt/i.test(t.placeholder || ""));
    return byPlaceholder || areas[areas.length - 1];
  }

  function fillComposer(text) {
    const ta = composer();
    if (!ta) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    if (setter) setter.call(ta, text);
    else ta.value = text;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new Event("change", { bubbles: true }));
    ta.focus();
    try {
      ta.setSelectionRange(ta.value.length, ta.value.length);
    } catch {}
    return ta;
  }

  function pressEnter(ta) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      const ev = new KeyboardEvent(type, {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      });
      ta.dispatchEvent(ev);
    }
  }

  async function deliver(chunk, cfg) {
    const ta = composer();
    if (!ta) {
      state.pending = chunk;
      updateSend();
      log("не нашёл поле ввода — текст сохранён в панели", "warn");
      try {
        await navigator.clipboard.writeText(chunk);
      } catch {}
      return;
    }
    const draft = ta.value.trim();
    const text =
      draft && !draft.includes("[webcode:result]") ? `${ta.value.replace(/\s+$/, "")}\n\n${chunk}` : chunk;
    const out =
      window.__wcI18n.lang === "en"
        ? text.split("\n").map((line) => window.__wcI18n.tr(line)).join("\n")
        : text;
    fillComposer(out);
    state.pending = "";
    updateSend();
    log(`вставлено в поле ввода (${text.length} символов)`, "ok");
    if (cfg.autoSend) {
      await new Promise((r) => setTimeout(r, 300));
      pressEnter(ta);
      await new Promise((r) => setTimeout(r, 1200));
      if (ta.value.trim() === "") {
        log("отправлено автоматически", "ok");
        setDot("ok", "отправлено");
      } else {
        log("автоотправка не сработала — нажмите Enter в поле ввода", "warn");
        setDot("busy", "нужна отправка вручную");
      }
    } else {
      setDot("busy", "ждёт отправки");
      footEl.textContent = "результат в поле ввода — проверьте и нажмите Enter";
    }
  }

  async function sendPending() {
    if (state.pending) {
      await deliver(state.pending, await getCfg());
      return;
    }
    const ta = composer();
    if (ta) pressEnter(ta);
  }

  // ----------------------------------------------------- наблюдение DOM ----
  const seen = new WeakMap();
  const executedHashes = new Set();
  let settleTimer = 0;
  const startedAt = Date.now();

  // DeepSeek — SPA: история чата дорисовывается уже после старта скрипта.
  // Поэтому «снимок» берём не сразу, а когда страница успокоилась; всё, что
  // отрисовано до этого момента, считается историей и не обрабатывается.
  function armSettle(delay = 3000) {
    if (state.baselineReady) return;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(maybeBaseline, delay);
  }

  function maybeBaseline() {
    if (state.baselineReady) return;
    const hasMessages = document.querySelectorAll(".ds-markdown").length > 0;
    // Пустой чат — тоже валидный случай, но ждём его не бесконечно.
    if (!hasMessages && Date.now() - startedAt < 12000) {
      armSettle(1000);
      return;
    }
    finalizeBaseline();
  }

  function finalizeBaseline() {
    if (state.baselineReady) return;
    state.baselineReady = true;
    state.baseCount = document.querySelectorAll(".ds-markdown").length;
    document.querySelectorAll("pre").forEach((pre) => {
      if (!seen.has(pre)) seen.set(pre, { text: "", since: Date.now(), done: true, webcode: false });
    });
    try {
      document.documentElement.dataset.wcReady = "1";
    } catch {}
    log(`история: ${state.baseCount} сообщений — слежу только за новыми`, "dim");
    markDraggable();
  }

  function scan() {
    if (!state.baselineReady) return;
    const now = Date.now();
    const msgs = [...document.querySelectorAll(".ds-markdown")];

    // Пока пользователь ничего не делал в этом чате, всё отрисованное —
    // история (в том числе дорисованная после переключения вкладки).
    if (!state.userTouched) {
      msgs.forEach((md) =>
        md.querySelectorAll("pre").forEach((pre) => {
          if (!seen.has(pre)) seen.set(pre, { text: "", since: now, done: true, webcode: false });
        })
      );
      state.baseCount = Math.max(state.baseCount, msgs.length);
      return;
    }

    for (const pre of document.querySelectorAll("pre")) {
      if (host.contains(pre)) continue;
      const md = pre.closest(".ds-markdown");
      const idx = md ? msgs.indexOf(md) : -1;
      if (idx >= 0 && idx < state.baseCount) continue; // это история чата

      const text = pre.textContent || "";
      if (text.length < 8) continue;

      let rec = seen.get(pre);
      if (!rec) {
        const webcode = looksLikeWebcode(pre, text) && !!parseCalls(text);
        seen.set(pre, { text, since: now, done: false, webcode });
        continue; // ждём стабилизации текста (стриминг)
      }
      if (rec.done) continue;
      if (rec.text !== text) {
        rec.text = text;
        rec.since = now;
        continue;
      }
      if (now - rec.since < STABLE_MS) continue;
      rec.done = true;

      if (rec.webcode) {
        const calls = parseCalls(rec.text);
        if (!calls) continue;
        const key = rec.text.trim().slice(0, 2000);
        if (executedHashes.has(key)) continue; // защита от повторной отрисовки
        executedHashes.add(key);
        state.queue.push({ pre, calls });
        pump();
      } else {
        captureBlock(pre);
      }
    }
    markDraggable();
  }

  let timer = 0;
  const observer = new MutationObserver((muts) => {
    if (muts.some((m) => host.contains(m.target))) window.__wcI18n.apply(host);
    if (muts.every((m) => host.contains(m.target))) return; // наши же строки лога
    clearTimeout(timer);
    timer = setTimeout(scan, 350);
    armSettle();
  });

  function resetForNewChat() {
    clearTimeout(settleTimer);
    state.baselineReady = false;
    state.baseCount = 0;
    state.userTouched = false;
    try {
      delete document.documentElement.dataset.wcReady;
    } catch {}
    log("другой чат — снова жду вашего сообщения", "dim");
    armSettle(1500);
  }

  function start() {
    // Первое действие пользователя (ввод в чат) отделяет историю от новой работы.
    for (const ev of ["keydown", "input", "paste"]) {
      document.addEventListener(ev, () => { state.userTouched = true; }, true);
    }
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    setInterval(scan, 3000);
    updateSend();
    updateBadge();
    refreshStaged();
    ping();
    setInterval(ping, 20000);
    log(`WebCode Bridge ${VERSION}: правки сохраняются в _fixes`, "dim");
    // Смена языка в настройках применяется без перезагрузки вкладки.
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.lang) {
          window.__wcI18n.setLang(changes.lang.newValue === "ru" ? "ru" : "en", host);
        }
      });
    } catch {}
    getCfg().then((cfg) => window.__wcI18n.setLang(cfg.lang || "en", host));
    // Публичное API для интеграций: qutebrowser (:jseval --world main), консоль.
    const wcApi = {
      toggle() {
        const head = $("wc-head");
        if (head) head.click();
        return "panel";
      },
      open() {
        const panel = $("wc-panel");
        if (panel && panel.classList.contains("wc-collapsed")) $("wc-head").click();
        return "panel";
      },
      scan() {
        runScan();
        return "scan started";
      },
      tests() {
        runTests();
        return "tests started";
      },
      apply() {
        applyAll();
        return "apply";
      },
      tree() {
        $("wc-tree-btn").click();
        return "tree";
      },
      toChat(path) {
        sendFileToChat(String(path || ""));
        return "to chat: " + path;
      },
      send() {
        $("wc-send").click();
        return "send";
      },
      clear() {
        $("wc-clear").click();
        return "cleared";
      },
      log(text) {
        log(String(text), "dim");
        return "ok";
      },
    };
    // В qutebrowser window изолирован обёрткой GM, поэтому вешаем ещё на DOM.
    try {
      window.__wc = wcApi;
    } catch {}
    try {
      if (typeof unsafeWindow !== "undefined") unsafeWindow.__wc = wcApi;
    } catch {}
    try {
      document.documentElement.__wc = wcApi;
    } catch {}
    armSettle();
    // Переключение чатов в сайдбаре — SPA-навигация без перезагрузки.
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      resetForNewChat();
    }, 800);
    // Если страница не успокаивается (стриминг) — фиксируем снимок принудительно.
    setTimeout(() => {
      if (!state.baselineReady) finalizeBaseline();
    }, 20000);
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
