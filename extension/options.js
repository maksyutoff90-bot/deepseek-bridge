const DEFAULTS = { port: 8787, token: "", autoSend: false, capture: true, noAutoExpand: false };
const $ = (id) => document.getElementById(id);

async function load() {
  const cfg = await chrome.storage.local.get(Object.keys(DEFAULTS));
  $("port").value = cfg.port ?? DEFAULTS.port;
  $("token").value = cfg.token ?? "";
  $("autoSend").checked = !!cfg.autoSend;
  $("capture").checked = cfg.capture !== false;
  $("collapse").checked = !!cfg.noAutoExpand;
}

async function save() {
  const port = Number($("port").value) || DEFAULTS.port;
  const token = $("token").value.trim();
  await chrome.storage.local.set({
    port,
    token,
    autoSend: $("autoSend").checked,
    capture: $("capture").checked,
    noAutoExpand: $("collapse").checked,
  });
  status("Сохранено", "ok");
}

async function test() {
  const port = Number($("port").value) || DEFAULTS.port;
  const token = $("token").value.trim();
  status("Проверяю…", "");
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { cache: "no-store" });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || "шлюз ответил ошибкой");
    const check = await fetch(`http://127.0.0.1:${port}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webcode-token": token },
      body: JSON.stringify({ tool: "list", args: { path: "." } }),
    }).then((r) => r.json());
    if (!check.ok) throw new Error(check.error || "токен не принят");
    status(`Связь есть. Корень: ${body.root}`, "ok");
  } catch (e) {
    status(`Ошибка: ${e.message || e}`, "err");
  }
}

function status(text, cls) {
  const el = $("status");
  el.textContent = text;
  el.className = cls || "";
}

$("save").addEventListener("click", save);
$("test").addEventListener("click", test);
load();
