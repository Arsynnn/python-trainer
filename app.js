"use strict";
/* Python с нуля — Telegram Mini App.

   Курс        — course.json (его собирает build_webapp.py из папки course/ бота).
   Проверка    — worker.js: настоящий Python (Pyodide) прямо в браузере, тот же checker.py, что и в боте.
   Прогресс    — облако Telegram (CloudStorage) + копия в localStorage.
   Навигация   — адреса вида #/t/2.3; кнопки «Назад» и главная кнопка — родные кнопки Telegram. */

const tg = window.Telegram && window.Telegram.WebApp;
const IN_TG = Boolean(tg && tg.initData);
const TOUCH = window.matchMedia && matchMedia("(pointer: coarse)").matches;
const UNLOCK_AFTER = 3; // после скольких попыток открывается эталон
const root = document.getElementById("app");

const App = { course: null, sections: [], topics: {}, tasks: {}, order: [], topicOrder: [] };
let actions = {}; // обработчики кнопок data-act текущего экрана
let cleanups = []; // что убрать при уходе с экрана

// ================================================================== мелкие помощники

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function clock(seconds) {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Только слово в нужной форме: word(2, "день", "дня", "дней") → "дня". */
function word(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && !(b >= 12 && b <= 14)) return few;
  return many;
}

const plural = (n, one, few, many) => `${n} ${word(n, one, few, many)}`;

const yt = (id, start) => `https://www.youtube.com/watch?v=${id}` + (start ? `&t=${start}s` : "");
// enablejsapi=1 — чтобы плееру можно было отправлять команды (перемотка по главам)
const ytEmbed = (id, start) =>
  `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1&fs=1&enablejsapi=1` +
  `&origin=${encodeURIComponent(location.origin)}` + (start ? `&start=${start}` : "");
const ytThumb = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const stars = (level) => "⭐".repeat(level);

function dateKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function haptic(kind) {
  try {
    if (kind === "tap") tg.HapticFeedback.selectionChanged();
    else tg.HapticFeedback.notificationOccurred(kind);
  } catch (e) { /* вне Telegram вибрации нет */ }
}

function openLink(url) {
  if (IN_TG) tg.openLink(url);
  else window.open(url, "_blank", "noopener");
}

function toast(text) {
  document.querySelectorAll(".toast").forEach((node) => node.remove());
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = text;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 2600);
}

function confirmBox(text) {
  return new Promise((resolve) => {
    if (IN_TG && tg.isVersionAtLeast && tg.isVersionAtLeast("6.2")) tg.showConfirm(text, (ok) => resolve(Boolean(ok)));
    else resolve(window.confirm(text));
  });
}

/* Отчёты чекера написаны для Telegram: переносы строк там — символ \n.
   Для страницы превращаем их в <br>, не трогая блоки <pre>. */
function tgToWeb(html) {
  return String(html)
    .split(/(<pre>[\s\S]*?<\/pre>)/)
    .map((part, index) => (index % 2 ? part : part.replace(/^\n+|\n+$/g, "").replace(/\n/g, "<br>")))
    .join("");
}

function highlight(container) {
  if (!window.CodeMirror || !CodeMirror.runMode) return;
  container.querySelectorAll("pre > code.language-python").forEach((node) => {
    const text = node.textContent;
    node.textContent = "";
    CodeMirror.runMode(text, "python", node);
    node.closest("pre").classList.add("cm-s-pybot");
  });
}

// ================================================================== прогресс

const Store = {
  data: { solved: {}, tries: {}, days: [], last: "" },
  cloud: IN_TG && tg.isVersionAtLeast && tg.isVersionAtLeast("6.9") ? tg.CloudStorage : null,
  codeTimers: {},

  local(key, value) {
    try {
      if (value === undefined) return localStorage.getItem("pybot_" + key);
      localStorage.setItem("pybot_" + key, value);
    } catch (e) { /* приватный режим и т.п. */ }
    return null;
  },

  cloudGet(keys) {
    return new Promise((resolve) => {
      if (!this.cloud) return resolve({});
      const timer = setTimeout(() => resolve({}), 4000);
      try {
        this.cloud.getItems(keys, (error, values) => {
          clearTimeout(timer);
          resolve(error ? {} : values || {});
        });
      } catch (e) {
        clearTimeout(timer);
        resolve({});
      }
    });
  },

  cloudSet(key, value) {
    if (!this.cloud || value.length > 4096) return;
    try { this.cloud.setItem(key, value); } catch (e) { /* ничего страшного: есть localStorage */ }
  },

  async load() {
    const parse = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch (e) { return fallback; } };
    const data = {
      solved: parse(this.local("solved"), {}),
      tries: parse(this.local("tries"), {}),
      days: parse(this.local("days"), []),
      last: this.local("last") || "",
    };
    // Облако Telegram: прогресс общий для телефона и компьютера. Сливаем с локальной копией.
    const remote = await this.cloudGet(["solved", "tries", "days", "last"]);
    for (const [id, day] of Object.entries(parse(remote.solved, {}))) {
      if (!data.solved[id] || day < data.solved[id]) data.solved[id] = day;
    }
    for (const [id, count] of Object.entries(parse(remote.tries, {}))) data.tries[id] = Math.max(data.tries[id] || 0, count);
    data.days = [...new Set([...data.days, ...parse(remote.days, [])])].sort().slice(-200);
    if (!data.last && remote.last) data.last = remote.last;
    this.data = data;
    for (const key of ["solved", "tries", "days", "last"]) this.save(key);
  },

  save(key) {
    const value = key === "last" ? this.data.last : JSON.stringify(this.data[key]);
    this.local(key, value);
    this.cloudSet(key, value);
  },

  setLast(screen) {
    if (this.data.last === screen) return;
    this.data.last = screen;
    this.save("last");
  },

  attempt(taskId, ok) {
    const today = dateKey();
    this.data.tries[taskId] = (this.data.tries[taskId] || 0) + 1;
    if (!this.data.days.includes(today)) this.data.days = [...this.data.days, today].slice(-200);
    const newly = ok && !this.data.solved[taskId];
    if (newly) this.data.solved[taskId] = today;
    for (const key of ["tries", "days", "solved"]) this.save(key);
    return newly;
  },

  saveCode(taskId, code, now = false) {
    this.local("code_" + taskId, code);
    clearTimeout(this.codeTimers[taskId]);
    const push = () => this.cloudSet("c_" + taskId, code);
    if (now) push();
    else this.codeTimers[taskId] = setTimeout(push, 1500);
  },

  async loadCode(taskId) {
    const local = this.local("code_" + taskId);
    if (local !== null) return local;
    const remote = await this.cloudGet(["c_" + taskId]);
    return remote["c_" + taskId] || "";
  },
};

