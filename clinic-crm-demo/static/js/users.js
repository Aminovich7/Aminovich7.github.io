(async function () {
  const user = await initPage({ allowedRoles: ["superadmin", "manager"] });
  if (!user) return;

  const isSuperadmin = user.role === "superadmin";
  const isManager = user.role === "manager";

  const errorContainer = document.getElementById("error-container");
  const successContainer = document.getElementById("success-container");

  // prefix -> Uzbek noun forms, since "manager"/"assistant" can't just be
  // capitalized like in English.
  const LABELS = {
    manager: { noun: "Manager", article: "this manager" },
    assistant: { noun: "Assistant", article: "this assistant" },
  };

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

  // ---------------------------------------------------------------------
  // Generic list+create+edit+block/unblock wiring, shared by the Managers
  // and Assistants sections — they differ only in endpoint prefix and
  // which roles may create/edit/block (both call this with their own
  // config).
  // ---------------------------------------------------------------------
  function setupUserSection({ prefix, listEndpoint, canManage }) {
    const label = LABELS[prefix];
    const tbody = document.getElementById(`${prefix}s-tbody`);
    const pagination = document.getElementById(`${prefix}s-pagination`);
    const formCard = document.getElementById(`${prefix}-form-card`);
    const form = document.getElementById(`${prefix}-form`);
    const addBtn = document.getElementById(`${prefix}-add-btn`);
    const cancelBtn = document.getElementById(`${prefix}-cancel-btn`);
    const formTitle = document.getElementById(`${prefix}-form-title`);
    const passwordNote = document.getElementById(`${prefix}-password-note`);
    const idInput = document.getElementById(`${prefix}-id`);
    const usernameInput = document.getElementById(`${prefix}-username`);
    const fullNameInput = document.getElementById(`${prefix}-full-name`);
    const passwordInput = document.getElementById(`${prefix}-password`);

    let page = 1;
    const pageSize = 20;

    if (!canManage) {
      addBtn.classList.add("hidden");
    }

    passwordNote.textContent =
      "Editing an account always needs a new password (at least 8 characters) — the API does not support partial updates of manager or assistant details.";

    function openForm(person = null) {
      form.reset();
      idInput.value = person ? person.id : "";
      usernameInput.value = person ? person.username : "";
      fullNameInput.value = person ? person.full_name : "";
      formTitle.textContent = person ? `Edit ${label.noun.toLowerCase()}` : `Add ${label.noun.toLowerCase()}`;
      formCard.classList.remove("hidden");
    }

    function closeForm() {
      formCard.classList.add("hidden");
      form.reset();
    }

    addBtn.addEventListener("click", () => openForm());
    cancelBtn.addEventListener("click", closeForm);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearMessages();

      const id = idInput.value;
      const payload = {
        username: usernameInput.value,
        full_name: fullNameInput.value,
        password: passwordInput.value,
      };

      try {
        const isUpdate = Boolean(id);
        if (isUpdate) {
          await apiFetch(`${listEndpoint}/${id}`, { method: "PATCH", body: payload });
        } else {
          await apiFetch(listEndpoint, { method: "POST", body: payload });
        }
        closeForm();
        await loadList();
        showSuccess(isUpdate ? `${label.noun} updated` : `${label.noun} added`);
      } catch (err) {
        showError(errorContainer, err.detail || err.message || `Could not save the ${label.noun.toLowerCase()}`);
      }
    });

    async function setStatus(id, action) {
      const question =
        action === "block"
          ? `Block ${label.article}?`
          : `Unblock ${label.article}?`;
      if (!confirm(question)) return;
      clearMessages();
      try {
        await apiFetch(`${listEndpoint}/${id}/${action}`, { method: "POST" });
        await loadList();
        showSuccess(action === "block" ? `${label.noun} blocked` : `${label.noun} unblocked`);
      } catch (err) {
        const failMsg =
          action === "block" ? `Could not block the ${label.noun.toLowerCase()}` : `Could not unblock the ${label.noun.toLowerCase()}`;
        showError(errorContainer, err.detail || err.message || failMsg);
      }
    }

    async function loadList() {
      clearMessages();
      tbody.innerHTML = "";
      pagination.innerHTML = "";

      const params = new URLSearchParams({ page, page_size: pageSize });
      try {
        const data = await withLoading(tbody.closest("table"), () => apiFetch(`${listEndpoint}?${params.toString()}`));

        if (data.items.length === 0) {
          renderEmpty(tbody, columnCount(tbody.closest("table")), "No records found");
        }
        data.items.forEach((person) => {
          const tr = document.createElement("tr");
          const isBlocked = person.status === "blocked";
          const actions = [];
          if (canManage) {
            actions.push(`<button class="secondary edit-btn" data-id="${person.id}">Edit</button>`);
            if (isBlocked) {
              actions.push(`<button class="secondary unblock-btn" data-id="${person.id}">Unblock</button>`);
            } else {
              actions.push(`<button class="danger block-btn" data-id="${person.id}">Block</button>`);
            }
          }
          tr.innerHTML = `
            <td>${escapeHtml(person.username)}</td>
            <td>${escapeHtml(person.full_name)}</td>
            <td>${isBlocked ? "blocked" : "active"}</td>
            <td class="actions-cell">${actions.join("")}</td>
          `;
          tbody.appendChild(tr);
        });

        tbody.querySelectorAll(".edit-btn").forEach((btn) => {
          btn.addEventListener("click", () => {
            const person = data.items.find((p) => String(p.id) === btn.dataset.id);
            openForm(person);
          });
        });
        tbody.querySelectorAll(".block-btn").forEach((btn) => {
          btn.addEventListener("click", () => setStatus(btn.dataset.id, "block"));
        });
        tbody.querySelectorAll(".unblock-btn").forEach((btn) => {
          btn.addEventListener("click", () => setStatus(btn.dataset.id, "unblock"));
        });

        pagination.innerHTML = `
          <button class="secondary" id="${prefix}-prev-page" ${page <= 1 ? "disabled" : ""}>Previous</button>
          <span>${paginationLabel(data)}</span>
          <button class="secondary" id="${prefix}-next-page" ${page >= data.pages ? "disabled" : ""}>Next</button>
        `;
        const prevBtn = document.getElementById(`${prefix}-prev-page`);
        const nextBtn = document.getElementById(`${prefix}-next-page`);
        if (prevBtn) prevBtn.addEventListener("click", () => { page -= 1; loadList(); });
        if (nextBtn) nextBtn.addEventListener("click", () => { page += 1; loadList(); });
      } catch (err) {
        showError(errorContainer, err.detail || err.message || `Could not load the ${label.noun.toLowerCase()}s`);
      }
    }

    loadList();
  }

  // ---------------------------------------------------------------------
  // Managers section — superadmin only (matches create/block/unblock's
  // require_roles(SUPERADMIN) gate in app/users/router.py).
  // ---------------------------------------------------------------------
  if (isSuperadmin) {
    document.getElementById("managers-section").classList.remove("hidden");
    setupUserSection({
      prefix: "manager",
      listEndpoint: "/users/managers",
      canManage: true,
    });
  }

  // ---------------------------------------------------------------------
  // Assistants section — superadmin and manager (matches
  // require_roles(SUPERADMIN, MANAGER) on every assistant endpoint).
  // ---------------------------------------------------------------------
  if (isSuperadmin || isManager) {
    document.getElementById("assistants-section").classList.remove("hidden");
    setupUserSection({
      prefix: "assistant",
      listEndpoint: "/users/assistants",
      canManage: true,
    });
  }

  // ---------------------------------------------------------------------
  // My account — superadmin edits via PATCH /users/superadmin (username/
  // password, both optional — blank means "leave unchanged"). A manager
  // edits their own row via PATCH /users/managers/{own id}, which requires
  // all three fields (username/full_name/password) since that endpoint has
  // no partial-update schema — same as the Managers section's edit form.
  // ---------------------------------------------------------------------
  const accountSection = document.getElementById("account-section");
  const accountForm = document.getElementById("account-form");
  const accountUsername = document.getElementById("account-username");
  const accountFullName = document.getElementById("account-full-name");
  const accountFullNameField = document.getElementById("account-full-name-field");
  const accountPassword = document.getElementById("account-password");
  const accountNote = document.getElementById("account-note");

  accountSection.classList.remove("hidden");
  accountUsername.value = user.username;

  if (isSuperadmin) {
    accountFullNameField.classList.add("hidden");
    accountFullName.required = false;
    accountUsername.required = false;
    accountPassword.required = false;
    accountNote.textContent = "Leave a field empty to keep it unchanged.";
  } else {
    accountFullNameField.classList.remove("hidden");
    accountFullName.value = user.full_name;
    accountFullName.required = true;
    accountUsername.required = true;
    accountPassword.required = true;
    accountNote.textContent =
      "Every save needs all fields, including the password — enter the password even if you only change the name.";
  }

  accountForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearMessages();

    try {
      if (isSuperadmin) {
        await apiFetch("/users/superadmin", {
          method: "PATCH",
          body: {
            superadmin_username: accountUsername.value || null,
            superadmin_password: accountPassword.value || null,
          },
        });
      } else {
        await apiFetch(`/users/managers/${user.id}`, {
          method: "PATCH",
          body: {
            username: accountUsername.value,
            full_name: accountFullName.value,
            password: accountPassword.value,
          },
        });
      }
      accountPassword.value = "";
      showSuccess("Your details were updated. You may need to sign in again on other devices.");
    } catch (err) {
      showError(errorContainer, err.detail || err.message || "Could not update your details");
    }
  });
})();
