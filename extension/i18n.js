// Lightweight runtime translation for the panel UI.
// Source strings are Russian; when lang === "en" they are translated on the fly.
// Original nodes are remembered so switching back to Russian restores them.
(() => {
  if (window.__wcI18n) return;

  const DICT = {
    "Потяните, чтобы изменить ширину": "Drag to resize",
    "Закрепить справа": "Dock to the right",
    "Открепить": "Undock",
    "Развернуть": "Expand",
    "Свернуть": "Collapse",
    "Отправить": "Send",
    "Записать код из последнего ответа в файлы": "Write code from the last answer into files",
    "Записать": "Write",
    "Перенести файлы из _fixes в проект": "Apply staged files to the project",
    "Применить": "Apply",
    "Открыть папку исправлений": "Open the fixes folder",
    "Папка": "Folder",
    "Файлы проекта и перетаскивание": "Project files and drag & drop",
    "Файлы": "Files",
    "Очистить лог": "Clear log",
    "Очистить": "Clear",
    "Проверить": "Check",
    "Другая папка…": "Other folder…",
    "Папка проекта:": "Project folder:",
    "Выбрать рабочую папку": "Choose the project folder",
    "Сканировать проект": "Scan project",
    "Запустить тесты": "Run tests",
    "сканирую проект…": "scanning project…",
    "запускаю тесты…": "running tests…",
    "Настройки": "Settings",
    "проект": "project",
    "Обновить": "Refresh",
    "Закрыть": "Close",
    "ПКМ по файлу — меню · перетащите код из чата в папку":
      "Right-click a file for the menu · drag code from chat into a folder",
    "Открыть в VS Code": "Open in VS Code",
    "Открыть папку": "Open folder",
    "Скопировать путь": "Copy path",
    "Показать diff": "Show diff",
    "Прочитать": "Preview",
    "Отправить в чат": "Send to chat",
    "Удалить (в корзину)": "Delete (to trash)",
    "ожидание блока webcode": "waiting for a webcode block",
    "результат готов — нажмите «Отправить»": "result ready — press Send",
    "нет связи": "no connection",
    "service worker не ответил": "service worker did not respond",
    "нет сохранённых правок": "no staged edits",
    "Отмена": "Cancel",
    "применение отменено": "apply cancelled",
    "в последнем ответе нет кода для записи": "no code to write in the last answer",
    "Укажите файл для каждого блока:": "Pick a file for each block:",
    "путь, напр. englishrus/utils.py": "path, e.g. src/utils.py",
    "имя файла, напр. utils.py": "file name, e.g. utils.py",
    "корень проекта": "project root",
    "буфер недоступен — путь вставлен в поле ввода":
      "clipboard unavailable — path inserted into the input",
    "не нашёл поле ввода — текст сохранён в панели": "input not found — text kept in the panel",
    "отправлено автоматически": "sent automatically",
    "автоотправка не сработала — нажмите Enter в поле ввода":
      "auto-send failed — press Enter in the input",
    "нужна отправка вручную": "manual send needed",
    "ждёт отправки": "waiting to send",
    "отправлено": "sent",
    "готово": "done",
    "ошибка": "error",
    "неизвестная ошибка": "unknown error",
    "результат в поле ввода — проверьте и нажмите Enter":
      "result is in the input — review and press Enter",
    "(совпадений нет)": "(no matches)",
    " (таймаут)": " (timeout)",
    "(не изменён)": "(unchanged)",
    " (бэкап есть)": " (backup kept)",
    " (не изменён)": "(unchanged)",
  };

  const PATTERNS = [
    [/^Изменить (\d+) файл\(ов\) в проекте\?$/, "Overwrite $1 file(s) in the project?"],
    [/^Перезаписать (\d+) файл(?:а\(ов\))? в проекте\?$/, "Overwrite $1 file(s) in the project?"],
    [/^(\d+) файл\(ов\) в папке исправлений$/, "$1 file(s) in the fixes folder"],
    [/^шлюз на связи: (.*)$/, "gateway connected: $1"],
    [/^нет связи со шлюзом: (.*)$/, "gateway unreachable: $1"],
    [/^шлюз: (.*)$/, "gateway: $1"],
    [/^шлюз (.*)$/, "gateway $1"],
    [/^история: (\d+) сообщений.*$/, "history: $1 messages, watching only new ones"],
    [/^другой чат.*$/, "another chat — waiting for your message"],
    [/^(WebCode Bridge [\d.]+): правки сохраняются в _fixes$/, "$1: edits go to _fixes"],
    [/^вставлено в поле ввода \((\d+) символов\)$/, "inserted into the input ($1 chars)"],
    [/^✓ применено файлов: (\d+)$/, "✓ applied: $1 file(s)"],
    [/^⚠ пропущено \(похоже на фрагмент\): (.*)$/, "⚠ skipped (looks like a fragment): $1"],
    [/^✗ применить: (.*)$/, "✗ apply: $1"],
    [/^✗ блок (\d+): укажите путь вида .*$/, "✗ block $1: enter a path like src/utils.py"],
    [/^✓ записано: (.*)$/, "✓ written: $1"],
    [/^⚠ (.*): похоже на фрагмент — пропущено$/, "⚠ $1: looks like a fragment, skipped"],
    [/^✗ укажите имя файла без папок$/, "✗ enter a file name without folders"],
    [/^Записать в (.*):$/, "Write to $1:"],
    [/^(\d+) стр\. · (.*)$/, "$1 lines · $2"],
    [/· (\d+) стр\.$/, "· $1 lines"],
    [/^✓ (.*) \((\d+) мс\)$/, "✓ $1 ($2 ms)"],
    [/^выполняю (.*)$/, "running $1"],
    [/^✗ (.*): больше 2 МБ$/, "✗ $1: larger than 2 MB"],
    [/^✗ захват (.*)$/, "✗ capture $1"],
    [/^сбой обработки блока: (.*)$/, "block processing failed: $1"],
    [/^открыл в VS Code: (.*)$/, "opened in VS Code: $1"],
    [/^открыл (.*)$/, "opened $1"],
    [/^✗ папка: (.*)$/, "✗ folder: $1"],
    [/^отправил в чат: (.*)$/, "sent to chat: $1"],
    [/^проект: (.*)$/, "project: $1"],
    [/^✗ проект: (.*)$/, "✗ project: $1"],
    [/^✗ проекты: (.*)$/, "✗ projects: $1"],
    [/^скан: (\d+) файлов, (.*)$/, "scan: $1 files, $2"],
    [/^расширения: (.*)$/, "extensions: $1"],
    [/^крупнейшие: (.*)$/, "largest: $1"],
    [/^тесты: код (\d+)(.*)$/, "tests: exit $1$2"],
    [/^✗ скан: (.*)$/, "✗ scan: $1"],
    [/^✗ тесты: (.*)$/, "✗ tests: $1"],
    [/^скопировано: (.*)$/, "copied: $1"],
    [/^в корзину: (.*)$/, "moved to trash: $1"],
    [/^✗ удалить: (.*)$/, "✗ delete: $1"],
    [/^✗ открыть: (.*)$/, "✗ open: $1"],
    [/^новый, (\d+) стр\.$/, "new, $1 lines"],
    [/^(\d+) → (\d+) стр\.$/, "$1 → $2 lines"],
    [/^записано: (\d+), пропущено: (\d+)$/, "written: $1, skipped: $2"],
    [/^записано: (\d+)$/, "written: $1"],
    [/…\[обрезано, всего (\d+) символов\]/g, "…[truncated, $1 chars total]"],
    [/· (\d+) стр\./g, "· $1 lines"],
  ];

  const SUBS = [
    ["путь выходит за пределы проекта: ", "path escapes the project root: "],
    ["путь ведёт за пределы проекта через ссылку: ", "path escapes the project root via a symlink: "],
    ["не указан path", "path is required"],
    ["это не файл: ", "not a file: "],
    ["похоже на бинарный файл", "looks like a binary file"],
    ["не указан pattern", "pattern is required"],
    ["плохое регулярное выражение: ", "bad regular expression: "],
    ["не указан command", "command is required"],
    ["запись отключена в конфиге шлюза", "writes are disabled in the gateway config"],
    ["выполнение команд отключено в конфиге шлюза", "running commands is disabled in the gateway config"],
    ["фрагмент old не найден в файле", "old fragment not found in the file"],
    ["уточните фрагмент или передайте all:true", "narrow the fragment or pass all:true"],
    ["нет сохранённой правки для ", "no staged edit for "],
    [" — сравнивать нечего", " — nothing to compare"],
    ["файла нет: ", "file not found: "],
    ["папки ещё нет: ", "folder does not exist: "],
    ["нельзя писать в папку исправлений: ", "cannot write into the fixes folder: "],
    ["нельзя удалять из папки исправлений", "cannot delete from the fixes folder"],
    ["нет такого файла: ", "no such file: "],
    ["загрузка файлов работает только в песочнице (sandbox: true)", "uploads work only in sandbox mode (sandbox: true)"],
    ["пустой файл", "empty file"],
    ["файл больше 2 МБ (", "file larger than 2 MB ("],
    ["нет сохранённых изменений для ", "no staged changes for "],
    ["нет сохранённых изменений", "no staged changes"],
    ["сохранённые файлы не найдены на диске", "staged files not found on disk"],
    ["неверный токен", "invalid token"],
    ["неизвестный инструмент: ", "unknown tool: "],
    ["токен не задан: откройте настройки расширения", "token is not set: open the extension settings"],
    ["запустите start-gateway.cmd", "run start-gateway.cmd"],
    ["файл слишком большой (", "file too large ("],
    ["old встречается ", "old appears "],
    [" раз(а); ", " times; "],
    ["в папке исправлений", "in the fixes folder"],
  ];

  let lang = "en";
  const originals = new WeakMap();

  function tr(text) {
    if (typeof text !== "string" || !text) return text;
    if (lang !== "en") return text;
    if (Object.prototype.hasOwnProperty.call(DICT, text)) return DICT[text];
    let out = text;
    for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
    for (const [a, b] of SUBS) out = out.split(a).join(b);
    return out;
  }

  function apply(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (!originals.has(node)) originals.set(node, node.nodeValue);
      const src = originals.get(node);
      const next = lang === "ru" ? src : tr(src);
      if (node.nodeValue !== next) node.nodeValue = next;
    }
    for (const el of root.querySelectorAll("[title],[placeholder]")) {
      let map = originals.get(el);
      if (!map || typeof map !== "object") {
        map = {};
        originals.set(el, map);
      }
      for (const attr of ["title", "placeholder"]) {
        if (!el.hasAttribute(attr)) continue;
        if (!(attr in map)) map[attr] = el.getAttribute(attr);
        const next = lang === "ru" ? map[attr] : tr(map[attr]);
        if (el.getAttribute(attr) !== next) el.setAttribute(attr, next);
      }
    }
  }

  function setLang(next, root) {
    lang = next === "ru" ? "ru" : "en";
    apply(root);
  }

  window.__wcI18n = { tr, apply, setLang, get lang() { return lang; } };
})();