const isSolved = (id) => Boolean(Store.data.solved[id]);
const triesOf = (id) => Store.data.tries[id] || 0;
const unlocked = (id) => isSolved(id) || triesOf(id) >= UNLOCK_AFTER;

function topicProgress(topic) {
  return [topic.tasks.filter((task) => isSolved(task.id)).length, topic.tasks.length];
}

function sectionProgress(section) {
  let done = 0, total = 0;
  for (const topic of section.topics) {
    const [d, t] = topicProgress(topic);
    done += d;
    total += t;
  }
  return [done, total];
}

const totalDone = () => App.order.filter(isSolved).length;
const solvedToday = () => Object.values(Store.data.solved).filter((day) => day === dateKey()).length;

function streak() {
  const days = new Set(Store.data.days);
  const day = new Date();
  if (!days.has(dateKey(day))) day.setDate(day.getDate() - 1); // сегодня ещё не занимался — серия не сгорела
  let count = 0;
  while (days.has(dateKey(day))) {
    count += 1;
    day.setDate(day.getDate() - 1);
  }
  return count;
}

const statusIcon = (done, total) => (total && done === total ? "✅" : done ? "🟡" : "⚪");
const minutes = (topic) => Math.round(topic.chapters.reduce((sum, chapter) => sum + chapter.length, 0) / 60);
const TYPE_LABELS = { program: "программа", functions: "функции", mixed: "программа и функции", tests: "пишешь тесты" };

/** Куда ведёт «Продолжить»: незаконченная задача, начатая тема или первая нерешённая задача курса. */
function nextStep() {
  const last = Store.data.last || "";
  const [kind, key] = [last.slice(0, 1), last.slice(2)];
  if (kind === "k" && App.tasks[key] && !isSolved(key)) return { kind: "task", task: App.tasks[key] };
  if (kind === "t" && App.topics[key] && App.topics[key].tasks.some((task) => !isSolved(task.id))) {
    return { kind: "topic", topic: App.topics[key] };
  }
  for (const id of App.order) {
    if (isSolved(id)) continue;
    const task = App.tasks[id];
    const started = task.topic.tasks.some((other) => isSolved(other.id));
    return started ? { kind: "task", task } : { kind: "topic", topic: task.topic };
  }
  return { kind: "done" };
}

/** Что открыть после задачи: следующую задачу темы или теорию следующей темы. */
function afterTask(task) {
  const topic = task.topic;
  if (task.num < topic.tasks.length) return `#/k/${topic.tasks[task.num].id}`;
  const index = App.topicOrder.indexOf(topic.id);
  const next = App.topicOrder[index + 1];
  return next ? `#/t/${next}` : "#/progress";
}

// ================================================================== Python (worker.js)

const Py = {
  worker: null,
  state: "idle", // idle | loading | ready | error
  error: "",
  seq: 0,
  pending: new Map(),
  listeners: new Set(),
  booting: null,

  setState(state, error = "") {
    this.state = state;
    this.error = error;
    this.listeners.forEach((listener) => listener(state));
  },

  start() {
    if (this.booting) return this.booting;
    this.setState("loading");
    this.worker = new Worker(`worker.js?v=${App.course.version}`, { type: "module" });
    this.worker.onmessage = (event) => {
      const { id, ...data } = event.data;
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.resolve(data);
    };
    this.booting = this.call("boot", { bundle: `py_bundle.json?v=${App.course.version}` }, 240000).then((reply) => {
      if (reply.error || reply.hung) {
        this.booting = null;
        this.setState("error", reply.error || "Python слишком долго загружался");
        throw new Error(this.error);
      }
      this.setState("ready");
    });
    return this.booting;
  },

  call(type, payload, timeout) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.restart(); // код «повесил» Python — запускаем его заново
        resolve({ hung: true });
      }, timeout);
      this.pending.set(id, { resolve, timer });
      this.worker.postMessage({ id, type, payload });
    });
  },

  restart() {
    try { this.worker.terminate(); } catch (e) { /* уже остановлен */ }
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve({ hung: true });
    }
    this.pending.clear();
    this.worker = null;
    this.booting = null;
    this.setState("idle");
    this.start().catch(() => {});
  },

  async check(task, code) {
    await this.start();
    const timeout = task.type === "tests" ? 120000 : 20000 + task.checks * 4000;
    return this.call("check", { taskId: task.id, code, needsPytest: task.type === "tests" }, timeout);
  },

  async run(code, stdin) {
    await this.start();
    return this.call("run", { code, stdin }, 20000);
  },
};

function pyStatusHtml(state) {
  const text = {
    idle: "Python запустится, когда понадобится",
    loading: "Загружаю Python… в первый раз около 10 МБ, потом быстро",
    ready: "Python готов",
    error: `Python не загрузился: ${esc(Py.error)}. Проверь интернет (или включи VPN) и открой задачу снова.`,
  }[state];
  return `<span class="dot ${state}"></span><span>${text}</span>`;
}

