const DEFAULTS = { port: 8787, token: "", autoSend: false, capture: true, noAutoExpand: false, lang: "en" };
const $ = (id) => document.getElementById(id);

async function load() {
  const cfg = await chrome.storage.local.get(Object.keys(DEFAULTS));
  $("port").value = cfg.port ?? DEFAULTS.port;
  $("token").value = cfg.token ?? "";
  $("lang").value = cfg.lang === "ru" ? "ru" : "en";
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
    lang: $("lang").value === "ru" ? "ru" : "en",
    autoSend: $("autoSend").checked,
    capture: $("capture").checked,
    noAutoExpand: $("collapse").checked,
  });
  status("Saved", "ok");
}

async function test() {
  const port = Number($("port").value) || DEFAULTS.port;
  const token = $("token").value.trim();
  status("Checking…", "");
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { cache: "no-store" });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || "gateway returned an error");
    const check = await fetch(`http://127.0.0.1:${port}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webcode-token": token },
      body: JSON.stringify({ tool: "list", args: { path: "." } }),
    }).then((r) => r.json());
    if (!check.ok) throw new Error(check.error || "token rejected");
    status(`Connected. Project root: ${body.root}`, "ok");
  } catch (e) {
    status(`Error: ${e.message || e}`, "err");
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
