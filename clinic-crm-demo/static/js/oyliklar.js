(async function () {
  const user = await initPage({ allowedRoles: ["superadmin", "manager"] });
  if (!user) return;

  const errorContainer = document.getElementById("error-container");
  const successContainer = document.getElementById("success-container");

  const staffSelects = [
    "balance_staff",
    "pay_staff",
    "history_staff",
  ].map((id) => document.getElementById(id));

  const roleLabels = { doctor: "Doctor", nurse: "Nurse", other: "Other" };
  const typeLabels = { full: "Full salary", avans: "Advance" };

  attachMoneyInput(document.getElementById("pay_amount"));

  let staffNameById = {};
  let historyPage = 1;
  const historyPageSize = 20;

  function clearMessages() {
    errorContainer.innerHTML = "";
    successContainer.innerHTML = "";
  }

  function showSuccess(message) {
    successContainer.innerHTML = "";
    const box = document.createElement("div");
    box.className = "success-box";
    box.textContent = message;
    successContainer.appendChild(box);
  }

  async function loadStaffOptions() {
    const options = await apiFetch("/staff/options");
    staffNameById = Object.fromEntries(options.map((s) => [s.id, s.name]));

    staffSelects.forEach((select) => {
      const keepFirst = select.id === "balance_staff" || select.id === "history_staff";
      select.innerHTML = keepFirst ? '<option value="">— all —</option>' : "";
      options.forEach((opt) => {
        const el = document.createElement("option");
        el.value = opt.id;
        el.textContent = `${opt.name} (${roleLabels[opt.role] || opt.role})`;
        select.appendChild(el);
      });
    });
  }

  // --- Balance ---

  // firstAndLastOfMonth() and lastWeekRange() live in nav.js,
  // shared with the date shortcuts on every other page with a date filter.
  function applyBalanceRange({ from, to }) {
    document.getElementById("balance_from").value = from;
    document.getElementById("balance_to").value = to;
    loadBalance();
  }

  function applyMonthShortcut(offsetMonths) {
    applyBalanceRange(firstAndLastOfMonth(offsetMonths));
  }

  // Always reflects whatever range loadBalance() is about to query, whether
  // set by a shortcut button or typed manually. Blank dates mean all time,
  // so the label is empty then, as on every other page.
  function updateBalancePeriodLabel() {
    document.getElementById("balance-period-label").textContent = monthPeriodLabel(
      document.getElementById("balance_from").value,
      document.getElementById("balance_to").value,
    );
  }

  async function loadBalance() {
    const tbody = document.getElementById("balance-tbody");
    tbody.innerHTML = "";
    clearMessages();
    updateBalancePeriodLabel();

    const params = new URLSearchParams();
    const staffId = document.getElementById("balance_staff").value;
    const from = document.getElementById("balance_from").value;
    const to = document.getElementById("balance_to").value;
    if (staffId) params.set("staff_id", staffId);
    if (from) params.set("date_from", from);
    if (to) params.set("date_to", to);

    try {
      const items = await withLoading(tbody.closest("table"), () => apiFetch(`/salary/balance?${params.toString()}`));
      if (items.length === 0) {
        renderEmpty(tbody, columnCount(tbody.closest("table")), "No data for this period");
        return;
      }
      items.forEach((row) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${escapeHtml(row.name)}</td>
          <td>${roleLabels[row.role] || row.role}</td>
          <td class="num">${formatMoney(row.earned)}</td>
          <td class="num">${formatMoney(row.paid)}</td>
          <td class="num">${formatMoney(row.remaining)}</td>
        `;
        tbody.appendChild(tr);
      });
    } catch (err) {
      showError(errorContainer, err.detail || err.message || "Could not load the balance");
    }
  }

  document.getElementById("current-month-btn").addEventListener("click", () => applyMonthShortcut(0));
  document.getElementById("previous-month-btn").addEventListener("click", () => applyMonthShortcut(-1));
  document.getElementById("last-week-btn").addEventListener("click", () => applyBalanceRange(lastWeekRange()));
  // Blank dates mean all time.
  document.getElementById("filter-clear-btn").addEventListener("click", () => {
    document.getElementById("balance_staff").value = "";
    applyBalanceRange({ from: "", to: "" });
  });

  document.getElementById("balance-form").addEventListener("submit", (event) => {
    event.preventDefault();
    loadBalance();
  });

  // --- Payment entry ---
  // A payment is always for one whole calendar month: the month and year
  // picked here become period_start (the 1st) and period_end (the last day).
  const payMonthSelect = document.getElementById("pay_month");
  const payYearSelect = document.getElementById("pay_year");

  function fillPayPeriodOptions() {
    const now = new Date();
    UZ_MONTHS.forEach((name, index) => {
      const opt = new Option(name, index + 1);
      // defaultSelected, so the form's reset() after saving returns here too.
      opt.defaultSelected = index === now.getMonth();
      payMonthSelect.appendChild(opt);
    });
    for (let year = now.getFullYear() - 3; year <= now.getFullYear() + 1; year++) {
      const opt = new Option(year, year);
      opt.defaultSelected = year === now.getFullYear();
      payYearSelect.appendChild(opt);
    }
  }
  fillPayPeriodOptions();

  function selectedPayPeriod() {
    const year = Number(payYearSelect.value);
    const month = Number(payMonthSelect.value);
    return {
      period_start: toDateInputValue(new Date(year, month - 1, 1)),
      period_end: toDateInputValue(new Date(year, month - 1, daysInMonth(year, month))),
    };
  }

  document.getElementById("payment-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    clearMessages();

    const payload = {
      staff_id: Number(document.getElementById("pay_staff").value),
      payment_type: document.getElementById("pay_type").value,
      ...selectedPayPeriod(),
      amount: moneyInputValue(document.getElementById("pay_amount")),
    };

    try {
      await apiFetch("/salary/payments", { method: "POST", body: payload });
      document.getElementById("payment-form").reset();
      await Promise.all([loadBalance(), loadHistory()]);
      showSuccess("Payment added");
    } catch (err) {
      showError(errorContainer, err.detail || err.message || "Could not save the payment");
    }
  });

  // --- History ---
  async function voidPayment(id) {
    if (!confirm("Void this payment?")) return;
    clearMessages();
    try {
      await apiFetch(`/salary/payments/${id}/void`, { method: "POST" });
      await Promise.all([loadBalance(), loadHistory()]);
      showSuccess("Payment voided");
    } catch (err) {
      showError(errorContainer, err.detail || err.message || "Could not void the record");
    }
  }


  async function loadHistory() {
    const tbody = document.getElementById("history-tbody");
    const pagination = document.getElementById("history-pagination");
    tbody.innerHTML = "";
    pagination.innerHTML = "";
    clearMessages();

    const params = new URLSearchParams({ page: historyPage, page_size: historyPageSize });
    const staffId = document.getElementById("history_staff").value;
    const from = document.getElementById("history_from").value;
    const to = document.getElementById("history_to").value;
    if (staffId) params.set("staff_id", staffId);
    if (from) params.set("date_from", from);
    if (to) params.set("date_to", to);

    try {
      const data = await withLoading(tbody.closest("table"), () => apiFetch(`/salary/payments?${params.toString()}`));

      if (data.items.length === 0) {
        renderEmpty(tbody, columnCount(tbody.closest("table")), "No records found");
      }
      data.items.forEach((payment) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${formatDateTime(payment.paid_at)}</td>
          <td>${escapeHtml(staffNameById[payment.staff_id] || "—")}</td>
          <td>${typeLabels[payment.payment_type] || payment.payment_type}</td>
          <td>${periodText(payment.period_start, payment.period_end)}</td>
          <td class="num">${formatMoney(payment.amount)}</td>
          <td class="actions-cell"><button class="danger void-btn" data-id="${payment.id}">Cancel</button></td>
        `;
        tbody.appendChild(tr);
      });

      tbody.querySelectorAll(".void-btn").forEach((btn) => {
        btn.addEventListener("click", () => voidPayment(btn.dataset.id));
      });

      pagination.innerHTML = `
        <button class="secondary" id="history-prev" ${historyPage <= 1 ? "disabled" : ""}>Previous</button>
        <span>${paginationLabel(data)}</span>
        <button class="secondary" id="history-next" ${historyPage >= data.pages ? "disabled" : ""}>Next</button>
      `;
      const prevBtn = document.getElementById("history-prev");
      const nextBtn = document.getElementById("history-next");
      if (prevBtn) prevBtn.addEventListener("click", () => { historyPage -= 1; loadHistory(); });
      if (nextBtn) nextBtn.addEventListener("click", () => { historyPage += 1; loadHistory(); });
    } catch (err) {
      showError(errorContainer, err.detail || err.message || "Could not load the history");
    }
  }

  document.getElementById("history-filter-form").addEventListener("submit", (event) => {
    event.preventDefault();
    historyPage = 1;
    loadHistory();
  });

  attachMonthShortcuts({
    fromInput: document.getElementById("history_from"),
    toInput: document.getElementById("history_to"),
    currentBtn: document.getElementById("history-current-month-btn"),
    previousBtn: document.getElementById("history-previous-month-btn"),
    lastWeekBtn: document.getElementById("history-last-week-btn"),
    clearBtn: document.getElementById("history-clear-btn"),
    labelEl: document.getElementById("history-period-label"),
    onClear: () => {
      document.getElementById("history_staff").value = "";
    },
    onApply: () => {
      historyPage = 1;
      loadHistory();
    },
  });

  await loadStaffOptions();
  // The balance opens on the current month, as it always has; "Tozalash"
  // widens it to all time.
  const openingRange = firstAndLastOfMonth(0);
  document.getElementById("balance_from").value = openingRange.from;
  document.getElementById("balance_to").value = openingRange.to;
  await Promise.all([loadBalance(), loadHistory()]);
})();