// ================================================================== кнопки Telegram

let backTarget = null;
let mainHandler = null;
let overlayClose = null; // если открыто что-то поверх экрана (видео на весь экран), «Назад» закрывает сначала его
if (IN_TG) {
  tg.BackButton.onClick(() => {
    if (overlayClose) overlayClose();
    else if (backTarget) go(backTarget);
  });
  tg.MainButton.onClick(() => mainHandler && mainHandler());
}

function setBack(target) {
  backTarget = target || null;
  if (!IN_TG) return;
  if (target) tg.BackButton.show();
  else tg.BackButton.hide();
}

function setMain(spec) {
  mainHandler = spec ? spec.onClick : null;
  if (!IN_TG) return;
  if (!spec) {
    tg.MainButton.hide();
    return;
  }
  tg.MainButton.setParams({ text: spec.text, is_active: true, is_visible: true });
}

function mainBusy(on) {
  if (!IN_TG) return;
  if (on) tg.MainButton.showProgress(false);
  else tg.MainButton.hideProgress();
}

// ================================================================== навигация

function go(hash) {
  haptic("tap");
  if (location.hash === hash) render();
  else location.hash = hash;
}

function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  return { name: parts[0] || "home", arg: parts[1], extra: parts[2] };
}

function render() {
  Video.reset();
  cleanups.forEach((fn) => fn());
  cleanups = [];
  actions = {};
  const { name, arg, extra } = route();
  let view = null;
  if (name === "s" && App.sections[+arg]) view = extra === "tasks" ? viewSectionTasks(+arg) : viewSection(+arg);
  else if (name === "t" && App.topics[arg]) view = viewTopic(arg);
  else if (name === "k" && App.tasks[arg]) view = viewTask(arg);
  else if (name === "progress") view = viewProgress();
  else if (name === "about") view = viewAbout();
  else if (name === "selftest") view = viewSelftest();
  else view = viewHome();
  root.innerHTML = `<main class="page">${view.html}</main>`;
  window.scrollTo(0, 0);
  highlight(root);
  setBack(view.back);
  setMain(view.main);
  if (view.mount) view.mount();
}

root.addEventListener("click", (event) => {
  const target = event.target.closest("[data-go], [data-link], [data-act], a[href]");
  if (!target) return;
  if (target.dataset.go) {
    event.preventDefault();
    go(target.dataset.go);
  } else if (target.dataset.link) {
    event.preventDefault();
    openLink(target.dataset.link);
  } else if (target.dataset.act) {
    event.preventDefault();
    const handler = actions[target.dataset.act];
    if (handler) handler(target);
  } else if (/^https?:/.test(target.getAttribute("href") || "")) {
    event.preventDefault(); // внешние ссылки открываем браузером, а не внутри Mini App
    openLink(target.href);
  }
});

// ================================================================== общие куски разметки

function ring(percent) {
  const r = 36, c = 2 * Math.PI * r;
  return `<div class="ring"><svg width="84" height="84" viewBox="0 0 84 84">
    <circle class="track" cx="42" cy="42" r="${r}" fill="none" stroke-width="8"/>
    <circle class="value" cx="42" cy="42" r="${r}" fill="none" stroke-width="8" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - percent / 100)).toFixed(1)}"/>
  </svg><b>${percent}%</b></div>`;
}

const bar = (done, total) =>
  `<span class="bar ${total && done === total ? "ok" : ""}"><span style="width:${total ? (100 * done) / total : 0}%"></span></span>`;

function sectionRow(section) {
  const [done, total] = sectionProgress(section);
  return `<button class="row" data-go="#/s/${section.num}">
    <span class="icon">${section.emoji}</span>
    <span class="main">
      <span class="title">${section.num}. ${esc(section.title)}</span>
      <span class="meta">Лекция ${section.num} · ${clock(section.length)}</span>
      ${bar(done, total)}
    </span>
    <span class="side">${done}/${total}<span class="chev">›</span></span>
  </button>`;
}

function topicRow(topic) {
  const [done, total] = topicProgress(topic);
  const video = topic.chapters.length ? `🎬 ${minutes(topic)} мин · ` : topic.shorts.length ? "🎬 шорт · " : "";
  return `<button class="row" data-go="#/t/${topic.id}">
    <span class="icon">${statusIcon(done, total)}</span>
    <span class="main">
      <span class="title normal">${topic.id} ${esc(topic.title)}</span>
      <span class="meta">${video}${plural(total, "задача", "задачи", "задач")}</span>
    </span>
    <span class="side">${done}/${total}<span class="chev">›</span></span>
  </button>`;
}

function taskRow(task, showTopic = false) {
  const tries = triesOf(task.id);
  const extra = !isSolved(task.id) && tries ? ` · попыток: ${tries}` : "";
  const number = showTopic ? `${task.topic.id}.${task.num}` : `${task.num}.`;
  return `<button class="row" data-go="#/k/${task.id}">
    <span class="icon">${isSolved(task.id) ? "✅" : "✍️"}</span>
    <span class="main">
      <span class="title normal">${number} ${esc(task.title)}</span>
      <span class="meta">${stars(task.level)} · ${TYPE_LABELS[task.type]}${extra}</span>
    </span>
    <span class="chev">›</span>
  </button>`;
}

// ================================================================== экраны

