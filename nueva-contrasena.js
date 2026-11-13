// Sets a new password from the recovery link Supabase emails to the user.
// The link's token stays in memory only: it is removed from the address at once and
// is never stored or logged. Everything read from the address is untrusted.
(function () {
  const SUPABASE_URL = "https://sbbcjnsyljjdljoihack.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_przw0W41bKFfL3-XOvZdhA_b3ueCU6T";
  const MIN_LENGTH = 8;
  const VIEWS = ["viewChecking", "viewForm", "viewInvalid", "viewDone"];

  // The same script serves /nueva-contrasena.html and the English page /en/.
  const EN = document.documentElement?.lang === "en";
  const T = (es, en) => (EN ? en : es);
  const $ = (id) => document.getElementById(id);
  const show = (view) => VIEWS.forEach((id) => { $(id).hidden = id !== view; });
  const say = (text) => { $("formStatus").textContent = text; };
  const clearFields = () => { $("newPassword").value = ""; $("confirmPassword").value = ""; };

  const link = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  let token = !link.get("error") && link.get("type") === "recovery" ? link.get("access_token") || "" : "";
  if (window.location.hash) {
    window.history.replaceState(null, document.title, window.location.pathname + window.location.search);
  }

  const headers = () => ({
    apikey: SUPABASE_PUBLISHABLE_KEY,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  });

  function errorText(status, code) {
    if (code === "same_password") return T("Esa ya es tu contraseña. Escribe una diferente.", "That's already your password. Enter a different one.");
    if (code === "weak_password") return T("Esa contraseña es muy débil. Prueba con una más larga y difícil de adivinar.", "That password is too weak. Try a longer one that's harder to guess.");
    if (status === 429) return T("Demasiados intentos. Espera un momento y vuelve a probar.", "Too many attempts. Wait a moment and try again.");
    return T("No se pudo cambiar la contraseña. Inténtalo de nuevo.", "Couldn't change the password. Try again.");
  }

  // Ends the recovery session and any other open one. The password is already
  // changed at this point, so a failure here must not read as a failed change.
  async function endSessions() {
    try { await fetch(`${SUPABASE_URL}/auth/v1/logout`, { method: "POST", headers: headers() }); } catch {}
  }

  async function submit(event) {
    event.preventDefault();
    const password = $("newPassword").value;
    if (password.length < MIN_LENGTH) return say(T(`Usa al menos ${MIN_LENGTH} caracteres.`, `Use at least ${MIN_LENGTH} characters.`));
    if (password !== $("confirmPassword").value) return say(T("Las dos contraseñas no coinciden.", "The two passwords don't match."));

    say("");
    $("savePassword").disabled = true;
    try {
      const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ password }),
      });
      if (response.ok) {
        await endSessions();
        token = "";
        clearFields();
        show("viewDone");
        return;
      }
      if (response.status === 401 || response.status === 403) {
        token = "";
        clearFields();
        show("viewInvalid");
        return;
      }
      const payload = await response.json().catch(() => ({}));
      say(errorText(response.status, payload.error_code || payload.code));
    } catch {
      say(T("No se pudo conectar. Comprueba tu conexión e inténtalo de nuevo.", "Couldn't connect. Check your connection and try again."));
    } finally {
      $("savePassword").disabled = false;
    }
  }

  $("resetForm").addEventListener("submit", submit);
  show(token ? "viewForm" : "viewInvalid");
})();
