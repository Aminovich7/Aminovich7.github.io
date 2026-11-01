(async function () {
  const user = await initPage({ allowedRoles: ["superadmin", "manager"] });
  if (!user) return;

  const $ = (id) => document.getElementById(id);
  const dateFromInput = $("date_from");
  const dateToInput = $("date_to");
  const errorContainer = $("error-container");

  const SVG_NS = "http://www.w3.org/2000/svg";

  // The three departments, in the fixed order every view on this page uses:
  // the KPI breakdown, the chart's stack (bottom to top) and its legend, and
  // the department list. A department keeps its colour everywhere it
  // appears, so the owner learns it once. Colours live in style.css
  // (.viz-consult and friends), never here.
  const DEPARTMENTS = [
    { key: "consultation", label: "Consultations", cls: "consult" },
    { key: "surgery", label: "Surgeries", cls: "surgery" },
    { key: "room", label: "Rooms", cls: "room" },
  ];

  const defaultRange = monthToDateRange();
  dateFromInput.value = defaultRange.from;
  dateToInput.value = defaultRange.to;

  // --- Formatting ---------------------------------------------------------

  // "189,020,000" is right for a table but hard to take in at a glance, so
  // headline sub-lines and chart labels use the short form: 189 mln.
  function shortMoney(value) {
    const n = Number(value);
    const abs = Math.abs(n);
    const fmt = (x, unit) => {
      const digits = x >= 100 ? 0 : 1;
      return `${Number(x.toFixed(digits)).toLocaleString("en-US")}${unit}`;
    };
    let text;
    if (abs >= 1e9) text = fmt(abs / 1e9, "B");
    else if (abs >= 1e6) text = fmt(abs / 1e6, "M");
    else if (abs >= 1e3) text = fmt(abs / 1e3, "K");
    else text = String(abs);
    return n < 0 ? `−${text}` : text;
  }

  function percent(part, whole) {
    const p = Number(whole) ? (Number(part) / Number(whole)) * 100 : 0;
    if (Math.abs(p) > 0 && Math.abs(p) < 1) return `${p < 0 ? "−" : ""}<1%`;
    return `${Math.round(p)}%`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svg(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  function moneyLine(value, className = "") {
    const span = el("span", `money ${className}`.trim());
    span.append(formatMoney(value));
    span.append(el("span", "money__unit", "so'm"));
    return span;
  }

  // A result is green while it is above zero and red below it — the same
  // rule the stat tiles and the pharmacy balance use. Nothing else on the
  // page is green or red.
  const signClass = (value) => (Number(value) >= 0 ? "is-positive" : "is-negative");

  // --- KPI row --------------------------------------------------------------

  function kpi(label, value, sub, extraClass = "") {
    const tile = el("article", `kpi ${extraClass}`.trim());
    tile.append(el("p", "kpi__label", label));
    tile.append(moneyLine(value, "kpi__value"));
    if (sub) tile.append(el("p", "kpi__sub", sub));
    return tile;
  }

  function daysInRange() {
    if (!dateFromInput.value || !dateToInput.value) return 0;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const to = parseDay(dateToInput.value);
    // A range that runs into the future (the whole of "Joriy oy") is
    // averaged over the days that have actually happened.
    const end = to > today ? today : to;
    const days = Math.round((end - parseDay(dateFromInput.value)) / 86400000) + 1;
    return Math.max(days, 0);
  }

  function renderKpis(f) {
    const row = $("kpi-row");
    row.innerHTML = "";
    const days = daysInRange();
    row.append(
      kpi("Total income", f.income,
        days > 0 ? `Average ${shortMoney(f.income / days)} a day` : "All time"),
      kpi("Clinic share", f.clinicShare,
        `${percent(f.clinicShare, f.income)} of income`, "kpi--accent"),
      kpi("Salaries and expenses", f.salaries + f.otherExpenses,
        `Salaries ${shortMoney(f.salaries)} · other ${shortMoney(f.otherExpenses)}`),
      kpi("Net remainder", f.net,
        f.income ? `${percent(f.net, f.income)} of income` : "", `kpi--result ${signClass(f.net)}`),
    );
  }

  // --- Where the money went -------------------------------------------------

  // Every so'm of income ends up in exactly one of these. They sum to the
  // total income by construction: the clinic share is income minus the
  // doctors' shares and the per-receipt costs, and the net is the clinic
  // share minus salaries and other expenses.
  function renderFlow(f) {
    const bar = $("flow-bar");
    const legend = $("flow-legend");
    const note = $("flow-note");
    bar.innerHTML = "";
    legend.innerHTML = "";
    note.classList.add("hidden");

    const parts = [
      { label: "Doctors' share", value: f.doctorShare, cls: "flow-doctor" },
      { label: "Receipt costs", value: f.receiptCosts, cls: "flow-receipt" },
      { label: "Salaries", value: f.salaries, cls: "flow-salary" },
      { label: "Other expenses", value: f.otherExpenses, cls: "flow-other" },
    ];
    if (f.net > 0) parts.push({ label: "Net remainder", value: f.net, cls: "flow-net" });

    // When costs exceed income the bar shows the costs, and the note says by
    // how much — a stacked bar cannot draw a negative remainder honestly.
    const whole = parts.reduce((sum, p) => sum + p.value, 0);

    if (!whole) {
      bar.append(el("span", "flow-bar__empty", "No data for this period"));
      return;
    }

    const described = [];
    for (const part of parts) {
      if (part.value <= 0) continue;
      const seg = el("span", `flow-bar__seg ${part.cls}`);
      seg.style.flexGrow = String(part.value);
      seg.title = `${part.label}: ${formatMoney(part.value)} so'm`;
      bar.append(seg);
      described.push(`${part.label} ${percent(part.value, whole)}`);
    }
    bar.setAttribute("aria-label", described.join(", "));

    for (const part of parts) {
      const item = el("li", "legend-list__item");
      const swatch = el("span", `swatch ${part.cls}`);
      swatch.setAttribute("aria-hidden", "true");
      item.append(swatch);
      item.append(el("span", "legend-list__label", part.label));
      item.append(moneyLine(part.value, "legend-list__value"));
      item.append(el("span", "legend-list__pct", percent(part.value, whole)));
      legend.append(item);
    }

    if (f.net < 0) {
      note.textContent =
        `Costs exceeded income by ${formatMoney(-f.net)} so'm, so this period closed at a loss.`;
      note.classList.remove("hidden");
    }
  }

  // --- Statement --------------------------------------------------------------

  function renderStatement(f) {
    const dl = $("statement");
    dl.innerHTML = "";

    const rows = [
      { label: "Total income", value: f.income, kind: "start" },
      { label: "Doctors' share", value: -f.doctorShare },
      { label: "Receipt costs", value: -f.receiptCosts },
      { label: "Clinic share", value: f.clinicShare, kind: "subtotal" },
      { label: "Salaries paid", value: -f.salaries },
      { label: "Income after salaries", value: f.afterSalaries, kind: "subtotal" },
      { label: "Other expenses", value: -f.otherExpenses },
      { label: "Net remainder", value: f.net, kind: "total" },
    ];

    for (const row of rows) {
      const line = el("div", `statement__row${row.kind ? ` statement__row--${row.kind}` : ""}`);
      const isDeduction = !row.kind;
      line.append(el("dt", "statement__label", (isDeduction ? "− " : "") + row.label));
      const dd = el("dd", "statement__value");
      const value = isDeduction ? -row.value : row.value;
      const money = moneyLine(value);
      if (row.kind === "total" || row.kind === "subtotal") money.classList.add(signClass(row.value));
      dd.append(money);
      line.append(dd);
      dl.append(line);
    }
  }

  // --- Departments ------------------------------------------------------------

  function renderDepartments(report) {
    const list = $("dept-list");
    list.innerHTML = "";
    const totalIncome = Number(report.total_income);
    const max = Math.max(...DEPARTMENTS.map((d) => Number(report[`${d.key}_income`])), 0);

    for (const dept of DEPARTMENTS) {
      const income = Number(report[`${dept.key}_income`]);
      const doctor = Number(report[`${dept.key}_doctor_share`]);
      const clinic = Number(report[`${dept.key}_clinic_profit`]);
      const costs = Number(report[`${dept.key}_expense`] || 0);

      const row = el("article", "dept");
      const head = el("div", "dept__head");
      const name = el("span", "dept__name");
      const swatch = el("span", `swatch viz-${dept.cls}`);
      swatch.setAttribute("aria-hidden", "true");
      name.append(swatch, dept.label);
      head.append(name);
      head.append(moneyLine(income, "dept__income"));
      head.append(el("span", "dept__share", percent(income, totalIncome)));
      row.append(head);

      const track = el("div", "dept__track");
      const fill = el("span", `dept__fill viz-${dept.cls}`);
      fill.style.width = max ? `${(income / max) * 100}%` : "0";
      track.append(fill);
      row.append(track);

      const facts = el("dl", "dept__facts");
      const fact = (label, value, cls = "") => {
        const wrap = el("div", "dept__fact");
        wrap.append(el("dt", "", label));
        const dd = el("dd", cls);
        dd.append(moneyLine(value));
        wrap.append(dd);
        facts.append(wrap);
      };
      fact("Doctor share", doctor);
      if (dept.key !== "room") fact("Receipt costs", costs);
      fact("Clinic share", clinic, signClass(clinic));
      const margin = el("div", "dept__fact");
      margin.append(el("dt", "", "Clinic keeps"));
      margin.append(el("dd", "", income ? percent(clinic, income) : "—"));
      facts.append(margin);
      row.append(facts);

      list.append(row);
    }
  }

  // --- Trend chart ------------------------------------------------------------

  let lastTrend = null;

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function parseDay(value) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function dayKey(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // The API returns only periods that have receipts; a chart that skipped
  // the quiet days would make a slow week look busy, so the gaps are filled
  // with zero bars. A range running into the future stops at today.
  function fillBuckets(trend) {
    const byKey = new Map(trend.points.map((p) => [p.period, p]));
    const empty = (period) => ({
      period, consultation_income: "0", surgery_income: "0", room_income: "0",
      total_income: "0", clinic_profit: "0",
    });

    const today = new Date();
    const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const first = dateFromInput.value
      ? parseDay(dateFromInput.value)
      : trend.points.length ? parseDay(trend.points[0].period) : null;
    let last = dateToInput.value
      ? parseDay(dateToInput.value)
      : trend.points.length ? parseDay(trend.points[trend.points.length - 1].period) : null;
    if (!first || !last) return [];
    if (last > todayDate) last = todayDate;

    const out = [];
    if (trend.group_by === "month") {
      let cursor = new Date(first.getFullYear(), first.getMonth(), 1);
      while (cursor <= last) {
        const key = dayKey(cursor);
        out.push(byKey.get(key) || empty(key));
        cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      }
    } else {
      let cursor = first;
      while (cursor <= last) {
        const key = dayKey(cursor);
        out.push(byKey.get(key) || empty(key));
        cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
      }
    }
    return out;
  }

  const UZ_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function bucketLabel(period, groupBy, long = false) {
    const d = parseDay(period);
    if (groupBy === "month") {
      return long
        ? `${UZ_MONTHS[d.getMonth()]} ${d.getFullYear()}`
        : `${UZ_MONTHS[d.getMonth()].slice(0, 3)} ${String(d.getFullYear()).slice(2)}`;
    }
    return long
      ? `${UZ_WEEKDAYS[d.getDay()]}, ${d.getDate()} ${UZ_MONTHS[d.getMonth()]}`
      : String(d.getDate());
  }

  // Round the axis top up so that each of its four gridlines lands on a
  // number people say out loud (a top of 24 gives 6, 12, 18, 24, never
  // 6.25), without leaving the top half of the chart empty.
  function niceMax(value) {
    if (value <= 0) return 1;
    const power = 10 ** Math.floor(Math.log10(value));
    for (const step of [1, 1.2, 1.6, 2, 2.4, 3.2, 4, 6, 8, 10]) {
      if (value <= step * power) return step * power;
    }
    return 10 * power;
  }

  // A bar segment with only its top corners rounded, so the stack reads as
  // one column sitting on the baseline.
  function topRoundedRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
  }

  function renderTrendLegend() {
    const legend = $("trend-legend");
    legend.innerHTML = "";
    for (const dept of DEPARTMENTS) {
      const item = el("li", "chart-legend__item");
      const swatch = el("span", `swatch viz-${dept.cls}`);
      swatch.setAttribute("aria-hidden", "true");
      item.append(swatch, dept.label);
      legend.append(item);
    }
  }

  function renderTrend(trend) {
    lastTrend = trend;
    const host = $("trend");
    const tooltip = $("trend-tooltip");
    const emptyNote = $("trend-empty");
    host.querySelector("svg")?.remove();
    tooltip.classList.add("hidden");

    $("trend-title").textContent = trend.group_by === "month" ? "Monthly income" : "Daily income";

    const buckets = fillBuckets(trend);
    const hasData = buckets.some((b) => Number(b.total_income) > 0);
    emptyNote.classList.toggle("hidden", hasData);
    host.classList.toggle("hidden", !hasData);
    if (!hasData) return;

    const width = Math.max(host.clientWidth, 280);
    const height = width < 600 ? 220 : 280;
    const m = { top: 24, right: 8, bottom: 28, left: width < 600 ? 44 : 56 };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;

    const totals = buckets.map((b) => Number(b.total_income));
    const top = niceMax(Math.max(...totals));
    const y = (v) => m.top + plotH - (v / top) * plotH;

    const chart = svg("svg", {
      class: "trend__svg",
      viewBox: `0 0 ${width} ${height}`,
      width: String(width),
      height: String(height),
      role: "img",
      "aria-label": `${$("trend-title").textContent}: ${buckets.length} bars`,
    });

    // Gridlines and y labels — recessive, four steps.
    for (let i = 0; i <= 4; i += 1) {
      const value = (top / 4) * i;
      const gy = y(value);
      chart.append(svg("line", {
        class: i === 0 ? "trend__baseline" : "trend__grid",
        x1: String(m.left), x2: String(width - m.right), y1: String(gy), y2: String(gy),
      }));
      const label = svg("text", {
        class: "trend__axis", x: String(m.left - 8), y: String(gy + 4), "text-anchor": "end",
      });
      label.textContent = i === 0 ? "0" : shortMoney(value).replace(" ", " ");
      chart.append(label);
    }

    const slot = plotW / buckets.length;
    const barW = Math.max(Math.min(slot * 0.62, 40), 3);
    const GAP = 2; // surface gap between stacked segments
    const labelEvery = Math.ceil(buckets.length / Math.max(Math.floor(plotW / 34), 1));
    const peakIndex = totals.indexOf(Math.max(...totals));
    const columns = [];

    buckets.forEach((bucket, i) => {
      const cx = m.left + slot * i + slot / 2;
      const x = cx - barW / 2;
      const group = svg("g", { class: "trend__col" });

      // Bottom to top in the fixed department order; the topmost non-empty
      // segment gets the rounded corners.
      const values = DEPARTMENTS.map((d) => Number(bucket[`${d.key}_income`]));
      const topSeg = values.reduce((acc, v, idx) => (v > 0 ? idx : acc), -1);
      let base = 0;
      values.forEach((v, idx) => {
        if (v <= 0) return;
        const y0 = y(base);
        const y1 = y(base + v);
        const h = Math.max(y0 - y1 - (idx === topSeg ? 0 : GAP), 1);
        const path = svg("path", {
          class: `trend__seg viz-${DEPARTMENTS[idx].cls}`,
          d: idx === topSeg ? topRoundedRect(x, y1, barW, h, 4) : `M${x},${y1 + GAP}h${barW}v${h}h${-barW}Z`,
        });
        group.append(path);
        base += v;
      });

      // Only the busiest bar carries its figure; the rest are in the tooltip.
      if (i === peakIndex && totals[i] > 0) {
        const peak = svg("text", {
          class: "trend__peak", x: String(cx), y: String(y(totals[i]) - 6), "text-anchor": "middle",
        });
        peak.textContent = shortMoney(totals[i]);
        group.append(peak);
      }

      if (i % labelEvery === 0) {
        const tick = svg("text", {
          class: "trend__axis", x: String(cx), y: String(height - 8), "text-anchor": "middle",
        });
        tick.textContent = bucketLabel(bucket.period, trend.group_by);
        group.append(tick);
      }

      // The hit target is the whole column, wider and taller than the bar,
      // so a thin bar or an empty day is still easy to point at.
      const hit = svg("rect", {
        class: "trend__hit",
        x: String(m.left + slot * i), y: String(m.top), width: String(slot), height: String(plotH),
        tabindex: "0",
        "aria-label": `${bucketLabel(bucket.period, trend.group_by, true)}: ${formatMoney(totals[i])} so'm`,
      });
      group.append(hit);
      chart.append(group);
      columns.push({ group, hit, bucket, cx });
    });

    host.append(chart);

    function show(index) {
      const { bucket, cx, group } = columns[index];
      columns.forEach((c) => c.group.classList.toggle("is-dim", c.group !== group));
      tooltip.innerHTML = "";
      tooltip.append(el("p", "trend__tip-title", bucketLabel(bucket.period, trend.group_by, true)));
      const list = el("dl", "trend__tip-list");
      for (const dept of [...DEPARTMENTS].reverse()) {
        const row = el("div", "trend__tip-row");
        const dt = el("dt");
        const swatch = el("span", `swatch viz-${dept.cls}`);
        swatch.setAttribute("aria-hidden", "true");
        dt.append(swatch, dept.label);
        row.append(dt, el("dd", "", formatMoney(bucket[`${dept.key}_income`])));
        list.append(row);
      }
      const total = el("div", "trend__tip-row trend__tip-row--total");
      total.append(el("dt", "", "Total"), el("dd", "", formatMoney(bucket.total_income)));
      const clinic = el("div", "trend__tip-row");
      clinic.append(el("dt", "", "Clinic share"), el("dd", "", formatMoney(bucket.clinic_profit)));
      list.append(total, clinic);
      tooltip.append(list);
      tooltip.classList.remove("hidden");

      // Keep the tooltip inside the chart: flip it to the left of the
      // column once it would run past the right edge.
      const scale = host.clientWidth / width;
      const tipW = tooltip.offsetWidth;
      let left = cx * scale + 12;
      if (left + tipW > host.clientWidth) left = cx * scale - tipW - 12;
      tooltip.style.left = `${Math.max(left, 0)}px`;
      tooltip.style.top = `${m.top * scale}px`;
    }

    function hide() {
      columns.forEach((c) => c.group.classList.remove("is-dim"));
      tooltip.classList.add("hidden");
    }

    columns.forEach((c, i) => {
      c.hit.addEventListener("mouseenter", () => show(i));
      c.hit.addEventListener("focus", () => show(i));
      c.hit.addEventListener("click", () => show(i)); // touch
      c.hit.addEventListener("blur", hide);
    });
    chart.addEventListener("mouseleave", hide);
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => lastTrend && renderTrend(lastTrend), 150);
  });

  // --- Active period button ---------------------------------------------------

  // The segmented control shows which preset the dates currently match, so
  // a range typed by hand simply leaves every button unselected.
  const presetButtons = {
    current: $("current-month-btn"),
    previous: $("previous-month-btn"),
    week: $("last-week-btn"),
    all: $("filter-clear-btn"),
  };

  function syncPresets() {
    const from = dateFromInput.value;
    const to = dateToInput.value;
    const same = (r) => r.from === from && r.to === to;
    const current = firstAndLastOfMonth(0);
    const monthToDate = monthToDateRange();
    const active = {
      current: same(current) || same(monthToDate),
      previous: same(firstAndLastOfMonth(-1)),
      week: same(lastWeekRange()),
      all: !from && !to,
    };
    for (const [key, button] of Object.entries(presetButtons)) {
      button.setAttribute("aria-pressed", String(active[key]));
    }
  }

  // Ranges longer than about two months read better as monthly bars than
  // as sixty slivers.
  function groupBy() {
    if (!dateFromInput.value || !dateToInput.value) return "month";
    const span = (parseDay(dateToInput.value) - parseDay(dateFromInput.value)) / 86400000;
    return span > 62 ? "month" : "day";
  }

  // --- Load -------------------------------------------------------------------

  // Clicking presets quickly starts several loads at once; only the latest
  // one is allowed to draw, so a slow earlier response can never overwrite
  // the period the owner picked last.
  let loadSeq = 0;

  async function loadReport() {
    const seq = ++loadSeq;
    errorContainer.innerHTML = "";
    syncPresets();

    const params = dateRangeParams(dateFromInput, dateToInput);
    const trendParams = dateRangeParams(dateFromInput, dateToInput, { group_by: groupBy() });

    try {
      const [report, salaryTotal, expensesSummary, trend] = await Promise.all([
        apiFetch(`/reports/total?${params.toString()}`),
        apiFetch(`/salary/total-paid?${params.toString()}`),
        apiFetch(`/expenses/summary?${params.toString()}`),
        apiFetch(`/reports/trend?${trendParams.toString()}`),
      ]);
      if (seq !== loadSeq) return;

      // Klinika ulushi is what the clinic keeps once the doctors' shares
      // and the per-receipt costs are out, so it is the only figure salaries
      // and other expenses can honestly be taken out of. Amounts are whole
      // so'm, well inside the range a JS number holds exactly.
      const f = {
        income: Number(report.total_income),
        doctorShare: Number(report.total_doctor_share),
        receiptCosts: Number(report.total_expense),
        clinicShare: Number(report.total_clinic_profit),
        salaries: Number(salaryTotal.total_paid),
        otherExpenses: Number(expensesSummary.total_amount),
      };
      f.afterSalaries = f.clinicShare - f.salaries;
      f.net = f.afterSalaries - f.otherExpenses;

      renderKpis(f);
      renderFlow(f);
      renderStatement(f);
      renderDepartments(report);
      renderTrend(trend);
    } catch (err) {
      if (seq !== loadSeq) return;
      showError(errorContainer, err.detail || err.message || "Could not load the dashboard");
    }
  }

  $("range-form").addEventListener("submit", (event) => {
    event.preventDefault();
    loadReport();
  });

  attachMonthShortcuts({
    fromInput: dateFromInput,
    toInput: dateToInput,
    currentBtn: presetButtons.current,
    previousBtn: presetButtons.previous,
    lastWeekBtn: presetButtons.week,
    clearBtn: presetButtons.all,
    labelEl: $("period-label"),
    onApply: loadReport,
  });
  dateFromInput.addEventListener("change", syncPresets);
  dateToInput.addEventListener("change", syncPresets);

  renderTrendLegend();
  loadReport();
})();