function viewHome() {
  const done = totalDone(), total = App.order.length;
  const step = nextStep();
  let next = null;
  if (step.kind === "task") {
    next = { go: `#/k/${step.task.id}`, title: `Задача «${step.task.title}»`,
             meta: `Тема ${step.task.topic.id} · ${step.task.topic.title}` };
  } else if (step.kind === "topic") {
    next = { go: `#/t/${step.topic.id}`, title: `${step.topic.id} ${step.topic.title}`,
             meta: `Раздел ${step.topic.section.num} · ${step.topic.section.title}` };
  }
  const html = `
    <div class="top">
      <h1>🐍 Python с нуля</h1>
      <div class="sub">Гарвардский курс CS50P: теория, видео и задачи с автопроверкой</div>
    </div>
    <div class="card hero">
      ${ring(Math.round((100 * done) / total))}
      <div>
        <div class="big">${done} из ${plural(total, "задачи", "задач", "задач")}</div>
        <div class="pills">
          <span class="pill warn">🔥 ${plural(streak(), "день", "дня", "дней")} подряд</span>
          <span class="pill">Сегодня: ${solvedToday()}</span>
        </div>
      </div>
    </div>
    ${next ? `
      <button class="card continue" data-go="${next.go}">
        <span class="play">▶</span>
        <span class="main">
          <span class="meta">Продолжить</span>
          <span class="title" style="display:block">${esc(next.title)}</span>
          <span class="meta">${esc(next.meta)}</span>
        </span>
        <span class="chev">›</span>
      </button>` : `<div class="card success"><div class="big-emoji">🏆</div><div class="big">Все задачи решены!</div></div>`}
    <h2 class="group">Разделы</h2>
    <div class="list">${App.sections.map(sectionRow).join("")}</div>
    <div class="list">
      <button class="row plain" data-go="#/progress"><span class="main"><span class="title normal">📈 Прогресс</span></span><span class="chev">›</span></button>
      <button class="row plain" data-go="#/about"><span class="main"><span class="title normal">❓ Как это работает</span></span><span class="chev">›</span></button>
    </div>
    <div class="footer-note">Видео и идеи задач — CS50P, Harvard University (CC BY-NC-SA 4.0).<br>Конспекты и задачи на русском.</div>`;
  return { html, main: next ? { text: "▶ Продолжить", onClick: () => go(next.go) } : null };
}

function viewSection(number) {
  const section = App.sections[number];
  const [done, total] = sectionProgress(section);
  const prev = App.sections[number - 1], next = App.sections[number + 1];
  const html = `
    <div class="top">
      <div class="crumb"><a href="#/">Курс</a> › Раздел ${number}</div>
      <h1>${section.emoji} ${esc(section.title)}</h1>
      <div class="sub">${esc(section.lecture)} · ${clock(section.length)}</div>
    </div>
    <div class="card">
      <div class="prose">${section.intro}</div>
      ${bar(done, total)}
      <div class="sub" style="margin-top:6px">Решено ${done} из ${total}</div>
    </div>
    <div class="chips">
      <button class="chip" data-link="${yt(section.video)}">▶️ Вся лекция</button>
      <button class="chip" data-link="${esc(section.notes)}">📄 Конспект CS50</button>
      ${section.dubs.map((dub) => `<button class="chip" data-link="${esc(dub.url)}">${esc(dub.label)}</button>`).join("")}
    </div>
    <button class="card continue" data-go="#/s/${number}/tasks">
      <span class="play">⚡</span>
      <span class="main">
        <span class="title" style="display:block">Сразу к задачам</span>
        <span class="meta">Знаешь тему? Реши без видео — если легко, лекцию можно пропустить</span>
      </span>
      <span class="chev">›</span>
    </button>
    <h2 class="group">Темы</h2>
    <div class="list">${section.topics.map(topicRow).join("")}</div>
    <div class="nav">
      ${prev ? `<button class="btn ghost" data-go="#/s/${prev.num}">← ${prev.emoji} ${prev.num}</button>` : ""}
      ${next ? `<button class="btn ghost" data-go="#/s/${next.num}">${next.emoji} ${next.num} →</button>` : ""}
    </div>`;
  const firstOpen = section.topics.find((topic) => topic.tasks.some((task) => !isSolved(task.id)));
  return {
    html,
    back: "#/",
    main: firstOpen ? { text: `▶ ${firstOpen.id} ${firstOpen.title}`, onClick: () => go(`#/t/${firstOpen.id}`) } : null,
  };
}

function viewSectionTasks(number) {
  const section = App.sections[number];
  const tasks = section.topics.flatMap((topic) => topic.tasks);
  const html = `
    <div class="top">
      <div class="crumb"><a href="#/">Курс</a> › <a href="#/s/${number}">Раздел ${number}</a></div>
      <h1>⚡ Задачи раздела</h1>
      <div class="sub">${esc(section.title)}. Реши без видео: застрянешь — открой тему с теорией.</div>
    </div>
    <div class="list">${tasks.map((task) => taskRow(task, true)).join("")}</div>`;
  return { html, back: `#/s/${number}` };
}

