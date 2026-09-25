/* Python (Pyodide) в отдельном потоке браузера — здесь проверяется код ученика.
   Интерфейс (app.js) не зависает, а если код ученика «повесит» Python,
   app.js просто перезапустит этот поток. Это модульный воркер: так Pyodide
   надёжнее всего грузится и в Telegram, и в обычных браузерах. */

const VERSION = "v314.0.7";
const MIRRORS = [
  `https://cdn.jsdelivr.net/pyodide/${VERSION}/full/`,
  `https://fastly.jsdelivr.net/pyodide/${VERSION}/full/`,
  `https://gcore.jsdelivr.net/pyodide/${VERSION}/full/`,
];

let pyodide = null;
let webcheck = null;
let pytestLoaded = false;

async function boot(bundleUrl) {
  const errors = [];
  for (const base of MIRRORS) {
    try {
      const { loadPyodide } = await import(base + "pyodide.mjs");
      pyodide = await loadPyodide({ indexURL: base });
      break;
    } catch (error) {
      errors.push(`${new URL(base).host}: ${error && error.message ? error.message : error}`);
    }
  }
  if (!pyodide) throw new Error("Не удалось загрузить Python. " + errors.join(" | "));

  const response = await fetch(bundleUrl, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Не удалось загрузить файлы курса (${response.status})`);
  const files = await response.json();
  for (const [name, text] of Object.entries(files)) {
    const path = "/app/" + name;
    pyodide.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
    pyodide.FS.writeFile(path, text);
  }
  pyodide.runPython("import sys; sys.path.insert(0, '/app'); sys.dont_write_bytecode = True");
  webcheck = pyodide.pyimport("webcheck");
}

async function handle(type, payload) {
  if (type === "boot") {
    await boot(payload.bundle);
    return { ready: true };
  }
  if (type === "check") {
    if (payload.needsPytest && !pytestLoaded) {
      await pyodide.loadPackage("pytest");
      pytestLoaded = true;
    }
    return JSON.parse(webcheck.check(payload.taskId, payload.code));
  }
  if (type === "run") {
    return JSON.parse(webcheck.run(payload.code, payload.stdin || ""));
  }
  throw new Error("Неизвестная команда: " + type);
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data;
  try {
    self.postMessage({ id, ...(await handle(type, payload || {})) });
  } catch (error) {
    self.postMessage({ id, error: String(error && error.message ? error.message : error) });
  }
};
