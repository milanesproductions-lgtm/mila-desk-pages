// Web version of the admin panel (owner's request 2026-11-25: use it from the phone).
// admin.js and socia.js are the extension's files unchanged; they only ask the extension
// for the Supabase session (MILA_ADMIN_CONNECTION). Here that answer comes from a sign-in
// with the admin's own email and password. Every action is still checked by the database
// (is_admin), so this page grants nothing by itself.
// The password is never stored; only Supabase's refresh token stays in this browser so the
// phone keeps the session, and «Salir» removes it.
(function () {
  const SUPABASE_URL = "https://sbbcjnsyljjdljoihack.supabase.co";
  const SUPABASE_KEY = "sb_publishable_przw0W41bKFfL3-XOvZdhA_b3ueCU6T";
  const STORE = "milaAdminRefresh";
  let session = null;
  let pending = null;

  const store = {
    get() { try { return localStorage.getItem(STORE) || ""; } catch { return ""; } },
    set(v) { try { v ? localStorage.setItem(STORE, v) : localStorage.removeItem(STORE); } catch {} },
  };

  async function token(grant, body) {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
      method: "POST", headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      const error = new Error(response.status === 429 ? "Demasiados intentos. Espera un momento." : "Correo o contraseña incorrectos.");
      error.status = response.status;
      throw error;
    }
    session = { token: data.access_token, userId: data.user?.id, until: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60000 };
    store.set(data.refresh_token || "");
    showLogout();
  }

  function askLogin() {
    return new Promise((resolve) => {
      const box = document.createElement("div");
      box.id = "webLogin";
      box.innerHTML = `<form><h2>Mila.Desk · Administración</h2><p>Entra con tu cuenta de administradora.</p>
        <label>Correo<input type="email" name="email" autocomplete="username" required></label>
        <label>Contraseña<input type="password" name="password" autocomplete="current-password" required></label>
        <button type="submit">Entrar</button><p class="msg" role="status"></p></form>`;
      document.body.appendChild(box);
      const form = box.querySelector("form");
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = form.querySelector("button");
        button.disabled = true;
        form.querySelector(".msg").textContent = "Entrando…";
        try {
          await token("password", { email: form.email.value.trim(), password: form.password.value });
          box.remove();
          resolve();
        } catch (error) {
          form.password.value = "";
          form.querySelector(".msg").textContent = error.message;
          button.disabled = false;
        }
      });
      form.email.focus();
    });
  }

  async function ensure() {
    if (session && session.until > Date.now()) return;
    const refresh = store.get();
    if (refresh) {
      try { await token("refresh_token", { refresh_token: refresh }); return; } catch { store.set(""); }
    }
    session = null;
    await askLogin();
  }

  function showLogout() {
    if (document.getElementById("webLogout")) return;
    const button = document.createElement("button");
    button.id = "webLogout";
    button.type = "button";
    button.textContent = "Salir";
    button.addEventListener("click", async () => {
      const t = session?.token;
      session = null;
      store.set("");
      if (t) { try { await fetch(`${SUPABASE_URL}/auth/v1/logout`, { method: "POST", headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${t}` } }); } catch {} }
      location.reload();
    });
    document.body.appendChild(button);
  }

  async function sendMessage(message) {
    if (message?.type === "MILA_ADMIN_CONNECTION") {
      if (!pending) pending = ensure().finally(() => { pending = null; });
      await pending;
      return { ok: true, token: session.token, userId: session.userId, url: SUPABASE_URL, key: SUPABASE_KEY };
    }
    // Reading Amazon needs the Chrome extension.
    return { ok: false, error: "Esto solo funciona en la extensión de Chrome." };
  }

  Object.defineProperty(window, "chrome", {
    configurable: true,
    value: { runtime: { sendMessage, getURL: (path) => path } },
  });
})();