function viewTopic(id) {
  const topic = App.topics[id];
  const section = topic.section;
  Store.setLast(`t:${id}`);
  const index = App.topicOrder.indexOf(id);
  const prev = App.topics[App.topicOrder[index - 1]], next = App.topics[App.topicOrder[index + 1]];
  const first = topic.chapters[0];
  const short = topic.shorts[0];
  // Что показывает плеер сначала: кусок лекции или, если его нет, первый шорт
  const intro = first
    ? { video: section.video, start: first.start, label: `Смотреть с ${clock(first.start)} · ≈ ${minutes(topic)} мин` }
    : short ? { video: short.id, start: 0, label: `Шорт «${short.title}» · ${short.duration}` } : null;
  const dock = intro ? `
    <div class="player-dock" id="dock">
      <div class="player">
        <button class="cover" data-act="play" data-video="${intro.video}" data-start="${intro.start}"
          style="background-image:url('${ytThumb(intro.video)}')">
          <span class="play-big">▶</span>
          <span class="label">${esc(intro.label)}</span>
        </button>
      </div>
      <div class="player-bar" hidden>
        <button class="tool" data-act="theater">⤢ На весь экран</button>
        <button class="tool" data-act="youtube">↗ В YouTube</button>
        <button class="tool" data-act="stop">✕ Закрыть</button>
      </div>
    </div>` : "";
  const chapters = first ? `
    <div class="card video">
      <div class="head">🎬 Главы лекции <span>· нажми — видео перемотается</span></div>
      <div class="list" style="margin:0;border-radius:0">
        ${topic.chapters.map((chapter) => `
          <button class="row plain" data-act="play" data-video="${section.video}" data-start="${chapter.start}">
            <span class="time">${clock(chapter.start)}</span>
            <span class="main"><span class="title normal">${esc(chapter.title)}</span>
              <span class="meta">${Math.max(1, Math.round(chapter.length / 60))} мин</span></span>
            <span class="chev">▶</span>
          </button>`).join("")}
      </div>
    </div>` : "";
  const extras = [
    ...topic.shorts.map((item) =>
      `<button class="chip" data-act="play" data-video="${item.id}" data-start="0">🎬 ${esc(item.title)} · ${item.duration}</button>`),
    ...topic.links.map((link) => `<button class="chip" data-link="${esc(link.url)}">${esc(link.label)}</button>`),
  ];
  const html = `
    <div class="top">
      <div class="crumb"><a href="#/">Курс</a> › <a href="#/s/${section.num}">${section.emoji} Раздел ${section.num}</a></div>
      <h1>${topic.id} ${esc(topic.title)}</h1>
    </div>
    ${dock}
    ${chapters}
    ${extras.length ? `<div class="chips">${extras.join("")}</div>` : ""}
    <div class="card prose">${topic.theory}</div>
    <h2 class="group">✍️ Практика</h2>
    <div class="list">${topic.tasks.map((task) => taskRow(task)).join("")}</div>
    <div class="nav">
      ${prev ? `<button class="btn ghost" data-go="#/t/${prev.id}">← ${prev.id}</button>` : ""}
      ${next ? `<button class="btn ghost" data-go="#/t/${next.id}">${next.id} →</button>` : ""}
    </div>`;
  actions.play = (button) => Video.play(button.dataset.video, Number(button.dataset.start) || 0);
  actions.theater = () => Video.toggleTheater();
  actions.stop = () => Video.stop();
  actions.youtube = () => {
    Video.command("pauseVideo", []);
    openLink(yt(Video.id || intro.video, Video.start));
  };
  const todo = topic.tasks.find((task) => !isSolved(task.id)) || topic.tasks[0];
  return {
    html,
    back: `#/s/${section.num}`,
    main: { text: `✍️ Задача «${todo.title}»`, onClick: () => go(`#/k/${todo.id}`) },
  };
}

// ================================================================== видеоплеер

/* Плеер темы. Пока видео играет, он закреплён вверху экрана, а конспект прокручивается под ним.
   Главы и шорты включаются в этом же плеере: перемотка идёт командами YouTube (postMessage).
   «⤢ На весь экран» разворачивает плеер и просит Telegram перейти в полноэкранный режим. */
