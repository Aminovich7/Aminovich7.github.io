(async function redirectIfLoggedIn() {
  const token = await getAccessToken().catch(() => null);
  if (token) {
    window.__demoGo("/dashboard");
  }
})();

const form = document.getElementById("login-form");
const errorContainer = document.getElementById("error-container");
const loginBtn = document.getElementById("login-btn");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorContainer.innerHTML = "";
  loginBtn.disabled = true;

  const username = document.getElementById("username").value;
  const password = document.getElementById("password").value;

  try {
    const response = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password }),
    });

    if (!response.ok) {
      let detail = "Could not sign in";
      if (response.status === 429) {
        detail = "Too many attempts. Please wait a minute and try again.";
      } else {
        const payload = await response.json().catch(() => null);
        if (payload && payload.detail) detail = payload.detail;
      }
      throw new Error(detail);
    }

    const data = await response.json();
    setRefreshToken(data.refresh_token);
    window.__demoGo("/dashboard");
  } catch (err) {
    const box = document.createElement("div");
    box.className = "error-box";
    box.textContent = err.message || "Could not sign in";
    errorContainer.appendChild(box);
  } finally {
    loginBtn.disabled = false;
  }
});
