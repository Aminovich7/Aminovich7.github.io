(async function () {
  const user = await initPage({ allowedRoles: ["superadmin", "manager"] });
  if (!user) return;

  const dateFromInput = document.getElementById("date_from");
  const dateToInput = document.getElementById("date_to");
  const errorContainer = document.getElementById("error-container");
  const heroCard = document.getElementById("hero-card");
  const summaryCards = document.getElementById("summary-cards");
  const sectionCards = document.getElementById("section-cards");
  const payrollExpenseCards = document.getElementById("payroll-expense-cards");

  // Local calendar arithmetic via monthToDateRange() (nav.js) — see the note
  // on toDateInputValue() for why toISOString() must not be used here.
  const defaultRange = monthToDateRange();
  dateFromInput.value = defaultRange.from;
  dateToInput.value = defaultRange.to;

  // `variant` picks the tile's meaning (see .stat-card--* in style.css) and
  // `modifiers` the treatment — "filled" tints the whole tile. Figures are
  // near-black by default; the only coloured numbers on this page are the
  // three results, and they are green or red purely according to their sign.
  function statCard(label, value, variant, modifiers = []) {
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

  // A profit figure is only good news while it is above zero, so the hue is
  // read off the sign rather than fixed at the call site. Same rule the
  // pharmacy balance already uses.
  const profitVariant = (value) => (Number(value) >= 0 ? "success" : "danger");

  async function loadReport() {
    errorContainer.innerHTML = "";
    heroCard.innerHTML = "";
    summaryCards.innerHTML = "";
    sectionCards.innerHTML = "";
    payrollExpenseCards.innerHTML = "";

    const params = dateRangeParams(dateFromInput, dateToInput);

    try {
      const [report, salaryTotal, expensesSummary] = await Promise.all([
        apiFetch(`/reports/total?${params.toString()}`),
        apiFetch(`/salary/total-paid?${params.toString()}`),
        apiFetch(`/expenses/summary?${params.toString()}`),
      ]);

      // Klinika ulushi leads the page — it's the figure the dashboard exists
      // to answer, so it gets the full-width tinted hero tile rather than
      // sitting fourth in a row of four identical ones.
      heroCard.appendChild(
        statCard("Klinika ulushi", report.total_clinic_profit,
          profitVariant(report.total_clinic_profit), ["filled", "hero"])
      );

      // The three figures the profit is built from are one group, so they
      // share one colour instead of splitting into three unrelated hues.
      summaryCards.appendChild(statCard("Umumiy daromad", report.total_income, "primary"));
      summaryCards.appendChild(statCard("Shifokor ulushi", report.total_doctor_share, "primary"));
      summaryCards.appendChild(statCard("Xarajatlar", report.total_expense, "primary"));

      // One shared tint marks these three as a group; which department each
      // one is comes from its label, not from giving it its own colour.
      sectionCards.appendChild(statCard("Ko'riklar daromadi", report.consultation_income, "primary", ["filled"]));
      sectionCards.appendChild(statCard("Operatsiyalar daromadi", report.surgery_income, "primary", ["filled"]));
      sectionCards.appendChild(statCard("Xonalar daromadi", report.room_income, "primary", ["filled"]));

      // These two run on from the hero tile, not from Umumiy daromad: Klinika
      // ulushi is what the clinic actually keeps once the doctors' shares and
      // the per-receipt xarajat are out, so it is the only figure salaries and
      // other expenses can honestly be taken out of. Starting from
      // total_income double-counted money that was never the clinic's.
      //
      // The four tiles read as one running total —
      //   Klinika ulushi − ish haqi        = ish haqidan keyingi daromad
      //   ... − boshqa harajatlar          = ish haqi va harajatlardan keyingi
      // — so the last tile is net of both, as its label says.
      const incomeAfterSalary = Number(report.total_clinic_profit) - Number(salaryTotal.total_paid);
      const incomeAfterAll = incomeAfterSalary - Number(expensesSummary.total_amount);

      payrollExpenseCards.appendChild(statCard("Jami ish haqi to'lovlari", salaryTotal.total_paid, "primary"));
      payrollExpenseCards.appendChild(statCard("Ish haqidan keyingi daromad", incomeAfterSalary, profitVariant(incomeAfterSalary)));
      payrollExpenseCards.appendChild(statCard("Jami boshqa harajatlar", expensesSummary.total_amount, "primary"));
      payrollExpenseCards.appendChild(statCard("Ish haqi va harajatlardan keyingi daromad", incomeAfterAll, profitVariant(incomeAfterAll)));
    } catch (err) {
      showError(errorContainer, err.detail || err.message || "Boshqaruv panelini yuklashda xatolik");
    }
  }

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

  loadReport();
})();