const Video = {
  id: null, // какое видео загружено
  start: 0, // с какой секунды его в последний раз включали
  frame: null,
  loadedAt: 0,
  cover: "",
  theater: false,

  dock: () => document.getElementById("dock"),

  play(videoId, start) {
    const dock = this.dock();
    if (!dock) return;
    const player = dock.querySelector(".player");
    this.start = start;
    if (this.frame && this.id === videoId && this.loadedAt && Date.now() - this.loadedAt > 600) {
      this.command("seekTo", [start, true]); // то же видео уже загружено — просто перематываем
      this.command("playVideo", []);
    } else {
      if (!this.frame) this.cover = player.innerHTML;
      this.id = videoId;
      this.loadedAt = 0;
      player.classList.add("playing");
      player.innerHTML = `<iframe src="${ytEmbed(videoId, start)}" title="Видео"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
      this.frame = player.querySelector("iframe");
      this.frame.addEventListener("load", () => { this.loadedAt = Date.now(); });
    }
    dock.classList.add("active");
    dock.querySelector(".player-bar").hidden = false;
    haptic("tap");
  },

  command(func, args) {
    try {
      this.frame.contentWindow.postMessage(JSON.stringify({ event: "command", func, args }), "*");
    } catch (e) { /* плеер ещё не загрузился */ }
  },

  stop() {
    this.exitTheater();
    const dock = this.dock();
    if (dock && this.frame) {
      const player = dock.querySelector(".player");
      player.classList.remove("playing");
      player.innerHTML = this.cover;
      dock.classList.remove("active");
      dock.querySelector(".player-bar").hidden = true;
    }
    this.frame = null;
    this.id = null;
    this.loadedAt = 0;
  },

  /** Экран сменился: плеер уже удалён вместе со старой разметкой. */
  reset() {
    this.exitTheater();
    this.frame = null;
    this.id = null;
    this.loadedAt = 0;
    this.cover = "";
  },

  toggleTheater() {
    if (this.theater) this.exitTheater();
    else this.enterTheater();
  },

  enterTheater() {
    const dock = this.dock();
    if (!dock || !this.frame) return;
    this.theater = true;
    dock.classList.add("theater");
    document.documentElement.classList.add("no-scroll");
    dock.querySelector('[data-act="theater"]').textContent = "✕ Свернуть";
    overlayClose = () => this.exitTheater(); // «Назад» в Telegram сначала сворачивает видео
    if (IN_TG && tg.isVersionAtLeast && tg.isVersionAtLeast("8.0")) {
      try { tg.requestFullscreen(); } catch (e) { /* не поддерживается — останется развёрнутым в окне */ }
      try { tg.unlockOrientation(); } catch (e) { /* можно повернуть телефон */ }
    } else if (dock.requestFullscreen) {
      dock.requestFullscreen().catch(() => {});
    }
    if (IN_TG) tg.BackButton.show();
  },

  exitTheater() {
    if (!this.theater) return;
    this.theater = false;
    overlayClose = null;
    const dock = this.dock();
    if (dock) {
      dock.classList.remove("theater");
      const button = dock.querySelector('[data-act="theater"]');
      if (button) button.textContent = "⤢ На весь экран";
    }
    document.documentElement.classList.remove("no-scroll");
    try { if (IN_TG && tg.isFullscreen) tg.exitFullscreen(); } catch (e) { /* уже вышли */ }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  },
};

document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && Video.theater && !IN_TG) Video.exitTheater();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && Video.theater) Video.exitTheater();
});
if (IN_TG) {
  tg.onEvent("fullscreenChanged", () => {
    if (!tg.isFullscreen && Video.theater) Video.exitTheater();
  });
}

function viewTask(id) {
  const task = App.tasks[id];
  const topic = task.topic;
  Store.setLast(`k:${id}`);
  const keys = ["⇥", "(", ")", ":", '"', "'", "[", "]", "=", "+", "-", "*", "/", "<", ">", "{", "}", "#", "_", "."];
  const html = `
    <div class="top">
      <div class="crumb"><a href="#/t/${topic.id}">${topic.id} ${esc(topic.title)}</a></div>
      <h1>${esc(task.title)}</h1>
      <div class="task-head" id="task-head"></div>
    </div>
    <div class="card prose">${task.text}</div>
    <div class="card editor">
      <div class="bar-top">
        <span class="file">${task.file}</span>
        <span class="tools">
          ${task.starter ? `<button class="tool" data-act="starter">📄 Шаблон</button>` : ""}
          <button class="tool" data-act="clear">Очистить</button>
        </span>
      </div>
      <textarea id="code" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off"
        placeholder="Пиши код здесь…"></textarea>
      ${TOUCH ? `<div class="keys">${keys.map((key) => `<button class="key" data-act="key" data-key="${esc(key)}">${esc(key)}</button>`).join("")}</div>` : ""}
    </div>
    ${task.type !== "tests" ? `
      <details class="card stdin">
        <summary>⌨️ Ввод для «Запустить»</summary>
        <textarea id="stdin" placeholder="Каждая строка — ответ на один input()"></textarea>
      </details>` : ""}
    <div class="pystatus" id="pystatus">${pyStatusHtml(Py.state)}</div>
    <div class="btns">
      ${task.type !== "tests" ? `<button class="btn secondary" data-act="run">▶ Запустить</button>` : ""}
      ${IN_TG ? "" : `<button class="btn" data-act="check">✅ Проверить</button>`}
    </div>
    <div id="result"></div>
    <div class="btns">
      <button class="btn ghost" data-act="hint">💡 Подсказка</button>
      <button class="btn ghost" data-act="solution" id="solution-btn"></button>
    </div>
    <div id="extra"></div>
    <div class="nav">
      <button class="btn ghost" data-go="#/t/${topic.id}">← К теме</button>
      <button class="btn ghost" data-go="${afterTask(task)}">Дальше →</button>
    </div>`;

  let editor = null;
  let busy = false;
  const $ = (selector) => root.querySelector(selector);

  function refreshHead() {
    const tries = triesOf(id);
    $("#task-head").innerHTML = `
      <span class="pill">${stars(task.level)}</span>
      <span class="pill accent">${TYPE_LABELS[task.type]}</span>
      ${isSolved(id) ? `<span class="pill ok">✅ Решено</span>` : tries ? `<span class="pill">Попыток: ${tries}</span>` : ""}`;
    $("#solution-btn").textContent = `${unlocked(id) ? "🔓" : "🔒"} Эталон`;
  }

  function showResult(html) {
    $("#result").innerHTML = html;
    highlight($("#result"));
  }

  const waiting = (text) => `<div class="card result"><div class="pystatus" style="margin:0"><span class="spinner"></span>${text}</div></div>`;

  async function check() {
    if (busy) return;
    const code = editor.getValue();
    if (!code.trim()) {
      toast("Сначала напиши код 🙂");
      return;
    }
    busy = true;
    mainBusy(true);
    Store.saveCode(id, code, true);
    const first = Py.state !== "ready" ? " Сначала загружается Python — в первый раз это до минуты." : "";
    showResult(waiting(`Проверяю на ${plural(task.checks, "тесте", "тестах", "тестах")}…${first}`));
    let reply;
    try {
      reply = await Py.check(task, code);
    } catch (error) {
      reply = { error: String(error.message || error) };
    }
    busy = false;
    mainBusy(false);
    if (reply.error) {
      showResult(`<div class="card result fail"><div class="result-title">Не получилось проверить</div>${esc(reply.error)}</div>`);
      return;
    }
    if (reply.hung) {
      Store.attempt(id, false);
      refreshHead();
      haptic("error");
      showResult(`<div class="card result fail"><div class="result-title">⏱ Проверка зависла</div>
        Похоже, в коде бесконечный цикл. Python перезапущен — исправь код и попробуй ещё раз.</div>`);
      return;
    }
    const newly = Store.attempt(id, reply.ok);
    refreshHead();
    haptic(reply.ok ? "success" : "error");
    if (reply.ok) {
      const [done, total] = sectionProgress(topic.section);
      const sectionDone = newly && done === total ? `<div class="sub">🏁 Раздел ${topic.section.num} пройден целиком!</div>` : "";
      showResult(`
        <div class="card result ok success">
          <div class="big-emoji">${newly ? "🎉" : "✅"}</div>
          <div class="big">${newly ? "Задача решена!" : "Снова верно"}</div>
          <div class="sub">${tgToWeb(reply.html)}</div>
          ${sectionDone}
          <div class="btns"><button class="btn" data-go="${afterTask(task)}">Дальше →</button></div>
        </div>`);
      if (IN_TG) setMain({ text: "Дальше →", onClick: () => go(afterTask(task)) });
    } else {
      const tries = triesOf(id);
      const unlockNote = !isSolved(id) && tries === UNLOCK_AFTER ? "<br>🔓 Эталон открыт, но сначала попробуй подсказку." : "";
      showResult(`<div class="card result fail">${tgToWeb(reply.html)}
        <div class="sub" style="margin-top:8px">Попытка ${tries}. Исправь код и проверь ещё раз.${unlockNote}</div></div>`);
    }
    $("#result").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function run() {
    if (busy) return;
    const code = editor.getValue();
    if (!code.trim()) {
      toast("Сначала напиши код 🙂");
      return;
    }
    busy = true;
    showResult(waiting(Py.state !== "ready" ? "Загружаю Python и запускаю…" : "Запускаю…"));
    let reply;
    try {
      reply = await Py.run(code, $("#stdin") ? $("#stdin").value : "");
    } catch (error) {
      reply = { error: String(error.message || error) };
    }
    busy = false;
    if (reply.error) showResult(`<div class="card result fail">${esc(reply.error)}</div>`);
    else if (reply.hung) showResult(`<div class="card result fail">⏱ Программа зависла — похоже, бесконечный цикл. Python перезапущен.</div>`);
    else showResult(`<div class="card result run"><div class="result-title">▶ Результат запуска</div>${tgToWeb(reply.html)}</div>`);
  }

  actions.check = check;
  actions.run = run;
  actions.key = (button) => editor.insert(button.dataset.key === "⇥" ? "    " : button.dataset.key);
  actions.starter = async () => {
    if (editor.getValue().trim() && !(await confirmBox("Заменить твой код шаблоном?"))) return;
    editor.setValue(task.starter);
    editor.focus();
  };
  actions.clear = async () => {
    if (editor.getValue().trim() && (await confirmBox("Очистить редактор?"))) editor.setValue("");
  };
  actions.hint = () => {
    const box = $("#extra .hint-box");
    if (box) box.remove();
    else $("#extra").insertAdjacentHTML("afterbegin", `<div class="hint-box">💡 ${esc(task.hint)}</div>`);
  };
  actions.solution = async () => {
    if (!unlocked(id)) {
      toast(`🔒 Эталон откроется после решения или после ${UNLOCK_AFTER} попыток (сейчас: ${triesOf(id)})`);
      return;
    }
    if ($("#extra .solution")) {
      $("#extra .solution").remove();
      return;
    }
    if (!isSolved(id) && !(await confirmBox("Точно показать эталонное решение? Сначала попробуй подсказку 😉"))) return;
    $("#extra").insertAdjacentHTML("beforeend", `
      <div class="card solution"><div class="sub">🔓 Эталонное решение — верных решений бывает несколько:</div>
      <pre><code class="language-python">${esc(task.solution)}</code></pre></div>`);
    highlight($("#extra"));
  };

  return {
    html,
    back: `#/t/${topic.id}`,
    main: { text: "✅ Проверить", onClick: check },
    mount: async () => {
      refreshHead();
      const saved = await Store.loadCode(id);
      editor = makeEditor($("#code"), saved || (task.type === "tests" ? task.starter : ""), (code) => Store.saveCode(id, code));
      const listener = (state) => { const node = $("#pystatus"); if (node) node.innerHTML = pyStatusHtml(state); };
      Py.listeners.add(listener);
      cleanups.push(() => Py.listeners.delete(listener));
      Py.start().catch(() => {}); // Python грузится заранее, пока читаешь условие
    },
  };
}

function viewProgress() {
  const done = totalDone(), total = App.order.length;
  const tries = Object.values(Store.data.tries).reduce((a, b) => a + b, 0);
  const html = `
    <div class="top"><div class="crumb"><a href="#/">Курс</a></div><h1>📈 Прогресс</h1></div>
    <div class="card hero">
      ${ring(Math.round((100 * done) / total))}
      <div><div class="big">${done} из ${total}</div><div class="sub">задач решено</div></div>
    </div>
    <div class="stats">
      <div class="stat"><b>🔥 ${streak()}</b><span>${word(streak(), "день", "дня", "дней")} подряд</span></div>
      <div class="stat"><b>${solvedToday()}</b><span>${word(solvedToday(), "задача", "задачи", "задач")} сегодня</span></div>
      <div class="stat"><b>${tries}</b><span>${word(tries, "попытка", "попытки", "попыток")} всего</span></div>
    </div>
    <h2 class="group">По разделам</h2>
    <div class="list">${App.sections.map(sectionRow).join("")}</div>
    <div class="footer-note">Прогресс хранится в облаке Telegram — он общий для телефона и компьютера.</div>`;
  return { html, back: "#/" };
}

function viewAbout() {
  const html = `
    <div class="top"><div class="crumb"><a href="#/">Курс</a></div><h1>❓ Как это работает</h1></div>
    <div class="card prose">
      <b>1. Теория.</b> В каждой теме есть короткий конспект и главы лекции CS50P с таймкодами. Видео можно смотреть прямо здесь или открыть в YouTube с нужной минуты. Лекции на английском: включи ⚙️ → «Субтитры» → «Перевести» → «Русский». У лекций 0 и 1 есть русская ИИ-озвучка: ⚙️ → «Звуковая дорожка».<br><br>
      <b>2. Практика.</b> Пиши код в редакторе. «▶ Запустить» выполняет программу с твоим вводом, «✅ Проверить» прогоняет её по тестам задачи. Python работает прямо в Telegram: при первом запуске он загружается (около 10 МБ), потом всё быстро.<br><br>
      <b>Как проверяется код</b><br>
      • Программы: подаётся ввод и сравнивается то, что напечатал <code>print</code>. Текст приглашения в <code>input("...")</code> не учитывается.<br>
      • Функции и классы: код импортируется, функции вызываются по одной. Запуск <code>main()</code> оборачивай в <code>if __name__ == "__main__":</code>.<br>
      • Когда ввод закончился, <code>input()</code> бросает <code>EOFError</code>.<br>
      • На каждый тест — 3 секунды. Интернета и сторонних пакетов при проверке нет.<br><br>
      <b>3. Подсказки и эталон.</b> 💡 Подсказка доступна всегда. 🔓 Эталон открывается после решения или после ${UNLOCK_AFTER} попыток: сначала попробуй сам 20–30 минут.<br><br>
      <b>Уже знаешь тему?</b> В каждом разделе есть «⚡ Сразу к задачам».
    </div>
    <div class="footer-note">Видео и идеи задач: CS50's Introduction to Programming with Python, Harvard University, лицензия CC BY-NC-SA 4.0. Конспекты, условия и тесты написаны заново на русском.</div>`;
  return { html, back: "#/" };
}

/** Скрытый экран #/selftest: все эталоны через Python в браузере (для проверки после правок курса). */
function viewSelftest() {
  const html = `<div class="top"><h1>Самопроверка</h1><div class="sub">Каждый эталон должен пройти тесты, пустое решение — нет</div></div>
    <div class="card"><pre id="log" style="white-space:pre-wrap;margin:0">Загружаю Python…</pre></div>`;
  return {
    html,
    back: "#/",
    mount: async () => {
      const log = root.querySelector("#log");
      const started = performance.now();
      try {
        await Py.start();
      } catch (error) {
        log.textContent = "SELFTEST ERROR: " + error.message;
        return;
      }
      const lines = [];
      let passed = 0;
      for (const id of App.order) {
        const task = App.tasks[id];
        const good = await Py.check(task, task.solution);
        const empty = await Py.check(task, "pass");
        const ok = good.ok && !empty.ok;
        if (ok) passed += 1;
        lines.push(`${ok ? "✅" : "❌"} ${task.topic.id}.${task.num} ${id} (${good.passed}/${good.total})`);
        if (!good.ok) lines.push(tgToWeb(good.html || good.error || "").replace(/<[^>]+>/g, " ").slice(0, 400));
        log.textContent = lines.join("\n");
      }
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      lines.unshift(`SELFTEST: ${passed}/${App.order.length} ok за ${seconds} с`);
      log.textContent = lines.join("\n");
    },
  };
}

// ================================================================== редактор кода

function makeEditor(textarea, value, onChange) {
  if (window.CodeMirror) {
    const cm = CodeMirror.fromTextArea(textarea, {
      mode: "python",
      theme: "pybot",
      lineNumbers: true,
      indentUnit: 4,
      tabSize: 4,
      indentWithTabs: false,
      lineWrapping: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      viewportMargin: Infinity,
      inputStyle: TOUCH ? "contenteditable" : "textarea",
      extraKeys: {
        Tab: (editor) => (editor.somethingSelected() ? editor.indentSelection("add") : editor.replaceSelection("    ")),
        "Shift-Tab": (editor) => editor.indentSelection("subtract"),
        "Ctrl-Enter": () => actions.check && actions.check(),
        "Cmd-Enter": () => actions.check && actions.check(),
      },
    });
    cm.setValue(value || "");
    cm.on("change", () => onChange(cm.getValue()));
    setTimeout(() => cm.refresh(), 50);
    return {
      getValue: () => cm.getValue(),
      setValue: (text) => cm.setValue(text),
      insert: (text) => { cm.replaceSelection(text); cm.focus(); },
      focus: () => cm.focus(),
    };
  }
  // Запасной вариант, если CodeMirror не загрузился: обычное поле с поддержкой Tab
  textarea.classList.add("plain");
  textarea.value = value || "";
  textarea.addEventListener("input", () => onChange(textarea.value));
  textarea.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const { selectionStart: start, selectionEnd: end } = textarea;
    textarea.setRangeText("    ", start, end, "end");
    onChange(textarea.value);
  });
  const insert = (text) => {
    textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, "end");
    textarea.focus();
    onChange(textarea.value);
  };
  return { getValue: () => textarea.value, setValue: (text) => { textarea.value = text; onChange(text); }, insert, focus: () => textarea.focus() };
}

