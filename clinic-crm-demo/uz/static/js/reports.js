(async function () {
  const user = await initPage({ allowedRoles: ["superadmin", "manager"] });
  if (!user) return;

  const errorContainer = document.getElementById("error-container");
  const summaryEl = document.getElementById("report-summary");
  const totalEl = document.getElementById("report-total");
  const doctorTbody = document.getElementById("doctor-tbody");
  const doctorThead = document.getElementById("doctor-thead");
  const dateFromInput = document.getElementById("date_from");
  const dateToInput = document.getElementById("date_to");
  const exportBtn = document.getElementById("export-btn");
  const doctorSelectCard = document.getElementById("doctor-select-card");
  const doctorSelect = document.getElementById("report-doctor-select");

  let activeReport = "total";

  // Local calendar arithmetic via monthToDateRange() (nav.js) — see the note
  // on toDateInputValue() for why toISOString() must not be used here.
  const defaultRange = monthToDateRange();
  dateFromInput.value = defaultRange.from;
  dateToInput.value = defaultRange.to;

  async function loadDoctorSelectOptions() {
    try {
      const options = await apiFetch("/staff/options?role=doctor");
      doctorSelect.innerHTML = '<option value="">— shifokorni tanlang —</option>';
      options.forEach((doc) => {
        const opt = document.createElement("option");
        opt.value = doc.id;
        opt.textContent = doc.name;
        doctorSelect.appendChild(opt);
      });
    } catch (err) {
      showError(errorContainer, err.detail || err.message || "Shifokorlar ro'yxatini yuklashda xatolik");
    }
  }

  document.querySelectorAll(".report-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeReport = btn.dataset.report;
      document.querySelectorAll(".report-tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      doctorSelectCard.classList.toggle("hidden", activeReport !== "doctor");
      exportBtn.classList.toggle("hidden", activeReport === "doctor");
      loadReport();
    });
  });

  doctorSelect.addEventListener("change", () => {
    if (activeReport === "doctor") loadReport();
  });

  // The same labels repeat across all five report tabs, so the presentation
  // is derived from the label rather than passed at each call site — that
  // keeps a given figure identical on every tab automatically, and identical
  // to the same figure on Boshqaruv paneli.
  //
  // `variant` is the tile's meaning, `modifiers` the treatment: "filled"
  // tints the whole tile to bind a group together. Every figure here is
  // near-black — only the total below them is allowed a colour.
  const STYLE_BY_LABEL = {
    "Umumiy daromad":         ["primary", []],
    "Shifokor ulushi":        ["primary", []],
    "Xarajatlar":             ["primary", []],
    "Ko'riklardan ulush":     ["primary", ["filled"]],
    "Operatsiyalardan ulush": ["primary", ["filled"]],
    "Xonalardan ulush":       ["primary", ["filled"]],
  };

  // The figure a tab exists to answer. It is green while positive and red
  // once it goes negative — the sign is the thing worth seeing from across
  // the room — and it renders full width below the figures it is built from,
  // the same shape Boshqaruv paneli gives Klinika ulushi.
  const TOTAL_LABELS = new Set(["Klinika ulushi", "Jami ulush"]);

  // Totals live in a grid of their own so a full-width tile cannot leave a
  // hole in the row above it once the screen is wide enough for a fourth
  // column.
  const containerFor = (label) => (TOTAL_LABELS.has(label) ? totalEl : summaryEl);

  function statCard(label, value) {
    const [variant, modifiers] = TOTAL_LABELS.has(label)
      ? [Number(value) >= 0 ? "success" : "danger", ["filled", "hero"]]
      : (STYLE_BY_LABEL[label] || [null, []]);

    const div = document.createElement("div");
    div.className = [
      "stat-card",
      variant ? `stat-card--${variant}` : "",
      ...modifiers.map((m) => `stat-card--${m}`),
    ].filter(Boolean).join(" ");
    div.innerHTML =
      `<div class="label">${label}</div>` +
      `<div class="value">${formatMoney(value)}<span class="unit">so'm</span></div>`;
    return div;
  }

  const SUMMARY_FIELDS = {
    total: [
      ["Umumiy daromad", "total_income"],
      ["Shifokor ulushi", "total_doctor_share"],
      ["Xarajatlar", "total_expense"],
      ["Klinika ulushi", "total_clinic_profit"],
    ],
    consultations: [
      ["Umumiy daromad", "total_income"],
      ["Shifokor ulushi", "total_doctor_share"],
      ["Xarajatlar", "total_consultation_expense"],
      ["Klinika ulushi", "total_clinic_profit"],
    ],
    surgeries: [
      ["Umumiy daromad", "surgery_total_income"],
      ["Shifokor ulushi", "surgery_total_doctor_share"],
      ["Xarajatlar", "surgery_total_expense"],
      ["Klinika ulushi", "surgery_total_clinic_profit"],
    ],
    rooms: [
      ["Umumiy daromad", "room_total_income"],
      ["Shifokor ulushi", "room_total_doctor_share"],
      ["Klinika ulushi", "room_total_clinic_profit"],
    ],
  };

  const DOCTOR_SHARE_KEYS = {
    total: null,
    consultations: "doctor_shares",
    surgeries: "surgery_doctor_shares",
    rooms: "room_doctor_shares",
  };

  const DOCTOR_TABLE_HEADER = "<tr><th>Shifokor</th><th class=\"num\">Ulush jami</th><th class=\"num\">Yozuvlar soni</th></tr>";

  function renderDoctorTable(report) {
    doctorThead.innerHTML = DOCTOR_TABLE_HEADER;
    doctorTbody.innerHTML = "";
    const key = DOCTOR_SHARE_KEYS[activeReport];
    if (!key) {
      doctorThead.parentElement.parentElement.classList.add("hidden");
      return;
    }
    doctorThead.parentElement.parentElement.classList.remove("hidden");
    (report[key] || []).forEach((entry) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(entry.name)}</td><td class="num">${formatMoney(entry.total_share)}</td><td class="num">${entry.count}</td>`;
      doctorTbody.appendChild(tr);
    });
  }

  // "Shifokor bo'yicha" tab: there's no single backend endpoint for a
  // doctor's combined earnings, so this pulls the three section reports
  // for the same date range (already broken down per doctor, per §3's
  // batch-loaded doctor_shares) and picks out the one doctor's row from
  // each — no new backend endpoint needed.
  async function loadDoctorReport() {
    const doctorId = doctorSelect.value;
    doctorThead.parentElement.parentElement.classList.remove("hidden");

    if (!doctorId) {
      doctorThead.innerHTML = DOCTOR_TABLE_HEADER;
      doctorTbody.innerHTML = "";
      totalEl.innerHTML = "";
      summaryEl.innerHTML = '<p class="muted">Hisobotni ko\'rish uchun shifokorni tanlang.</p>';
      return;
    }

    const params = dateRangeParams(dateFromInput, dateToInput);

    try {
      const [consultations, surgeries, rooms] = await Promise.all([
        apiFetch(`/reports/consultations?${params.toString()}`),
        apiFetch(`/reports/surgeries?${params.toString()}`),
        apiFetch(`/reports/rooms?${params.toString()}`),
      ]);

      const findShare = (list) => (list || []).find((e) => String(e.doctor_id) === doctorId);
      const cEntry = findShare(consultations.doctor_shares);
      const sEntry = findShare(surgeries.surgery_doctor_shares);
      const rEntry = findShare(rooms.room_doctor_shares);

      const cShare = Number(cEntry?.total_share || 0);
      const sShare = Number(sEntry?.total_share || 0);
      const rShare = Number(rEntry?.total_share || 0);
      const cCount = cEntry?.count || 0;
      const sCount = sEntry?.count || 0;
      const rCount = rEntry?.count || 0;

      [
        ["Ko'riklardan ulush", cShare],
        ["Operatsiyalardan ulush", sShare],
        ["Xonalardan ulush", rShare],
        ["Jami ulush", cShare + sShare + rShare],
      ].forEach(([label, value]) => containerFor(label).appendChild(statCard(label, value)));

      doctorThead.innerHTML = "<tr><th>Bo'lim</th><th class=\"num\">Ulush</th><th class=\"num\">Yozuvlar soni</th></tr>";
      doctorTbody.innerHTML = "";
      [
        ["Ko'riklar", cShare, cCount],
        ["Operatsiyalar", sShare, sCount],
        ["Xonalar", rShare, rCount],
      ].forEach(([label, share, count]) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${label}</td><td class="num">${formatMoney(share)}</td><td class="num">${count}</td>`;
        doctorTbody.appendChild(tr);
      });
    } catch (err) {
      showError(errorContainer, err.detail || err.message || "Shifokor hisobotini yuklashda xatolik");
    }
  }

  async function loadReport() {
    errorContainer.innerHTML = "";
    summaryEl.innerHTML = "";
    totalEl.innerHTML = "";

    if (activeReport === "doctor") {
      await loadDoctorReport();
      return;
    }

    const params = dateRangeParams(dateFromInput, dateToInput);

    try {
      const report = await apiFetch(`/reports/${activeReport}?${params.toString()}`);

      SUMMARY_FIELDS[activeReport].forEach(([label, field]) => {
        containerFor(label).appendChild(statCard(label, report[field]));
      });

      renderDoctorTable(report);
    } catch (err) {
      showError(errorContainer, err.detail || err.message || "Hisobotni yuklashda xatolik");
    }
  }

  exportBtn.addEventListener("click", async () => {
    const params = dateRangeParams(dateFromInput, dateToInput, { format: "xlsx" });
    try {
      await apiDownload(`/reports/${activeReport}?${params.toString()}`);
    } catch (err) {
      showError(errorContainer, err.detail || err.message || "Hisobotni eksport qilishda xatolik");
    }
  });

  document.getElementById("range-form").addEventListener("submit", (event) => {
    event.preventDefault();
    loadReport();
  });

  attachMonthShortcuts({
    fromInput: dateFromInput,
    toInput: dateToInput,
    currentBtn: document.getElementById("current-month-btn"),
    previousBtn: document.getElementById("previous-month-btn"),
    lastWeekBtn: document.getElementById("last-week-btn"),
    clearBtn: document.getElementById("filter-clear-btn"),
    labelEl: document.getElementById("period-label"),
    onApply: loadReport,
  });

  await loadDoctorSelectOptions();
  loadReport();
})();
