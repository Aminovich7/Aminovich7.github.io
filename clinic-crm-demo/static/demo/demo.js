/*
 * Demo glue: runs before the real frontend's scripts. It answers the
 * frontend's API calls with CRMMock (a JS port of the backend rules), keeps
 * the fictional data in this browser, rewrites page navigation for static
 * hosting, and adds the demo bar and the demo-account picker.
 */
(function () {
  "use strict";

  const LANG = document.documentElement.getAttribute("data-demo-lang") === "uz" ? "uz" : "en";
  const STATE_KEY = "klinika-crm-demo:state:v2";
  const OLD_STATE_KEYS = ["klinika-crm-demo:state:v1"];
  const LANG_KEY = "klinika-crm-demo:lang";
  const PORTFOLIO_URL = "https://aminovich7.github.io/";
  const REPO_URL = "https://github.com/Aminovich7/clinic-crm-showcase";

  // ------------------------------------------------------------ storage
  // localStorage normally; if the browser blocks it, a window.name-backed
  // store keeps the session alive across page loads in this tab.
  function windowNameStore() {
    let data = {};
    try { const parsed = JSON.parse(window.name || "{}"); if (parsed && parsed.__crmDemo) data = parsed.data || {}; } catch (e) { /* ignore */ }
    const persist = () => { try { window.name = JSON.stringify({ __crmDemo: true, data }); } catch (e) { /* ignore */ } };
    return {
      getItem: (k) => (k in data ? data[k] : null),
      setItem: (k, v) => { data[k] = String(v); persist(); },
      removeItem: (k) => { delete data[k]; persist(); },
      clear: () => { data = {}; persist(); },
      key: (i) => Object.keys(data)[i] || null,
      get length() { return Object.keys(data).length; },
    };
  }
  let store;
  try {
    const probe = "__crm_demo_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    store = window.localStorage;
  } catch (e) {
    store = windowNameStore();
    try { Object.defineProperty(window, "localStorage", { value: store, configurable: true }); } catch (err) { /* ignore */ }
  }
  try { store.setItem(LANG_KEY, LANG); } catch (e) { /* ignore */ }
  try { OLD_STATE_KEYS.forEach((k) => store.removeItem(k)); } catch (e) { /* ignore */ }

  // -------------------------------------------------------------- state
  const tashToday = () => new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

  function freshState(previous) {
    const s = window.CRMMock.generate(Date.now(), { lang: LANG });
    if (previous && previous.tokens) s.tokens = previous.tokens; // stay signed in
    return s;
  }

  function loadState() {
    let s = null;
    try { s = JSON.parse(store.getItem(STATE_KEY) || "null"); } catch (e) { s = null; }
    if (!s || s.version !== 1) return freshState(null);
    const age = daysBetween(s.generatedFor, tashToday());
    // Untouched data is rebuilt every day (and on a language switch) so
    // "this month" always has figures; edited data is kept for a week.
    if (!s.dirty && (age !== 0 || s.lang !== LANG)) return freshState(s);
    if (s.dirty && age > 7) return freshState(s);
    return s;
  }

  let state = loadState();
  let lastSaved = null;
  function save(s) {
    try {
      lastSaved = JSON.stringify(s);
      store.setItem(STATE_KEY, lastSaved);
    } catch (e) { /* quota or blocked storage: keep going in memory */ }
  }
  save(state);
  let server = window.CRMMock.createServer(state, { onChange: save });

  // Another tab changed the data: pick it up.
  window.addEventListener("storage", (e) => {
    if (e.key !== STATE_KEY || !e.newValue || e.newValue === lastSaved) return;
    try {
      state = JSON.parse(e.newValue);
      server = window.CRMMock.createServer(state, { onChange: save });
    } catch (err) { /* ignore */ }
  });

  function resetDemo() {
    try { store.removeItem(STATE_KEY); store.removeItem("refresh_token"); } catch (e) { /* ignore */ }
    window.location.href = "index.html";
  }

  // ----------------------------------------------------- page navigation
  const PAGES = ["login", "dashboard", "reports", "salary-page", "pharmacy-page", "receipts", "navbatchilik-page", "expenses-page", "staff-page", "users-page", "audit-log", "settings"];
  window.__demoPath = function () {
    const file = window.location.pathname.split("/").pop() || "index.html";
    const name = file.replace(/\.html$/, "");
    return name === "index" || name === "" ? "/login" : "/" + name;
  };
  window.__demoHref = function (path) {
    const name = String(path).replace(/^\//, "");
    return PAGES.includes(name) ? (name === "login" ? "index.html" : name + ".html") : name;
  };
  window.__demoGo = function (path) {
    window.location.href = window.__demoHref(path);
  };

  // ------------------------------------------------------- fetch bridge
  const STATUS_TEXT = { 200: "OK", 201: "Created", 204: "No Content", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 422: "Unprocessable Entity", 500: "Internal Server Error" };
  const EN_DETAIL = { "Login yoki Parol xato, Adminga murojaat qiling!": "Wrong username or password. Please contact the administrator." };
  const EN_VOIDED = { "Ko'rik": "Consultation", "Qayta ko'rik": "Follow-up", Operatsiya: "Surgery", Xona: "Room", Navbatchilik: "Duty shift", Xarajat: "Expense", Dorixona: "Pharmacy", "Oylik to'lovi": "Salary payment", "Dorixona yozuvi": "Pharmacy entry", Avans: "Advance", "To'liq oylik": "Full salary" };

  // English build: the few Uzbek strings the backend itself produces.
  function localize(path, json) {
    if (LANG !== "en" || !json) return json;
    if (typeof json.detail === "string" && EN_DETAIL[json.detail]) json.detail = EN_DETAIL[json.detail];
    if (path === "/voided-records" && Array.isArray(json.items)) {
      json.items.forEach((row) => {
        row.resource_label = EN_VOIDED[row.resource_label] || row.resource_label;
        const m = String(row.summary).match(/^(.*?)( #\d+)?$/);
        if (m && EN_VOIDED[m[1]]) row.summary = EN_VOIDED[m[1]] + (m[2] || "");
      });
    }
    return json;
  }

  const realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = async function (input, init) {
    init = init || {};
    const url = typeof input === "string" ? input : input && input.url;
    if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) {
      return realFetch(input, init);
    }
    const u = new URL(url, "https://demo.invalid");
    const headers = {};
    new Headers(init.headers || {}).forEach((v, k) => { headers[k] = v; });
    let body;
    let form;
    if (init.body instanceof URLSearchParams) form = init.body;
    else if (typeof FormData !== "undefined" && init.body instanceof FormData) form = new URLSearchParams([...init.body]);
    else if (typeof init.body === "string") {
      const ct = headers["content-type"] || "";
      if (ct.includes("application/x-www-form-urlencoded")) form = new URLSearchParams(init.body);
      else { try { body = JSON.parse(init.body); } catch (e) { body = init.body; } }
    }
    await new Promise((r) => setTimeout(r, 70 + Math.random() * 110));
    let out;
    try {
      out = server.handle({ method: init.method || "GET", path: u.pathname, query: u.search.slice(1), headers, body, form });
    } catch (e) {
      console.error("[demo] request failed", e);
      out = { status: 500, text: "Internal Server Error", headers: {} };
    }
    if (out.status === 204) return new Response(null, { status: 204, statusText: "No Content" });
    if (out.bytes) {
      return new Response(new Blob([out.bytes], { type: out.contentType }), {
        status: 200, statusText: "OK", headers: Object.assign({ "content-type": out.contentType }, out.headers),
      });
    }
    if (out.text !== undefined) {
      return new Response(out.text, { status: out.status, statusText: STATUS_TEXT[out.status] || "", headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return new Response(JSON.stringify(localize(u.pathname, out.json)), {
      status: out.status, statusText: STATUS_TEXT[out.status] || "", headers: Object.assign({ "content-type": "application/json" }, out.headers),
    });
  };

  // --------------------------------------------------------- demo chrome
  const TEXT = {
    en: {
      badge: "Live demo · sample data",
      guide: "Guide",
      reset: "Reset",
      other: "O'zbekcha",
      otherTitle: "Show the original Uzbek interface",
      portfolio: "Portfolio",
      resetConfirm: "Reset the demo? Your changes are discarded and the sample data comes back.",
      guideTitle: "What you're looking at",
      guideBody: [
        "The real interface of a finance and payroll system I built for a private clinic with FastAPI, PostgreSQL and Redis. The original is in Uzbek; this demo shows it in English (switch with the button below).",
        "Here it runs entirely in your browser: the frontend talks to a JavaScript port of the backend's rules, checked response-for-response against the real API. The data is fictional and only stored in this browser.",
      ],
      tryTitle: "Things to try",
      tries: [
        "<b>Super admin</b>: the dashboard, reports by doctor, salary balances, voided records and settings.",
        "<b>Receipts</b>: add a consultation, then see the doctor's share in Reports and Salaries change.",
        "<b>Void</b> a receipt, then restore or delete it from Voided records (super admin only).",
        "<b>Salaries</b>: a nurse hired mid-month is paid only for the working days since her hire date.",
        "<b>Assistant</b>: a restricted view with receipts only, and only their own entries.",
      ],
      code: "Case study and code walkthrough",
      close: "Close",
      loginTitle: "Try it with a demo account",
      loginIntro: "This is the working interface of a clinic finance system I built with FastAPI, running on sample data. Choose a role:",
      roles: [
        ["admin", "admin123", "Super admin", "sees everything"],
        ["sardor", "sardor123", "Manager", "payroll, expenses, staff"],
        ["shahnoza", "shahnoza123", "Assistant", "enters receipts only"],
      ],
      loginNote: "Names and amounts are fictional. Changes stay in this browser.",
    },
    uz: {
      badge: "Demo · namunaviy ma'lumotlar",
      guide: "Qo'llanma",
      reset: "Qayta boshlash",
      other: "English",
      otherTitle: "Show the interface in English",
      portfolio: "Portfolio",
      resetConfirm: "Demoni qayta boshlaysizmi? O'zgarishlaringiz o'chadi va namunaviy ma'lumotlar qaytadi.",
      guideTitle: "Bu nima",
      guideBody: [
        "Xususiy klinika uchun FastAPI, PostgreSQL va Redis asosida qurgan moliya va ish haqi tizimimning haqiqiy interfeysi.",
        "Bu yerda u to'liq brauzeringizda ishlaydi: frontend backend qoidalarining JavaScript nusxasi bilan ishlaydi va natijalari haqiqiy API bilan tekshirilgan. Ma'lumotlar o'ylab topilgan va faqat shu brauzerda saqlanadi.",
      ],
      tryTitle: "Sinab ko'ring",
      tries: [
        "<b>Bosh administrator</b>: boshqaruv paneli, shifokorlar bo'yicha hisobotlar, oyliklar, bekor qilingan yozuvlar va sozlamalar.",
        "<b>Kvitansiyalar</b>: ko'rik qo'shing va Hisobotlar hamda Oyliklarda shifokor ulushi o'zgarishini ko'ring.",
        "<b>Bekor qiling</b>, so'ng Bekor qilingan yozuvlardan tiklang yoki o'chiring.",
        "<b>Oyliklar</b>: oy o'rtasida ishga kirgan hamshiraga faqat ishlagan kunlari uchun hisoblanadi.",
        "<b>Yordamchi</b>: faqat kvitansiyalar va faqat o'zi kiritgan yozuvlar.",
      ],
      code: "Loyiha tavsifi",
      close: "Yopish",
      loginTitle: "Demo hisob bilan kiring",
      loginIntro: "Bu FastAPI asosida qurgan klinika moliya tizimimning namunaviy ma'lumotlar bilan ishlaydigan interfeysi. Rolni tanlang:",
      roles: [
        ["admin", "admin123", "Bosh administrator", "hamma narsani ko'radi"],
        ["sardor", "sardor123", "Menejer", "oyliklar, xarajatlar, ishchilar"],
        ["shahnoza", "shahnoza123", "Yordamchi", "faqat kvitansiyalar"],
      ],
      loginNote: "Ism va summalar o'ylab topilgan. O'zgarishlar shu brauzerda qoladi.",
    },
  }[LANG];

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
    (children || []).forEach((c) => node.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return node;
  }

  function otherLanguageHref() {
    const file = window.location.pathname.split("/").pop() || "index.html";
    return LANG === "en" ? "uz/" + file : "../" + file;
  }

  function buildGuide() {
    const dialog = el("div", { class: "demo-guide hidden", role: "dialog", "aria-modal": "true", "aria-labelledby": "demo-guide-title" });
    const close = () => dialog.classList.add("hidden");
    const panel = el("div", { class: "demo-guide__panel" }, [
      el("h2", { id: "demo-guide-title", text: TEXT.guideTitle }),
      ...TEXT.guideBody.map((p) => el("p", { text: p })),
      el("h3", { text: TEXT.tryTitle }),
      el("ul", {}, TEXT.tries.map((t) => el("li", { html: t }))),
      el("div", { class: "demo-guide__actions" }, [
        el("a", { href: REPO_URL, target: "_blank", rel: "noopener", text: TEXT.code + " ↗" }),
        el("button", { type: "button", class: "secondary", text: TEXT.close, onclick: close }),
      ]),
    ]);
    dialog.appendChild(panel);
    dialog.addEventListener("click", (e) => { if (e.target === dialog) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    return dialog;
  }

  function buildBar(guide) {
    const bar = el("div", { class: "demo-bar", role: "region", "aria-label": "Demo" }, [
      el("span", { class: "demo-bar__badge", text: TEXT.badge }),
      el("button", { type: "button", text: TEXT.guide, onclick: () => guide.classList.remove("hidden") }),
      el("button", { type: "button", text: TEXT.reset, onclick: () => { if (window.confirm(TEXT.resetConfirm)) resetDemo(); } }),
      el("a", { href: otherLanguageHref(), title: TEXT.otherTitle, lang: LANG === "en" ? "uz" : "en", text: TEXT.other }),
      el("a", { href: PORTFOLIO_URL, text: TEXT.portfolio + " ↗" }),
    ]);
    return bar;
  }

  function buildLoginHelper() {
    const form = document.getElementById("login-form");
    if (!form) return;
    const card = el("div", { class: "demo-accounts" }, [
      el("h2", { text: TEXT.loginTitle }),
      el("p", { text: TEXT.loginIntro }),
      el("div", { class: "demo-accounts__roles" }, TEXT.roles.map(([user, pass, role, what]) =>
        el("button", {
          type: "button",
          class: "demo-accounts__role",
          onclick: () => {
            document.getElementById("username").value = user;
            document.getElementById("password").value = pass;
            if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event("submit", { cancelable: true }));
          },
        }, [el("strong", { text: role }), el("span", { text: what }), el("code", { text: `${user} / ${pass}` })]))),
      el("p", { class: "demo-accounts__note", text: TEXT.loginNote }),
    ]);
    const loginCard = document.querySelector(".login-card");
    loginCard.parentNode.insertBefore(card, loginCard.nextSibling);
  }

  document.addEventListener("DOMContentLoaded", () => {
    const guide = buildGuide();
    document.body.appendChild(guide);
    document.body.appendChild(buildBar(guide));
    buildLoginHelper();
    const first = (() => { try { return !store.getItem("klinika-crm-demo:seen-guide"); } catch (e) { return false; } })();
    if (first && window.__demoPath() !== "/login") {
      guide.classList.remove("hidden");
      try { store.setItem("klinika-crm-demo:seen-guide", "1"); } catch (e) { /* ignore */ }
    }
  });
})();