// ================================================================== запуск

function applyTheme() {
  const dark = IN_TG ? tg.colorScheme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.classList.toggle("tg", IN_TG);
  if (IN_TG) {
    try {
      tg.setHeaderColor("secondary_bg_color");
      tg.setBackgroundColor("secondary_bg_color");
    } catch (e) { /* старые версии Telegram */ }
  }
}

function indexCourse(course) {
  App.course = course;
  App.sections = course.sections;
  for (const section of course.sections) {
    for (const topic of section.topics) {
      topic.section = section;
      App.topics[topic.id] = topic;
      App.topicOrder.push(topic.id);
      for (const task of topic.tasks) {
        task.topic = topic;
        App.tasks[task.id] = task;
        App.order.push(task.id);
      }
    }
  }
}

async function init() {
  applyTheme();
  if (IN_TG) {
    tg.ready();
    tg.expand();
    try { tg.disableVerticalSwipes(); } catch (e) { /* нет в старых версиях */ }
    tg.onEvent("themeChanged", applyTheme);
  } else {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  }
  try {
    const response = await fetch("course.json", { cache: "no-cache" });
    indexCourse(await response.json());
  } catch (error) {
    root.innerHTML = `<main class="page"><div class="card">😕 Не удалось загрузить курс. Проверь интернет и открой приложение снова.</div></main>`;
    return;
  }
  await Store.load();
  window.addEventListener("hashchange", render);
  render();
}

init();
