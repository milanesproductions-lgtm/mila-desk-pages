// Mila.Desk. Copyright (c) 2026 Jhoun Milanes (Milanes Production). All rights reserved. See LICENSE.txt. MD-ORIGIN-7F3A91C2
// Administrator page, opened in its own tab from the popup (owner's request, 2026-11-08):
// recent sign-ups, access gifts and codes, and Free Samples review. It uses the session the
// popup already signed in with, through the service worker, which answers only this page.
// Every action is checked again by the database (is_admin), not only by this page.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
  const SOURCE_LABELS = { licencia: 'Suscripción', codigo_beta: 'Código', admin: 'Regalo' };
  const FILL_PAUSE = 1500, FILL_AGAIN_AFTER = 24 * 60 * 60 * 1000;
  let signups = [], approved = [], categoriesReady = false, filling = false, me = '';
  // Who brought each person (name of the code group they redeemed), shown as «Afiliado de …».
  let mentors = new Map();
  let mentorAccounts = []; // each mentor's linked account (admin_mentor_accounts)
  async function loadMentors() {
    try { const rows = await rpc('admin_user_mentors'); mentors = new Map((Array.isArray(rows) ? rows : []).filter(r => r.mentor).map(r => [r.user_id, r.mentor])); }
    catch { mentors = new Map(); }
  }

  async function connection() {
    const res = await chrome.runtime.sendMessage({ type: 'MILA_ADMIN_CONNECTION' }).catch(() => null);
    if (!res?.ok) throw new Error(res?.error || 'Inicia sesión en Mila.Desk desde el popup.');
    return res;
  }
  async function request(path, { method = 'GET', body, prefer } = {}) {
    const c = await connection();
    let response;
    try {
      response = await fetch(`${c.url}/rest/v1/${path}`, {
        method,
        headers: { apikey: c.key, Authorization: `Bearer ${c.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(prefer ? { Prefer: prefer } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
    } catch { throw new Error('No se pudo conectar con Supabase. Comprueba tu conexión.'); }
    const raw = await response.text();
    let data = null;
    if (raw) { try { data = JSON.parse(raw); } catch { data = raw; } }
    if (!response.ok) {
      const error = new Error(data?.message || data?.error || `Error de Supabase (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  const rpc = (name, body = {}) => request(`rpc/${name}`, { method: 'POST', body });
  const date = iso => iso ? new Date(iso).toLocaleString('es-DO', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
  const endOfDay = value => value ? new Date(`${value}T23:59:59`).toISOString() : null;
  const accessText = row => {
    if (!row.plan) return 'Sin acceso';
    const active = !row.expires_at || Date.parse(row.expires_at) > Date.now();
    return withMentor(MilaCore.describeAccess({ active, plan: row.plan, expires_at: row.expires_at }), row);
  };
  // «Prueba gratis» (a code's free month) becomes «Afiliado de Ysmalia»; other plans keep their name and add it.
  const withMentor = (text, row) => {
    const mentor = mentors.get(row.user_id);
    if (!mentor) return text;
    return row.plan === 'beta' ? text.replace('Prueba gratis', `Afiliado de ${mentor}`) : `${text} · afiliado de ${mentor}`;
  };

  // ── Recent sign-ups ─────────────────────────────────────────────────────────────
  async function loadSignups() {
    const msg = $('signupMsg');
    msg.textContent = '';
    try {
      const [rows] = await Promise.all([rpc('admin_recent_signups', { p_limit: 500 }), loadMentors()]);
      signups = Array.isArray(rows) ? rows : [];
      renderSignups();
      if (grants.length) renderGrants(); // emails and mentors for the access list
    } catch (error) {
      $('signupRows').innerHTML = '<tr><td colspan="6" class="empty">No se pudieron cargar los registros.</td></tr>';
      msg.textContent = error.status === 404 ? 'Falta aplicar en la base de datos la función de registros.' : error.message;
    }
  }
  let signupView = 'hoy';
  function renderSignups() {
    const hasAccess = r => !!r.plan && (!r.expires_at || Date.parse(r.expires_at) > Date.now());
    const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const isToday = r => Date.parse(r.created_at) >= today.getTime();
    // Each number is a button that shows those accounts (owner's request, 2026-11-16).
    const views = {
      hoy: [isToday, 'hoy'],
      semana: [r => Date.parse(r.created_at) > week, 'esta semana'],
      todas: [() => true, 'cuentas en total'],
      // Premium = any access still running (paid, a Paddle trial or a code's free month); when it
      // ends without paying the account falls to Gratis by itself, and paying brings it back (2026-11-24).
      premium: [hasAccess, 'plan premium'],
      sin_acceso: [r => !hasAccess(r), 'plan gratis'],
      sin_confirmar: [r => !r.email_confirmed, 'sin confirmar el correo']
    };
    $('signupStats').innerHTML = Object.entries(views).map(([key, [fn, label]]) =>
      `<button type="button" class="stat${signupView === key ? ' on' : ''}" data-sview="${key}" aria-pressed="${signupView === key}"><b>${signups.filter(fn).length}</b><span>${label}</span></button>`).join('');
    const q = $('signupSearch').value.trim().toLowerCase();
    const onlyFree = $('signupOnlyFree').checked;
    // Without a search, the chosen group (today by default, owner's request 2026-11-15); a search
    // from «hoy» looks at every account.
    const inView = q && signupView === 'hoy' ? () => true : views[signupView][0];
    const list = signups.filter(r => inView(r) && (!q || `${r.username || ''} ${r.email || ''}`.toLowerCase().includes(q)) && (!onlyFree || !hasAccess(r)));
    $('signupRows').innerHTML = list.length ? list.map(r => {
      const self = r.user_id === me;
      const button = self ? '<span class="tag">Tú</span>' : hasAccess(r)
        ? `<button type="button" data-grant-email="${esc(r.email)}" data-grant-name="${esc(r.username || r.email)}">Cambiar fecha</button>`
        : `<button type="button" class="primary" data-grant-email="${esc(r.email)}" data-grant-name="${esc(r.username || r.email)}" data-grant-unconfirmed="${r.email_confirmed ? '' : '1'}">Dar acceso</button>`;
      return `<tr><td><b>${esc(r.username || 'Sin usuario')}</b>${mentorTag(r.user_id)}</td><td class="small">${esc(r.email)}</td><td class="small">${esc(date(r.created_at))}</td>`
        + `<td>${r.email_confirmed ? '<span class="tag ok">Confirmado</span>' : '<span class="tag warn">Pendiente</span>'}</td>`
        + `<td>${hasAccess(r) ? `<span class="tag ok">${esc(accessText(r))}</span>` : '<span class="tag">Gratis</span>'}</td><td>${button}</td></tr>`;
    }).join('') : `<tr><td colspan="6" class="empty">${q ? 'No hay cuentas que coincidan.' : signupView === 'hoy' ? 'Nadie se ha registrado hoy todavía. Toca otro número o busca arriba para ver cuentas de otros días.' : 'No hay cuentas en este grupo.'}</td></tr>`;
  }
  async function grantFromSignups(button) {
    const email = button.dataset.grantEmail, name = button.dataset.grantName, until = $('signupUntil').value;
    const when = until ? `hasta el ${until.split('-').reverse().join('/')}` : 'sin fecha de fin';
    const warn = button.dataset.grantUnconfirmed ? '\n\nEsta cuenta todavía no confirmó su correo.' : '';
    if (!confirm(`¿Dar acceso Premium a ${name}, ${when}?${warn}`)) return;
    button.disabled = true;
    try {
      const result = await rpc('admin_grant_access', { p_who: email, p_expires_at: endOfDay(until), p_note: null });
      $('signupMsg').textContent = result?.ok ? `Acceso dado a ${name}, ${when}.` : 'No se pudo dar el acceso: no se encontró la cuenta.';
      await Promise.all([loadSignups(), loadAccess()]);
    } catch (error) { $('signupMsg').textContent = error.message; button.disabled = false; }
  }

  // ── Access: gifts, codes and who has access ─────────────────────────────────────
  const daysText = d => Number(d) > 0 ? `${Number(d)} días` : 'sin fecha de fin';
  // Who is using each code, from the access list (entitlements keep the code they were redeemed with).
  let codeUsers = new Map();
  const userLine = g => { const active = !g.expires_at || Date.parse(g.expires_at) > Date.now();
    return `<div class="user ${active ? '' : 'off'}">👤 ${esc(g.username || 'Usuario sin nombre')} · ${esc(withMentor(MilaCore.describeAccess({ active, plan: g.plan, expires_at: g.expires_at }), g))}`
      + ` <button type="button" class="danger" data-revoke="${esc(g.user_id)}" data-name="${esc(g.username || 'este usuario')}">Quitar acceso</button></div>`; };
  const codeItem = c => `<div class="item"><div class="${c.active ? '' : 'off'}"><b>${esc(c.code)}</b><small>${esc(c.label || 'Sin nombre')} · ${Number(c.uses) || 0} de ${Number(c.max_uses) || 0} usos · ${daysText(c.access_days)}${c.offer === 'mila' ? ' · 🌐 para redes' : ''}${c.sent_at && !Number(c.uses) ? ` · 📤 enviado el ${esc(new Date(c.sent_at).toLocaleDateString('es-DO'))}` : ''}${c.redeem_until ? ` · canjear antes del ${esc(new Date(c.redeem_until).toLocaleDateString('es-DO'))}` : ''}${c.active ? '' : ' · desactivado'}</small>${(codeUsers.get(c.code) || []).map(userLine).join('')}${Number(c.uses) && !codeUsers.has(c.code) ? `<small>${esc(usedCodeNote(c.code))}</small>` : ''}</div>`
    + `<div class="actions"><button type="button" data-copy="${esc(c.code)}">Copiar</button><button type="button" data-code="${esc(c.code)}" data-active="${c.active ? '0' : '1'}">${c.active ? 'Desactivar' : 'Activar'}</button>`
    + `${Number(c.uses) ? '' : `<button type="button" class="danger" data-delete="${esc(c.code)}">Eliminar</button>`}</div></div>`;
  async function loadAccess() {
    try {
      const [codes, list] = await Promise.all([rpc('admin_list_beta_codes'), rpc('admin_list_access'), mentors.size ? null : loadMentors()]);
      allCodes = Array.isArray(codes) ? codes : [];
      grants = Array.isArray(list) ? list : [];
      codeUsers = new Map();
      for (const g of Array.isArray(grants) ? grants : []) if (g.source === 'codigo_beta' && g.beta_code) codeUsers.set(g.beta_code, [...(codeUsers.get(g.beta_code) || []), g]);
      renderCodeList();
      renderGrants();
    } catch (error) { $('accessMsg').textContent = error.message; }
    await loadMentorPanel();
  }
  // Mentors' codes (and their prize codes) live in Mentoras, not here (owner's request, 2026-11-16).
  function renderCodeList() {
    const mentorKeys = new Set(mentorNames().map(n => n.toLowerCase()));
    const groups = MilaCore.groupBetaCodes(allCodes).filter(g => !mentorKeys.has(g.label.toLowerCase()) && !g.label.startsWith(PRIZE_PREFIX));
    $('codeList').innerHTML = groups.length ? groups.map(g => g.codes.length === 1 ? codeItem(g.codes[0])
      : `<details class="group"><summary>${esc(g.label || 'Sin nombre')}<small>${g.uses} de ${g.max} usados · ${g.codes.length} códigos · ${daysText(g.codes[0].access_days)}</small></summary><div class="list">${g.codes.map(codeItem).join('')}</div></details>`
    ).join('') : `<div class="hint">${allCodes.length ? 'No hay otros códigos: los de cada mentora están en Mentoras.' : 'Todavía no has creado códigos.'}</div>`;
  }
  // «Quién tiene acceso» is folded and searchable by user or email (owner's request, 2026-11-15).
  // Emails come from the sign-up list (up to 500 accounts).
  let grants = [];
  function renderGrants() {
    const q = $('grantSearch').value.trim().toLowerCase();
    const emails = new Map(signups.map(r => [r.user_id, r.email || '']));
    const list = grants.filter(g => !q || `${g.username || ''} ${emails.get(g.user_id) || ''} ${mentors.get(g.user_id) || ''}`.toLowerCase().includes(q));
    $('grantCount').textContent = `${grants.length} ${grants.length === 1 ? 'persona' : 'personas'}`;
    if (q) $('grantFold').open = true;
    $('grantList').innerHTML = list.length ? list.map(g => {
      const active = !g.expires_at || Date.parse(g.expires_at) > Date.now();
      const detail = [withMentor(MilaCore.describeAccess({ active, plan: g.plan, expires_at: g.expires_at }), g), g.source === 'codigo_beta' && g.beta_code ? g.beta_code : g.source === 'admin' ? '' : SOURCE_LABELS[g.source] || '', emails.get(g.user_id), g.note].filter(Boolean).join(' · ');
      return `<div class="item"><div class="${active ? '' : 'off'}"><b>${esc(g.username || 'Usuario sin nombre')}</b>${mentorTag(g.user_id)}<small>${esc(detail)}</small></div>`
        + `<div class="actions"><button type="button" class="danger" data-revoke="${esc(g.user_id)}" data-name="${esc(g.username || 'este usuario')}">Quitar</button></div></div>`;
    }).join('') : `<div class="hint">${q ? 'Nadie coincide con esa búsqueda.' : 'Nadie tiene acceso todavía, aparte de ti.'}</div>`;
  }
  async function grantAccess() {
    const who = $('grantWho').value.trim(), until = $('grantUntil').value, msg = $('accessMsg');
    if (!who) { msg.textContent = 'Escribe el correo o el usuario.'; return; }
    $('grantBtn').disabled = true;
    try {
      const result = await rpc('admin_grant_access', { p_who: who, p_expires_at: endOfDay(until), p_note: null });
      if (result?.ok) {
        msg.textContent = `Acceso dado a ${who}${until ? ` hasta el ${until.split('-').reverse().join('/')}` : ', sin fecha de fin'}.`;
        $('grantWho').value = ''; $('grantUntil').value = '';
        await Promise.all([loadAccess(), loadSignups()]);
      } else msg.textContent = result?.reason === 'ambiguous' ? 'Hay más de una cuenta con ese usuario: usa el correo.' : 'No se encontró ninguna cuenta con ese usuario o correo.';
    } catch (error) { msg.textContent = error.message; }
    finally { $('grantBtn').disabled = false; }
  }
  let batch = null;
  // One code per call, as the database creates them; a failure keeps the ones already made.
  async function makeCodes({ count, label, days, redeemUntil, msg }) {
    const made = [];
    try {
      for (let i = 0; i < count; i++) {
        if (count > 1) msg.textContent = `Creando ${i + 1} de ${count}…`;
        made.push(String(await rpc('admin_create_beta_code', { p_label: label, p_max_uses: 1, p_access_days: days, p_redeem_until: redeemUntil })));
      }
    } catch (error) { msg.textContent = `${error.message}${made.length ? ` Se crearon ${made.length} de ${count}.` : ''}`; }
    return made;
  }
  const countValue = () => Math.max(1, Math.min(MilaCore.CODE_BATCH_LIMIT, Math.floor(Number($('codeCount').value) || 1)));
  const createLabel = () => { const n = countValue(); $('codeCreate').textContent = n === 1 ? '＋ Crear código' : `＋ Crear ${n} códigos`; };
  // One code per person: max_uses is always 1 and the access days start when the person redeems it.
  async function createCode() {
    const count = countValue(), days = Math.max(1, Math.min(730, Math.floor(Number($('codeDays').value) || 30)));
    const label = $('codeLabel').value.trim(), until = $('codeUntil').value, msg = $('accessMsg');
    if (until && endOfDay(until) < new Date().toISOString()) { msg.textContent = 'La fecha para canjear ya pasó.'; return; }
    if (count > 1 && !label) { msg.textContent = 'Ponle un nombre al grupo (por ejemplo, la mentora) para encontrarlo después.'; return; }
    $('codeCreate').disabled = true; $('codeBatch').hidden = true;
    let made = [];
    try { made = await makeCodes({ count, label, days, redeemUntil: endOfDay(until), msg }); }
    finally { $('codeCreate').disabled = false; }
    if (!made.length) return;
    const untilText = until ? until.split('-').reverse().join('/') : '';
    if (count === 1) {
      let copied = false;
      try { await navigator.clipboard.writeText(made[0]); copied = true; } catch {}
      msg.textContent = `Código creado: ${made[0]}${copied ? ' (copiado)' : ''}. Da ${days} días desde que se canjea.`;
    } else {
      batch = { codes: made, label, days, until: untilText };
      $('codeBatchTitle').textContent = `${made.length} códigos · ${label} · ${days} días${untilText ? ` · canjear antes del ${untilText}` : ''}`;
      $('codeBatchList').value = made.join('\n');
      $('codeBatch').hidden = false;
      if (made.length === count) msg.textContent = `Listo: ${made.length} códigos creados. Cópialos, descarga la lista o genera un PDF.`;
    }
    $('codeLabel').value = ''; $('codeUntil').value = ''; $('codeCount').value = 1; createLabel();
    await loadAccess();
  }
  function downloadCsv() {
    if (!batch) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + MilaCore.codeBatchCsv(batch.codes, batch)], { type: 'text/csv;charset=utf-8' }));
    a.download = `codigos-${(batch.label || 'mila').replace(/[^\w-]+/g, '-').slice(0, 40)}.csv`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  // A printable page; the browser's print dialog saves it as PDF.
  // list: { codes, label, days, until, used? } (used: codes already redeemed, crossed out).
  function printPdf(list) {
    if (!list) return;
    const used = new Set(list.used || []);
    const w = window.open('', '_blank');
    if (!w) { $('accessMsg').textContent = 'El navegador bloqueó la ventana. Permite ventanas emergentes para esta página.'; return; }
    w.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Códigos Mila.Desk · ${esc(list.label)}</title><style>
      body{font:13px/1.45 -apple-system,Helvetica,Arial,sans-serif;color:#111;margin:32px}h1{font-size:20px;margin:0 0 4px}h1 span{color:#ff5800}
      .info{color:#444;margin-bottom:14px}.how{border:1px solid #ddd;border-radius:8px;padding:10px 14px;margin-bottom:16px}.how ol{margin:6px 0 0;padding-left:18px}
      ol.codes{columns:3;column-gap:28px;padding-left:28px;font:13px/2 ui-monospace,Menlo,monospace}@media print{body{margin:14mm}}</style></head><body>
      <h1>Mila<span>.Desk</span> · Códigos de acceso</h1>
      <div class="info"><b>${esc(list.label)}</b> · ${list.days} días de acceso desde que se canjea${list.until ? ` · canjear antes del ${esc(list.until)}` : ''} · ${list.codes.length} códigos${used.size ? ` · ${used.size} ya usados (tachados)` : ''}</div>
      <div class="how"><b>Cómo usar tu código</b> (cada código es para una sola persona):<ol><li>Instala Mila.Desk desde la Chrome Web Store y crea tu cuenta.</li><li>Abre Mila.Desk → Configuración → Tu acceso.</li><li>Escribe tu código y pulsa ACTIVAR. Tus ${list.days} días empiezan en ese momento.</li></ol></div>
      <ol class="codes">${list.codes.map(c => used.has(c) ? `<li><s style="color:#999">${esc(c)}</s></li>` : `<li>${esc(c)}</li>`).join('')}</ol></body></html>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
  }
  async function accessClick(event) {
    const b = event.target.closest('button'); if (!b) return;
    const msg = b.closest('section')?.querySelector(':scope > .msg') || $('accessMsg');
    try {
      if (b.dataset.copy) { await navigator.clipboard.writeText(b.dataset.copy); msg.textContent = `Copiado: ${b.dataset.copy}`; }
      else if (b.dataset.delete) {
        if (!confirm(`¿Eliminar el código ${b.dataset.delete}? No se puede deshacer.`)) return;
        const result = await rpc('admin_delete_beta_code', { p_code: b.dataset.delete });
        msg.textContent = result?.ok ? `Código eliminado: ${b.dataset.delete}.` : 'Ese código ya se usó: solo se puede desactivar.';
        await loadAccess();
      }
      else if (b.dataset.code) { await rpc('admin_set_beta_code_active', { p_code: b.dataset.code, p_active: b.dataset.active === '1' }); await loadAccess(); }
      else if (b.dataset.revoke) {
        if (!confirm(`¿Quitar el acceso a ${b.dataset.name}?`)) return;
        await rpc('admin_revoke_access', { p_user_id: b.dataset.revoke });
        msg.textContent = `Acceso quitado a ${b.dataset.name}.`;
        await Promise.all([loadAccess(), loadSignups()]);
      }
    } catch (error) { msg.textContent = error.message; }
  }

  // ── Mentors (owner's request, 2026-11-15) ───────────────────────────────────────
  // One card per mentor (a code group with 2+ codes, or one saved in «mentors»): her
  // codes, her students by state, the alliance dates and reminders, and «add codes» with
  // the same name, days and deadline as the list she already has.
  let allCodes = [], mentorRows = [], mentorStudents = [], mentorPayments = [], mentorPayouts = [];
  const STATE_LABELS = { pagando: 'Pagando', gratis: 'Gratis (mes o prueba)', sin_pagar: 'Terminó el mes sin pagar', cancelo: 'Canceló', otro_acceso: 'Regalo tuyo' };
  const STATE_TAGS = { pagando: 'ok', gratis: '', sin_pagar: 'warn', cancelo: 'warn', otro_acceso: '' };
  // One row per person (someone who redeemed two codes counted once), with every code they used.
  function uniqueStudents(rows) {
    const byUser = new Map();
    for (const r of rows.slice().sort((a, b) => Date.parse(a.redeemed_at) - Date.parse(b.redeemed_at))) {
      const prev = byUser.get(r.user_id);
      if (prev) prev.codes.push(r.code); else byUser.set(r.user_id, { ...r, codes: [r.code] });
    }
    return [...byUser.values()].sort((a, b) => Date.parse(b.redeemed_at) - Date.parse(a.redeemed_at));
  }
  // Why a used code shows nobody on it: who redeemed it and what that person has now.
  function usedCodeNote(code) {
    const r = mentorStudents.find(s => s.code === code);
    if (!r) return 'Ya se usó; esa persona ahora tiene otro tipo de acceso (por ejemplo, una suscripción).';
    const all = mentorStudents.filter(s => s.user_id === r.user_id);
    const who = r.username || r.email || 'una cuenta sin nombre';
    if (all.length > 1) return `Lo canjeó ${who}, que después canjeó también ${all.filter(s => s.code !== code).map(s => s.code).join(', ')}: un solo acceso, el del último código.`;
    const st = MilaCore.mentorStudentState(r);
    return `Lo canjeó ${who}. Ahora: ${st === 'otro_acceso' ? 'tiene un regalo que le diste tú' : STATE_LABELS[st].toLowerCase()}.`;
  }
  const mentorFilter = new Map();
  // The 3-month raffle code of the proposal: one use, 90 days, 60 days to redeem; kept in
  // its own group «Premio · <mentor>» so it never counts as her student nor gets the discount.
  const PRIZE_PREFIX = 'Premio · '; // old prize codes stay out of the lists; prizes now go by the «🎁 Dar premio de 1 mes» button
  let currentMentor = ''; // the mentor open inside this same page ('' = the list)
  let checkoutCodes = []; // mentors' codes typed at Paddle checkout (admin_list_checkout_codes)
  // Code typed at checkout (owner's decision, 2026-11-21): the discount itself is made in
  // Paddle; here it is tied to the mentor so whoever pays with it becomes her student.
  function checkoutHtml(name) {
    const mine = checkoutCodes.filter(c => c.mentor === name);
    return `<h3>Código para el pago</h3>
      ${mine.length ? `<div class="list">${mine.map(c => `<div class="item"><div><b>${esc(c.code)}</b><small>Descuento de Paddle ${esc(c.discount_id)} · ${Number(c.students) || 0} alumnos ligados por este código</small></div>
        <div class="actions"><button type="button" data-mcheckoutoff="${esc(c.discount_id)}">Quitar</button></div></div>`).join('')}</div>` : ''}
      <div class="row" style="margin-top:8px"><input data-mccode placeholder="Código (ej. ${esc(name.split(' ')[0].toUpperCase().replace(/[^A-Z0-9]/g, ''))}30)" style="width:170px"><input data-mcdsc placeholder="ID del descuento en Paddle (dsc_…)" style="flex:1;min-width:200px"><button type="button" class="primary" data-mcheckout="${esc(name)}">Ligar</button></div>
      <div class="hint">El código y el descuento se crean en Paddle (mismo nombre). Quien lo escribe al pagar queda como alumno de ${esc(name)} y cuenta para su comisión; si ya era alumno de otra mentora, se queda con la primera. En la extensión este código no se puede canjear.</div>`;
  }
  async function loadMentorPanel() {
    try {
      const [list, students, payments, payouts] = await Promise.all([rpc('admin_list_mentors'), rpc('admin_mentor_students'),
        rpc('admin_mentor_payments'), rpc('admin_list_mentor_payouts')]);
      mentorRows = Array.isArray(list) ? list : [];
      mentorStudents = Array.isArray(students) ? students : [];
      mentorPayments = Array.isArray(payments) ? payments : [];
      mentorPayouts = Array.isArray(payouts) ? payouts : [];
      try { const rows = await rpc('admin_list_checkout_codes'); checkoutCodes = Array.isArray(rows) ? rows : []; } catch { checkoutCodes = []; }
      await loadMentorAccounts();
      renderMentors();
      renderCodeList(); // a mentor saved only in «mentors» leaves the list too
      renderEarnings(); // commissions come from here
    } catch (error) {
      $('mentorList').innerHTML = `<div class="empty">${esc(error.status === 404 ? 'Falta aplicar en la base de datos las funciones de mentoras.' : error.message)}</div>`;
    }
  }
  // Each mentor's own Mila.Desk account, linked by the admin (owner's request, 2026-11-16).
  async function loadMentorAccounts() {
    try { const rows = await rpc('admin_mentor_accounts'); mentorAccounts = Array.isArray(rows) ? rows : []; }
    catch { mentorAccounts = []; }
    if (signups.length) renderSignups();
    if (grants.length) renderGrants();
  }
  const mentorAccount = name => mentorAccounts.find(a => a.name.toLowerCase() === name.toLowerCase()) || null;
  // Influencer gets a phone and a type tag next to the name (owner's request, 2026-11-23).
  const partnerBadge = kind => kind === 'mila' ? { icon: '🎁', tag: ' <span class="tag">Regalo de Mila.Desk</span>' } : kind === 'influencer' ? { icon: '📱', tag: ' <span class="tag">Influencer</span>' } : { icon: '🎓', tag: ' <span class="tag">Mentora</span>' };
  const mentorTag = userId => { const a = mentorAccounts.find(x => x.user_id === userId); return a ? ` <span class="tag ok">🎓 Mentora ${esc(a.name)}</span>` : ''; };
  const LINK_ERRORS = { not_found: 'No hay ninguna cuenta con ese correo o usuario.', ambiguous: 'Ese dato coincide con más de una cuenta: usa el correo.', no_name: 'Falta el nombre de la mentora.' };
  function accountHtml(name) {
    const a = mentorAccount(name);
    if (!a) return `<h3>Su cuenta de Mila.Desk</h3>
      <div class="row"><input data-mwho placeholder="Correo o usuario de su cuenta" style="flex:1;min-width:200px"><button type="button" class="primary" data-mlink="${esc(name)}">Vincular</button></div>
      <div class="hint">Así ves y cambias su acceso desde aquí, y su cuenta sale marcada como mentora.</div>`;
    const active = !!a.plan && (!a.expires_at || Date.parse(a.expires_at) > Date.now());
    const m = mentorRows.find(x => x.name.toLowerCase() === name.toLowerCase());
    const yearEnd = (m?.kind || 'mentora') === 'mentora' ? MilaCore.mentorFreeYearEnd(m?.started_at) : null;
    return `<h3>Su cuenta de Mila.Desk</h3>${yearEnd ? `<div class="hint">Su año de Premium gratis por la alianza va hasta el ${esc(yearEnd.split('-').reverse().join('/'))}.${active && !a.expires_at ? ' Ahora tiene Premium sin fecha de fin: si quieres ajustarlo, usa «Cambiar fecha».' : ''}</div>` : ''}
      <div class="item"><div><b>👤 ${esc(a.username || 'Sin usuario')}</b><small>${esc(a.email || '')} · ${esc(active ? MilaCore.describeAccess({ active, plan: a.plan, expires_at: a.expires_at }) : 'Sin acceso')}</small></div>
        <div class="actions"><button type="button" data-munlink="${esc(name)}">Desvincular</button></div></div>
      <div class="row" style="margin-top:8px"><label class="hint">Premium hasta <input type="date" data-muntil value="${esc(yearEnd || '')}"></label><button type="button" class="primary" data-mgrant="${esc(name)}">${active ? 'Cambiar fecha' : 'Dar Premium'}</button>
        ${active ? `<button type="button" class="danger" data-mrevoke="${esc(name)}">Quitar acceso</button>` : ''}<span class="hint">Sin fecha = sin fecha de fin.</span></div>`;
  }
  function mentorNames() {
    const names = new Map();
    for (const g of MilaCore.groupBetaCodes(allCodes)) if (g.label && g.codes.length > 1 && !g.label.startsWith(PRIZE_PREFIX)) names.set(g.label.toLowerCase(), g.label);
    for (const m of mentorRows) names.set(m.name.toLowerCase(), m.name);
    // «Regalo de Mila.Desk» (the owner's own codes) always first.
    const mila = n => mentorRows.find(m => m.name.toLowerCase() === n.toLowerCase())?.kind === 'mila' ? 0 : 1;
    return [...names.values()].sort((a, b) => mila(a) - mila(b) || a.localeCompare(b, 'es'));
  }
  // The alliance starts on the first paid charge of one of her students (owner, 2026-11-24).
  const firstPaidOf = key => MilaCore.firstPaidCharge(mentorPayments.filter(p => String(p.mentor || '').toLowerCase() === key));
  function renderMentors() {
    const names = mentorNames();
    const newForm = `<div class="item"><div style="flex:1"><b>＋ Nueva mentora</b><div class="row" style="margin-top:6px"><input data-newname placeholder="Nombre (así se llamará su lista)" maxlength="80" style="flex:1;min-width:160px"><input data-mwho placeholder="Correo o usuario de su cuenta" style="flex:1;min-width:200px"><button type="button" class="primary" data-mnew>Crear</button></div><small>Después le agregas los códigos desde su ficha.</small></div></div>`;
    if (!names.length) { $('mentorList').innerHTML = newForm + '<div class="hint">Todavía no hay mentoras.</div>'; return; }
    const now = Date.now();
    if (currentMentor && !names.some(n => n.toLowerCase() === currentMentor.toLowerCase())) currentMentor = '';
    if (!currentMentor) {
      $('mentorList').innerHTML = newForm + names.map(name => {
        const key = name.toLowerCase();
        const sum = MilaCore.mentorSummary({ codes: allCodes.filter(c => String(c.label || '').trim().toLowerCase() === key),
          students: uniqueStudents(mentorStudents.filter(s => String(s.mentor || '').toLowerCase() === key)), mentor: mentorRows.find(m => m.name.toLowerCase() === key) || null, now, kind: mentorRows.find(m => m.name.toLowerCase() === key)?.kind, firstPaidAt: firstPaidOf(key) });
        const warn = sum.alerts.filter(a => a.kind === 'warn').length;
        const acc = mentorAccount(name), badge = partnerBadge(mentorRows.find(m => m.name.toLowerCase() === key)?.kind);
        return `<div class="item"><div><b>${badge.icon} ${esc(name)}</b>${badge.tag}<small>${acc ? `👤 ${esc(acc.username || acc.email || '')} · ` : '👤 sin cuenta vinculada · '}${sum.count.pagando} pagando · ${sum.count.gratis} en periodo gratis · ${sum.used} de ${sum.codes} códigos usados${warn ? ` · ⚠️ ${warn} ${warn === 1 ? 'aviso' : 'avisos'}` : ''}</small></div>`
          + `<div class="actions"><button type="button" class="primary" data-mopen="${esc(name)}">Abrir →</button></div></div>`;
      }).join('');
      return;
    }
    $('mentorList').innerHTML = names.filter(n => n.toLowerCase() === currentMentor.toLowerCase()).map(name => {
      const key = name.toLowerCase();
      const codes = allCodes.filter(c => String(c.label || '').trim().toLowerCase() === key), socialCodes = new Set(codes.filter(c => c.offer === 'mila').map(c => c.code));
      const students = uniqueStudents(mentorStudents.filter(s => String(s.mentor || '').toLowerCase() === key));
      const mentor = mentorRows.find(m => m.name.toLowerCase() === key) || null;
      const sum = MilaCore.mentorSummary({ codes, students, mentor, now, kind: mentor?.kind, firstPaidAt: firstPaidOf(key) });
      const filter = mentorFilter.get(key) || '';
      const shown = students.filter(s => !filter || MilaCore.mentorStudentState(s, now) === filter);
      const last = codes.slice().sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))[0] || {};
      const chip = (state, n) => `<button type="button" class="${filter === state ? 'primary' : ''}" data-mfilter="${esc(state)}" data-mentor="${esc(name)}">${esc(state ? STATE_LABELS[state] : 'Todos')} · ${n}</button>`;
      const detail = s => {
        const st = MilaCore.mentorStudentState(s, now);
        if (st === 'gratis' && s.sub_status === 'on_trial') return s.sub_access_until ? `prueba con tarjeta hasta el ${new Date(s.sub_access_until).toLocaleDateString('es-DO')}` : 'prueba con tarjeta'; // 14, 20 or 30 days by offer
        if (st === 'gratis') return s.plan_expires_at ? `hasta el ${new Date(s.plan_expires_at).toLocaleDateString('es-DO')}` : '';
        if (st === 'pagando') return s.sub_since ? `desde el ${new Date(s.sub_since).toLocaleDateString('es-DO')}` : '';
        if (st === 'cancelo') return s.sub_access_until ? `acceso hasta el ${new Date(s.sub_access_until).toLocaleDateString('es-DO')}` : '';
        if (st === 'otro_acceso') return s.plan_expires_at ? `hasta el ${new Date(s.plan_expires_at).toLocaleDateString('es-DO')}` : 'sin fecha de fin; no cuenta como alumno';
        return s.plan_expires_at ? `el mes terminó el ${new Date(s.plan_expires_at).toLocaleDateString('es-DO')}` : '';
      };
      return `<div class="mentor" data-mentor-card="${esc(name)}"><div class="row" style="align-items:center"><button type="button" data-mback>← Volver a afiliadas</button><h3 style="margin:0;font-size:18px;text-transform:none;letter-spacing:0;color:var(--w)">${partnerBadge(mentor?.kind).icon} ${esc(name)}${partnerBadge(mentor?.kind).tag}${mentor?.active === false ? ' <span class="tag warn">terminada</span>' : ''}</h3>${mentor?.kind === 'mila' ? '' : `<button type="button" class="primary" data-mview="${esc(mentor?.name || name)}" style="margin-left:auto">👁 Ver su panel como ella lo ve</button>`}</div>
        ${sum.alerts.map(a => `<div class="alert ${esc(a.kind)}">${esc(a.text)}</div>`).join('')}
        <div class="stats">${[[sum.count.pagando, 'pagando'], [sum.count.gratis, 'en periodo gratis'], [sum.count.sin_pagar, 'terminaron sin pagar'], [sum.count.cancelo, 'cancelaron'], [sum.free, 'códigos libres']].map(([n, t]) => `<div class="stat"><b>${n}</b><span>${t}</span></div>`).join('')}</div>
        <div class="grid2">
          <div>
            <h3>Alianza</h3>
            <div class="row"><label class="hint" title="Desde aquí cuenta su año de Premium gratis. Los meses de la alianza cuentan desde la primera suscripción pagada.">Entró el <input type="date" data-mstart value="${esc(mentor?.started_at || '')}"></label>
              <label class="hint">Tipo <select data-mkind>${[['mentora', 'Mentora'], ['influencer', 'Influencer'], ['mila', 'Regalo de Mila.Desk']].map(([v, t]) => `<option value="${v}"${(mentor?.kind || 'mentora') === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
              <label class="hint"><input type="checkbox" data-mactive ${mentor?.active === false ? '' : 'checked'}> Vigente</label>
              ${sum.endsAt ? `<span class="hint">Termina el ${esc(new Date(sum.endsAt).toLocaleDateString('es-DO'))}</span>` : ''}</div>
            <textarea data-mnotes rows="2" maxlength="2000" placeholder="Notas privadas (contacto, acuerdos…)" style="width:100%;margin-top:8px">${esc(mentor?.notes || '')}</textarea>
            <div class="row" style="margin-top:6px"><button type="button" class="primary" data-msave="${esc(name)}">Guardar</button></div>
          </div>
          <div>
            <h3>Agregar códigos</h3>
            <div class="row"><label class="hint">Cantidad <input type="number" data-mcount min="1" max="300" value="10" style="width:76px"></label><label class="hint">Días gratis <input type="number" data-mdays min="1" max="3650" value="${mentor?.kind === 'influencer' || mentor?.kind === 'mila' ? 20 : 30}" style="width:76px"></label>${mentor?.kind === 'mentora' || !mentor?.kind ? '<label class="hint" title="Para gente de sus redes, fuera de su curso: 20 días gratis con tarjeta, el primer mes 15 USD y después 20. Cuentan igual para sus alumnos y comisiones."><input type="checkbox" data-msocial> Para redes</label>' : ''}<button type="button" class="primary" data-madd="${esc(name)}">＋ Agregar a la lista</button></div>
            <div class="hint">Se guardan en su lista «${esc(name)}» (el nombre no va dentro del código)${last.redeem_until && Date.parse(last.redeem_until) > Date.now() ? `, canjear antes del ${esc(new Date(last.redeem_until).toLocaleDateString('es-DO'))}` : ''}. Quien canjea tiene esos días gratis; después le sale ${mentor?.kind === 'mila' ? 'el precio de regalo (15 USD el primer mes, luego 20; el anual, 30 USD menos el primer año)' : mentor?.kind === 'influencer' ? 'el precio de influencer (17 USD el primer mes, luego 20)' : 'el precio de mentoría (15 USD los 2 primeros meses, luego 20); con «Para redes», el precio de regalo (15 USD solo el primer mes, luego 20)'}.</div>
            <textarea data-mmade rows="4" readonly hidden style="width:100%;margin-top:8px"></textarea>
          </div>
        </div>
        ${mentor?.kind === 'mila' ? '' : accountHtml(name)}
        ${checkoutHtml(name)}
        ${mentor?.kind === 'mila' ? '' : commissionHtml(name)}
        <h3>Alumnos</h3>
        <div class="row">${chip('', students.length)}${['pagando', 'gratis', 'sin_pagar', 'cancelo', 'otro_acceso'].filter(st => st !== 'otro_acceso' || sum.count[st]).map(st => chip(st, sum.count[st])).join('')}</div>
        <div class="tablewrap"><table><thead><tr><th>Usuario</th><th>Correo</th><th title="🌐 = código para redes">Código</th><th>Canjeó</th><th>Estado</th></tr></thead><tbody>${shown.length ? shown.map(s => {
          const st = MilaCore.mentorStudentState(s, now);
          const prize = st === 'pagando' && mentor?.kind !== 'mila' ? ` <button type="button" class="small" data-sprize="${esc(s.user_id)}" data-who="${esc(s.username || s.email || '')}">🎁 Dar premio de 1 mes</button>` : '';
          return `<tr><td><b>${esc(s.username || 'Sin usuario')}</b></td><td class="small">${esc(s.email || '')}</td><td class="small">${s.codes.map(c => esc(c) + (socialCodes.has(c) ? ' 🌐' : '')).join(', ')}</td><td class="small">${esc(date(s.redeemed_at))}</td><td><span class="tag ${STATE_TAGS[st]}">${esc(STATE_LABELS[st])}</span> <span class="small">${esc(detail(s))}</span>${prize}</td></tr>`;
        }).join('') : '<tr><td colspan="5" class="empty">Nadie en este grupo.</td></tr>'}</tbody></table></div>
        ${(() => { // «Para redes» codes get their own list and PDF (owner, 2026-11-24)
          const social = codes.filter(c => c.offer === 'mila'), course = codes.filter(c => c.offer !== 'mila');
          const free = list => list.filter(c => c.active && Number(c.uses) < Number(c.max_uses || 1)).length;
          const block = (list, offer, title) => `${title ? `<h3 style="margin-top:14px">${title}</h3>` : ''}<div class="row" style="margin-top:10px"><button type="button" data-mpdf="${esc(name)}" data-moffer="${offer}">📄 PDF ${offer === 'redes' ? 'de los códigos para redes' : social.length ? 'de los códigos del curso' : 'con todos sus códigos'}</button><span class="hint">Siempre al día: incluye los que agregues. Los ya usados salen tachados.</span></div>
            <details class="group" style="margin-top:8px"><summary>${offer === 'redes' ? 'Códigos para redes' : social.length ? 'Códigos del curso' : 'Sus códigos'}<small>${list.length} en total · ${free(list)} libres</small></summary><div class="list">${list.map(codeItem).join('')}</div></details>`;
          return social.length ? block(course, 'curso', '🎓 Códigos para su curso') + block(social, 'redes', '🌐 Códigos para redes (20 días, primer mes 15 USD)')
            : block(course, 'curso', '');
        })()}
      </div>`;
    }).join('');
  }
  const usd = c => `${(Number(c || 0) / 100).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
  // 💰 Ganancias (owner, 2026-11-24): its own screen, opened from the button at the top right.
  // A period, a month of the chart or an origin can be picked; everything below follows it.
  let billing = null, earningsPeriod = 'month', earningsSource = null;
  async function loadEarnings() {
    try {
      billing = await rpc('admin_billing_overview');
      renderEarnings();
    } catch (error) { $('earnings').innerHTML = `<div class="empty">${esc(error.status === 404 ? 'Falta aplicar en la base de datos la función de ganancias.' : error.message)}</div>`; }
  }
  function showEarnings(on) {
    if (on && currentMentor) showMentor('');
    $('app').classList.toggle('earnings-view', on);
    $('ganancias').hidden = !on;
    $('earningsOpen').classList.toggle('on', on);
    document.querySelector('main').classList.toggle('wide', on);
    if (on) { renderEarnings(); window.scrollTo({ top: 0 }); }
  }
  // [from, to) in UTC months, as 'YYYY-MM' (null = open).
  function earningsRange(period) {
    const d = new Date(), y = d.getUTCFullYear(), m = d.getUTCMonth();
    const key = (yy, mm) => new Date(Date.UTC(yy, mm, 1)).toISOString().slice(0, 7);
    if (period === 'month') return [key(y, m), null];
    if (period === 'last') return [key(y, m - 1), key(y, m)];
    if (period === '3m') return [key(y, m - 2), null];
    if (period === 'year') return [key(y, 0), null];
    if (/^m:\d{4}-\d{2}$/.test(period)) { const [yy, mm] = period.slice(2).split('-').map(Number); return [period.slice(2), key(yy, mm)]; }
    return [null, null];
  }
  const inRange = (month, [from, to]) => (!from || month >= from) && (!to || month < to);
  function renderEarnings() {
    if (!billing || $('ganancias').hidden) return;
    const range = earningsRange(earningsPeriod);
    const sameSource = s => earningsSource === null || (earningsSource === '' ? !mentorRows.some(m => m.name.toLowerCase() === String(s || '').toLowerCase()) : String(s || '').toLowerCase() === earningsSource.toLowerCase());
    const all = billing.payments || [];
    const inPeriod = all.filter(p => inRange(String(p.occurred_at || '').slice(0, 7), range));
    const shown = inPeriod.filter(p => sameSource(p.source));
    // Commissions of the charges in the period (they count in the month of the charge); what is owed is always today's.
    const commissions = { earnedCents: 0, paidCents: 0, owedCents: 0 }, waiting = [];
    for (const m of mentorRows) {
      if (m.kind === 'mila' || (earningsSource !== null && m.name.toLowerCase() !== String(earningsSource).toLowerCase())) continue;
      const key = m.name.toLowerCase(), payouts = mentorPayouts.filter(p => String(p.mentor || '').toLowerCase() === key);
      const c = MilaCore.mentorCommissions({ payments: mentorPayments.filter(p => String(p.mentor || '').toLowerCase() === key), payouts, now: Date.now(), kind: m.kind });
      commissions.earnedCents += c.months.filter(x => inRange(x.month, range)).reduce((a, x) => a + x.commissionCents, 0);
      commissions.paidCents += payouts.filter(p => inRange(String(p.paid_at || '').slice(0, 7), range)).reduce((a, p) => a + Number(p.amount_cents || 0), 0);
      commissions.owedCents += c.owedCents;
      waiting.push(...c.pending.filter(x => x.estimateCents > 0));
    }
    // Commissions still in their 30 days (always as of today): shown so that money is not lost from sight.
    const waitCents = waiting.reduce((a, x) => a + x.estimateCents, 0);
    const nextRelease = waiting.map(x => x.releaseAt).sort()[0];
    const e = MilaCore.earningsSummary({ payments: shown, subscriptions: (billing.subscriptions || []).filter(s => sameSource(s.source)), partners: mentorRows, commissions });
    const bySource = MilaCore.earningsSummary({ payments: inPeriod, partners: mentorRows }).sources;
    const chart = MilaCore.earningsSummary({ payments: all.filter(p => sameSource(p.source)), partners: mentorRows }).months;
    const t = e.totals, sub = e.subscriptions;
    const pct = (a, b) => b > 0 ? Math.round(a / b * 100) : 0;
    const monthName = (m, long) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('es-DO', { month: long ? 'long' : 'short', year: 'numeric' });
    const sourceName = s => s.source ? `${partnerBadge(s.kind).icon} ${s.source}` : '🌐 Público (sin código de socia)';
    for (const b of $('earningsPeriods').querySelectorAll('button')) b.classList.toggle('on', b.dataset.period === earningsPeriod);
    // The chart: the last 12 months with charges, or at least the current one.
    const nowKey = new Date().toISOString().slice(0, 7);
    const months = chart.length ? chart.slice(-12) : [{ month: nowKey, keepCents: 0, grossCents: 0, charges: 0 }];
    const top = Math.max(1, ...months.map(m => m.keepCents));
    const parts = [['Impuestos', t.taxCents, '#64748b'], ['Comisión de Paddle', t.feeCents, '#8b5cf6'], ['Reembolsos', t.refundNetCents, '#f87171'], ['Comisiones de socias', t.commissionCents, '#fbbf24'], ['Tu ganancia', Math.max(0, t.realCents), 'var(--o)']];
    const filterLabel = [earningsPeriod.startsWith('m:') ? `<b>${esc(monthName(earningsPeriod.slice(2), true))}</b>` : '',
      earningsSource !== null ? `<b>${esc(earningsSource ? earningsSource : 'Público')}</b>` : ''].filter(Boolean);
    $('earnings').innerHTML = `
      ${filterLabel.length ? `<div class="eg-filter">Viendo solo ${filterLabel.join(' · ')} <button type="button" data-eclear>✕ Quitar filtro</button></div>` : ''}
      <div class="eg-kpis">
        <div class="eg-kpi"><span>Cobrado</span><b>${esc(usd(t.grossCents))}</b><small>${t.charges} ${t.charges === 1 ? 'cobro' : 'cobros'}${t.refunds ? ` · ${t.refunds} ${t.refunds === 1 ? 'reembolso' : 'reembolsos'}` : ''}</small></div>
        <div class="eg-kpi"><span>Te llega de Paddle</span><b>${esc(usd(t.keepCents))}</b><small>después de impuestos, Paddle y reembolsos</small></div>
        <div class="eg-kpi hero"><span>Tu ganancia real</span><b>${esc(usd(t.realCents))}</b><small>${pct(t.realCents, t.grossCents)} % de lo cobrado, ya sin comisiones</small></div>
        <div class="eg-kpi"><span>Les debes a tus socias</span><b>${esc(usd(t.commissionOwedCents))}</b><small>${esc(usd(t.commissionCents))} ganadas en el período · ${esc(usd(t.commissionPaidCents))} pagadas</small></div>
      </div>
      ${waitCents > 0 ? `<div class="eg-wait">⏳ <span><b>En espera: ${esc(usd(waitCents))}</b> de comisiones que contarán en los próximos 30 días (${waiting.length} ${waiting.length === 1 ? 'cobro' : 'cobros'}; el primero cuenta el ${esc(new Date(nextRelease).toLocaleDateString('es-DO'))}). Todavía no se las debes: si hay un reembolso antes, no cuentan.</span></div>` : ''}
      <div class="eg-card"><h3>Adónde va cada dólar cobrado</h3>
        <div class="eg-stack" id="egStack">${t.grossCents > 0 ? parts.filter(p => p[1] > 0).map(([n, v, c], i) => `<i data-part="${i}" style="flex:${v};background:${c}" title="${esc(n)}: ${esc(usd(v))}"></i>`).join('') : ''}</div>
        <div class="eg-legend">${parts.map(([n, v, c], i) => `<div data-part="${i}" style="--c:${c}"><span>${esc(n)}</span><b>${esc(usd(v))}</b><small class="hint" style="margin:0">${pct(v, t.grossCents)} %</small></div>`).join('')}</div>
      </div>
      <div class="eg-card"><h3>Lo que te llega cada mes</h3>
        <div class="eg-chart">${months.map(m => `<button type="button" data-emonth="${esc(m.month)}" class="${earningsPeriod === 'm:' + m.month ? 'on ' : ''}${inRange(m.month, range) ? 'in' : ''}" title="${esc(monthName(m.month, true))}: ${m.charges} ${m.charges === 1 ? 'cobro' : 'cobros'}"><em>${esc(usd(m.keepCents))}</em><i style="height:${Math.max(2, Math.round(m.keepCents / top * 100))}%"></i></button>`).join('')}</div>
        <div class="eg-labels">${months.map(m => `<span>${esc(monthName(m.month))}</span>`).join('')}</div>
        <div class="hint">En naranja, los meses del período que estás viendo. Toca un mes para ver solo ese mes.</div>
      </div>
      <div class="eg-grid">
        <div class="eg-card"><h3>De dónde viene el dinero</h3>
          ${bySource.length ? `<div class="eg-src">${bySource.map(s => { const total = bySource.reduce((a, x) => a + x.grossCents, 0); return `<button type="button" data-esource="${esc(s.source)}" class="${earningsSource !== null && earningsSource.toLowerCase() === s.source.toLowerCase() ? 'on' : ''}"><span>${esc(sourceName(s))}</span><b>${esc(usd(s.grossCents))}</b><small>${s.people} ${s.people === 1 ? 'persona pagó' : 'personas pagaron'} · te llega ${esc(usd(s.keepCents))}</small><small>${pct(s.grossCents, total)} %</small><span class="bar"><i style="width:${pct(s.grossCents, total)}%"></i></span></button>`; }).join('')}</div><div class="hint">Toca un origen para ver solo sus números.</div>` : '<div class="empty">Todavía no hay cobros en este período.</div>'}
        </div>
        <div class="eg-card"><h3>Suscripciones ahora</h3>
          <div class="eg-subs">
            <div class="wide"><b>${esc(usd(sub.recurringCents))}</b><span>entra fijo cada mes (aprox., precio de lista)</span></div>
            <div><b>${sub.active}</b><span>pagando · ${sub.monthly} mensual, ${sub.annual} anual</span></div>
            <div><b>${sub.trial}</b><span>en prueba gratis</span></div>
            <div><b>${sub.canceledThisMonth}</b><span>cancelaron este mes</span></div>
            <div><b>${sub.pastDue}</b><span>con un pago fallido</span></div>
          </div>
        </div>
      </div>
      <div class="eg-card"><h3>Movimientos${shown.length > 60 ? ' (los 60 más recientes)' : ''}</h3>
        ${shown.length ? `<div class="tablewrap"><table><thead><tr><th>Fecha</th><th>Tipo</th><th>Origen</th><th>Cobrado</th><th>Impuesto</th><th>Paddle</th><th>Te llega</th></tr></thead><tbody>${shown.slice(0, 60).map(p => `<tr><td>${esc(date(p.occurred_at))}</td><td>${p.kind === 'refund' ? '<span class="tag warn">Reembolso</span>' : p.kind === 'charge' ? `<span class="tag ${['completed', 'paid'].includes(p.status) ? 'ok' : ''}">${['completed', 'paid'].includes(p.status) ? 'Cobro' : esc(p.status)}</span>` : esc(p.kind)}</td><td class="small">${esc(p.source || 'Público')}</td><td>${esc(usd(p.total_cents))}</td><td class="small">${esc(usd(p.tax_cents))}</td><td class="small">${esc(usd(p.fee_cents))}</td><td><b>${esc(usd(p.kind === 'refund' ? -Number(p.net_cents || 0) : p.net_cents))}</b></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No hay movimientos en este período.</div>'}
      </div>`;
  }
  function earningsClick(event) {
    const b = event.target.closest('button');
    if (!b) return;
    if (b.dataset.period) { earningsPeriod = b.dataset.period; renderEarnings(); }
    else if (b.dataset.emonth) { earningsPeriod = earningsPeriod === 'm:' + b.dataset.emonth ? 'all' : 'm:' + b.dataset.emonth; renderEarnings(); }
    else if (b.dataset.esource !== undefined) { earningsSource = earningsSource !== null && earningsSource.toLowerCase() === b.dataset.esource.toLowerCase() ? null : b.dataset.esource; renderEarnings(); }
    else if (b.dataset.eclear !== undefined) { earningsSource = null; if (earningsPeriod.startsWith('m:')) earningsPeriod = 'all'; renderEarnings(); }
  }
  // Hovering a part of the dollar bar (or its legend) lights it up.
  function earningsHover(event) {
    const part = event.target.closest('[data-part]')?.dataset.part, stack = $('egStack');
    if (!stack) return;
    stack.classList.toggle('hl', part !== undefined);
    for (const i of stack.querySelectorAll('i')) i.classList.toggle('on', i.dataset.part === part);
  }
  function downloadEarningsCsv() {
    if (!billing) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + MilaCore.earningsCsv(billing.payments)], { type: 'text/csv;charset=utf-8' }));
    a.download = `mila-desk-pagos-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function commissionHtml(name) {
    const key = name.toLowerCase();
    const payouts = mentorPayouts.filter(p => String(p.mentor || '').toLowerCase() === key);
    const kind = mentorRows.find(m => m.name.toLowerCase() === key)?.kind || 'mentora';
    const c = MilaCore.mentorCommissions({ payments: mentorPayments.filter(p => String(p.mentor || '').toLowerCase() === key), payouts, now: Date.now(), kind });
    const monthName = m => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('es-DO', { month: 'long', year: 'numeric' });
    return `<h3>Comisiones</h3>
      <div class="stats">${[[usd(c.owedCents), 'por pagarle'], [usd(c.earnedCents), 'ganado en total'], [usd(c.paidCents), 'ya pagado'], [usd(c.pendingCents), `en espera (${c.pendingCount} ${c.pendingCount === 1 ? 'cobro' : 'cobros'} de menos de 30 días)`]].map(([n, t]) => `<div class="stat"><b>${esc(n)}</b><span>${esc(t)}</span></div>`).join('')}</div>
      <div class="hint">Sobre lo que te queda a ti de cada cobro (después del impuesto y la comisión de Paddle), menos reembolsos. Un cobro cuenta a los 30 días. ${kind === 'influencer' ? 'Influencer: una sola vez por persona, en su primer cobro: 5 USD si es mensual, 15 USD si es anual.' : 'Plan mensual: 1–25 alumnos pagando en el mes: 25 %; 26–50: 30 %; 51–99: 35 %; 100 o más: 40 %. Plan anual: 25 USD fijos por cada año pagado (no cuenta para el porcentaje).'} Con menos de 25 USD por pagar, se acumula.</div>
      ${c.months.length ? `<div class="tablewrap"><table><thead><tr><th>Mes del cobro</th><th>Mensuales</th><th>Neto tuyo</th><th>%</th><th>Fijos (anual o influencer)</th><th>Comisión</th></tr></thead><tbody>${c.months.slice().reverse().map(m => `<tr><td>${esc(monthName(m.month))}</td><td>${m.students}</td><td>${esc(usd(m.netCents))}</td><td>${m.students ? Math.round(m.rate * 100) + ' %' : '—'}</td><td>${m.fixedCount ? `${m.fixedCount} · ${esc(usd(m.fixedCents))}` : '—'}</td><td><b>${esc(usd(m.commissionCents))}</b></td></tr>`).join('')}</tbody></table></div>` : '<div class="hint">Todavía no hay cobros con 30 días. Los pagos se guardan desde el 16 de noviembre de 2026.</div>'}
      <div class="row" style="margin-top:8px"><button type="button" class="${c.canPay ? 'primary' : ''}" data-mpayout="${esc(name)}" data-owed="${c.owedCents}">💵 Registrar un pago a ${esc(name)}</button>${c.canPay ? '' : c.owedCents > 0 ? '<span class="hint">Todavía no llega a 25 USD: se acumula para el próximo mes.</span>' : ''}</div>
      ${payouts.length ? `<div class="list" style="margin-top:8px">${payouts.map(p => `<div class="item"><div><b>${esc(usd(p.amount_cents))}</b><small>pagado el ${esc(new Date(`${p.paid_at}T12:00:00`).toLocaleDateString('es-DO'))}${p.note ? ` · ${esc(p.note)}` : ''}</small></div></div>`).join('')}</div>` : ''}`;
  }
  // Opening a mentor shows only her panel, like another screen of this page; «Volver» or any
  // menu link brings the whole page back. Never a new Chrome tab.
  function showMentor(name) {
    currentMentor = name;
    $('app').classList.toggle('mentor-view', !!name);
    $('sectionsNav').classList.toggle('mentor-view', !!name);
    renderMentors();
    window.scrollTo({ top: 0 });
  }
  async function mentorClick(event) {
    const b = event.target.closest('button'); if (!b) return;
    const card = b.closest('[data-mentor-card]'); const msg = $('mentorMsg');
    if (b.dataset.mopen || b.dataset.mback !== undefined) {
      showMentor(b.dataset.mopen || ''); msg.textContent = ''; return;
    }
    if (b.dataset.mview) { window.open(chrome.runtime.getURL(`socia.html?socia=${encodeURIComponent(b.dataset.mview)}`), '_blank'); return; }
    if (b.dataset.mfilter !== undefined) { mentorFilter.set(b.dataset.mentor.toLowerCase(), b.dataset.mfilter); renderMentors(); return; }
    if (b.dataset.mcheckout || b.dataset.mcheckoutoff) {
      if (b.dataset.mcheckoutoff && !confirm('¿Quitar este descuento de la mentora? Los alumnos ya ligados se quedan con ella.')) return;
      b.disabled = true;
      try {
        if (b.dataset.mcheckoutoff) await rpc('admin_remove_checkout_discount', { p_discount_id: b.dataset.mcheckoutoff });
        else await rpc('admin_set_checkout_code', { p_mentor: b.dataset.mcheckout, p_code: card.querySelector('[data-mccode]').value, p_discount_id: card.querySelector('[data-mcdsc]').value });
        msg.textContent = b.dataset.mcheckoutoff ? 'Descuento quitado.' : 'Código ligado a la mentora.';
        await loadMentorPanel();
      } catch (error) {
        msg.textContent = /format/.test(error.message) ? 'Revisa el código (6 a 40 letras o números) y el ID del descuento (empieza con dsc_).' : /code in use/.test(error.message) ? 'Ese código ya existe para otra cosa: usa otro nombre.' : error.message;
        b.disabled = false;
      }
      return;
    }
    if (b.dataset.msave) {
      b.disabled = true;
      try {
        const kind = card.querySelector('[data-mkind]').value;
        if (kind !== (mentorRows.find(m => m.name.toLowerCase() === b.dataset.msave.toLowerCase())?.kind || 'mentora')) await rpc('admin_set_mentor_kind', { p_name: b.dataset.msave, p_kind: kind });
        const startedAt = card.querySelector('[data-mstart]').value || null;
        await rpc('admin_save_mentor', { p_name: b.dataset.msave, p_started_at: startedAt, p_active: card.querySelector('[data-mactive]').checked, p_notes: card.querySelector('[data-mnotes]').value });
        msg.textContent = `Guardado: ${b.dataset.msave}.`;
        // A mentor's alliance gives her 1 year of Premium from its start: extend her access to
        // that day, never shorten it (no end date, admin, or a later date stay as they are).
        const yearEnd = kind === 'mentora' ? MilaCore.mentorFreeYearEnd(startedAt) : null, a = mentorAccount(b.dataset.msave);
        if (yearEnd && a && a.plan !== 'admin' && !(a.plan && !a.expires_at) && !(Date.parse(a.expires_at || '') >= Date.parse(endOfDay(yearEnd)))) {
          const r = await rpc('admin_grant_access', { p_who: a.email, p_expires_at: endOfDay(yearEnd), p_note: `Mentora ${a.name}: año gratis de la alianza` });
          if (r?.ok) msg.textContent += ` Su año de Premium gratis quedó hasta el ${yearEnd.split('-').reverse().join('/')}.`;
        }
        await loadMentorPanel();
      } catch (error) { msg.textContent = error.message; b.disabled = false; }
      return;
    }
    if (b.dataset.mnew !== undefined || b.dataset.mlink || b.dataset.munlink) {
      const box = b.closest('.item, [data-mentor-card]');
      const name = b.dataset.mnew !== undefined ? box.querySelector('[data-newname]').value.trim() : b.dataset.mlink || b.dataset.munlink;
      const who = b.dataset.munlink ? '' : box.querySelector('[data-mwho]').value.trim();
      if (!name) { msg.textContent = 'Escribe el nombre de la mentora.'; return; }
      if (!b.dataset.munlink && !who) { msg.textContent = 'Escribe el correo o el usuario de su cuenta.'; return; }
      if (b.dataset.munlink && !confirm(`¿Desvincular la cuenta de ${name}? No se le quita el acceso ni se borra nada.`)) return;
      if (b.dataset.mnew !== undefined && mentorNames().some(n => n.toLowerCase() === name.toLowerCase())) { msg.textContent = `Ya existe la mentora ${name}: ábrela para vincular su cuenta.`; return; }
      b.disabled = true;
      try {
        const r = await rpc('admin_link_mentor_account', { p_name: name, p_who: who });
        if (!r?.ok) { msg.textContent = r?.reason === 'taken' ? `Esa cuenta ya está vinculada a la mentora ${r.mentor}.` : LINK_ERRORS[r?.reason] || 'No se pudo vincular.'; b.disabled = false; return; }
        msg.textContent = b.dataset.munlink ? `Cuenta desvinculada de ${name}.` : `Cuenta vinculada a ${name}.`;
        await loadMentorPanel();
        if (b.dataset.mnew !== undefined) showMentor(name);
      } catch (error) { msg.textContent = error.message; b.disabled = false; }
      return;
    }
    if (b.dataset.mgrant || b.dataset.mrevoke) {
      const a = mentorAccount(b.dataset.mgrant || b.dataset.mrevoke); if (!a) return;
      const who = a.username || a.email;
      const until = card.querySelector('[data-muntil]').value;
      const when = until ? `hasta el ${until.split('-').reverse().join('/')}` : 'sin fecha de fin';
      if (!confirm(b.dataset.mrevoke ? `¿Quitarle el acceso a ${who}?` : `¿Dar acceso Premium a ${who}, ${when}?`)) return;
      b.disabled = true;
      try {
        if (b.dataset.mrevoke) await rpc('admin_revoke_access', { p_user_id: a.user_id });
        else { const r = await rpc('admin_grant_access', { p_who: a.email, p_expires_at: endOfDay(until), p_note: `Mentora ${a.name}` }); if (!r?.ok) throw new Error('No se encontró la cuenta.'); }
        msg.textContent = b.dataset.mrevoke ? `Acceso quitado a ${who}.` : `Acceso Premium dado a ${who}, ${when}.`;
        await Promise.all([loadMentorPanel(), loadAccess()]);
      } catch (error) { msg.textContent = error.message; b.disabled = false; }
      return;
    }
    if (b.dataset.mpayout) {
      const name = b.dataset.mpayout, owed = Number(b.dataset.owed) || 0;
      const raw = prompt(`¿Cuánto le pagaste a ${name}? (USD)`, owed > 0 ? (owed / 100).toFixed(2) : '');
      if (raw === null) return;
      const cents = Math.round(Number(String(raw).replace(',', '.')) * 100);
      if (!Number.isFinite(cents) || cents <= 0) { msg.textContent = 'Escribe una cantidad mayor que 0.'; return; }
      const note = prompt('Nota (opcional): cómo se pagó, referencia…', '') || '';
      b.disabled = true;
      try {
        await rpc('admin_add_mentor_payout', { p_mentor: name, p_amount_cents: cents, p_paid_at: null, p_note: note });
        msg.textContent = `Registrado: ${usd(cents)} pagados a ${name}.`;
        await loadMentorPanel();
      } catch (error) { msg.textContent = error.message; b.disabled = false; }
      return;
    }
    if (b.dataset.sprize) {
      if (!confirm(`¿Dar el premio a ${b.dataset.who}? Paddle no le cobrará su próximo mes y después vuelve a cobrarle normal. Si todavía tenía el descuento de mentoría, el premio lo reemplaza.`)) return;
      b.disabled = true;
      try {
        const c = await connection();
        const response = await fetch(`${c.url}/functions/v1/admin-prize`, {
          method: 'POST', headers: { apikey: c.key, Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: b.dataset.sprize })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `No se pudo dar el premio (${response.status}).`);
        msg.textContent = `Premio aplicado a ${b.dataset.who}. Su próximo cobro${data.next_billed_at ? ` (${date(data.next_billed_at)})` : ''} será de 0 USD.`;
        b.textContent = '✓ Premio dado';
        return;
      } catch (error) { msg.textContent = error.message; }
      b.disabled = false;
      return;
    }
    if (b.dataset.mpdf) {
      const name = b.dataset.mpdf;
      const social = b.dataset.moffer === 'redes';
      const codes = allCodes.filter(c => String(c.label || '').trim().toLowerCase() === name.toLowerCase() && (c.offer === 'mila') === social)
        .sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0) || a.code.localeCompare(b.code));
      if (!codes.length) { msg.textContent = social ? 'Esta mentora no tiene códigos para redes.' : 'Esta mentora no tiene códigos.'; return; }
      const last = codes[codes.length - 1];
      const until = last.redeem_until && Date.parse(last.redeem_until) > Date.now() ? new Date(last.redeem_until).toLocaleDateString('es-DO') : '';
      printPdf({ codes: codes.map(c => c.code), label: `${codes[0].label || name}${social ? ' · para redes' : allCodes.some(c => c.offer === 'mila' && String(c.label || '').trim().toLowerCase() === name.toLowerCase()) ? ' · curso' : ''}`, days: Number(last.access_days) > 0 ? Number(last.access_days) : 30, until,
        used: codes.filter(c => Number(c.uses) >= Number(c.max_uses || 1)).map(c => c.code) });
      return;
    }
    if (b.dataset.madd) {
      const name = b.dataset.madd, count = Math.max(1, Math.min(300, Math.floor(Number(card.querySelector('[data-mcount]').value) || 0)));
      const codes = allCodes.filter(c => String(c.label || '').trim().toLowerCase() === name.toLowerCase());
      const last = codes.slice().sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))[0] || {};
      const days = Math.floor(Number(card.querySelector('[data-mdays]').value) || 0), social = !!card.querySelector('[data-msocial]')?.checked;
      if (days < 1 || days > 3650) { msg.textContent = 'Escribe los días gratis (por ejemplo, 30).'; return; }
      const redeemUntil = last.redeem_until && Date.parse(last.redeem_until) > Date.now() ? last.redeem_until : null;
      if (!confirm(`¿Crear ${count} códigos más para ${name} (${days} días${social ? ', para redes: primer mes 15 USD' : ''})?`)) return;
      b.disabled = true;
      const made = await makeCodes({ count, label: codes[0]?.label || name, days, redeemUntil, msg });
      let marked = 0;
      if (social) for (const code of made) { try { if (await rpc('admin_set_beta_code_offer', { p_code: code, p_offer: 'mila' })) marked++; } catch {} }
      b.disabled = false;
      if (!made.length) return;
      if (social && marked < made.length) msg.textContent = `Se crearon ${made.length} códigos, pero ${made.length - marked} no quedaron como «para redes». Desactívalos y vuelve a intentarlo.`;
      else if (made.length === count) msg.textContent = `Listo: ${made.length} códigos nuevos${social ? ' para redes' : ''} para ${name}. Aparecen abajo para copiarlos.`;
      await loadAccess();
      const box = document.querySelector(`[data-mentor-card="${CSS.escape(name)}"] [data-mmade]`);
      if (box) { box.value = made.join('\n'); box.hidden = false; box.select(); }
      return;
    }
    if (b.closest('.item')) accessClick(event); // copy, disable or delete one of her codes
  }

  // ── Free Samples: pending requests and categories ───────────────────────────────
  async function proofUrl(path) {
    if (!path) return '';
    const c = await connection();
    const response = await fetch(`${c.url}/storage/v1/object/sign/free-sample-proofs/${String(path).split('/').map(encodeURIComponent).join('/')}`, {
      method: 'POST', headers: { apikey: c.key, Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 3600 })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return '';
    const signed = data?.signedURL || data?.signedUrl || data?.signed_url || '';
    return !signed ? '' : signed.startsWith('http') ? signed : `${c.url}/storage/v1${signed.startsWith('/') ? signed : '/' + signed}`;
  }
  async function lookupCategories(brand) {
    const res = await chrome.runtime.sendMessage({ type: 'MILA_FREE_SAMPLE_CATEGORIES', brand });
    if (!res?.ok) throw new Error(res?.error || 'No se pudieron leer las categorías de Amazon.');
    return MilaCore.knownSampleCategories(res.nodes);
  }
  async function loadApproved() {
    const base = 'free_sample_submissions?select=id,brand_name', query = '&status=eq.approved&order=submitted_at.desc';
    try { approved = await request(`${base},categories_checked_at${query}`); categoriesReady = true; }
    catch (error) { if (error.status !== 400) throw error; categoriesReady = false; approved = await request(`${base}${query}`); }
    $('fillBtn').hidden = !categoriesReady;
  }
  async function loadSamples() {
    const box = $('sampleCards'), msg = $('sampleMsg');
    msg.textContent = '';
    box.innerHTML = '<div class="empty">Cargando…</div>';
    try {
      const [rows] = await Promise.all([
        request('free_sample_submissions?select=id,brand_name,submitted_by,proof_image_path,submitted_at&status=eq.pending&order=submitted_at.desc'),
        loadApproved()
      ]);
      if (!Array.isArray(rows) || !rows.length) { box.innerHTML = `<div class="empty">No hay solicitudes pendientes. Marcas aprobadas: ${approved.length}.</div>`; return; }
      const ids = [...new Set(rows.map(r => String(r.submitted_by || '')).filter(id => /^[0-9a-f-]{36}$/i.test(id)))];
      const profiles = ids.length ? await request(`profiles?select=id,username&id=in.(${ids.join(',')})`).catch(() => []) : [];
      const names = new Map((Array.isArray(profiles) ? profiles : []).map(p => [String(p.id), String(p.username || 'Sin usuario')]));
      const cards = [];
      for (const row of rows) {
        const url = await proofUrl(row.proof_image_path).catch(() => '');
        const proof = url ? `<img src="${esc(url)}" alt="Prueba de ${esc(row.brand_name)}">` : `<div class="hint">${row.proof_image_path ? 'No se pudo cargar la prueba.' : 'Sin prueba.'}</div>`;
        cards.push(`<div class="card" data-sample="${esc(row.id)}" data-brand="${esc(row.brand_name)}"><b>${esc(row.brand_name)}</b>`
          + `<div class="label">Enviado por</div><div>${esc(names.get(String(row.submitted_by)) || 'Sin usuario')} · <span class="hint">${esc(date(row.submitted_at))}</span></div>`
          + `<div class="label">Campañas</div><a href="${esc(MilaCore.freeSampleCampaignUrl(row.brand_name))}" target="_blank" rel="noopener">Ver campañas de ${esc(row.brand_name)} ↗</a>`
          + `<div class="label">Prueba</div>${proof}`
          + `<div class="actions" style="margin-top:12px"><button type="button" class="primary" data-review="approved">Aprobar</button><button type="button" class="danger" data-review="rejected">Rechazar</button></div></div>`);
      }
      box.innerHTML = cards.join('');
    } catch (error) { box.innerHTML = '<div class="empty">No se pudieron cargar las solicitudes.</div>'; msg.textContent = error.message; }
  }
  async function review(button) {
    const card = button.closest('[data-sample]'), status = button.dataset.review;
    if (!card || !confirm(status === 'approved' ? '¿Aprobar esta solicitud de Free Sample?' : '¿Rechazar esta solicitud de Free Sample?')) return;
    card.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      const c = await connection();
      let categories = {};
      if (status === 'approved' && categoriesReady) {
        try { categories = { category_nodes: await lookupCategories(card.dataset.brand), categories_checked_at: new Date().toISOString() }; }
        catch { categories = { category_nodes: [] }; }
      }
      await request(`free_sample_submissions?id=eq.${encodeURIComponent(card.dataset.sample)}&status=eq.pending`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { status, reviewed_at: new Date().toISOString(), reviewed_by: c.userId, ...categories }
      });
      $('sampleMsg').textContent = `${card.dataset.brand}: ${status === 'approved' ? 'aprobada' : 'rechazada'}.`;
      await loadSamples();
    } catch (error) { card.querySelectorAll('button').forEach(b => { b.disabled = false; }); $('sampleMsg').textContent = error.message; }
  }
  // One brand at a time with a pause, so Amazon never gets a burst. Brands checked in the
  // last 24 hours are skipped, so closing the tab only pauses the work.
  async function fillCategories() {
    if (filling || !categoriesReady) return;
    const msg = $('fillMsg');
    const due = approved.filter(x => !x.categories_checked_at || Date.now() - Date.parse(x.categories_checked_at) > FILL_AGAIN_AFTER);
    if (!due.length) { msg.textContent = 'Todas las marcas se revisaron en las últimas 24 horas.'; return; }
    filling = true; $('fillBtn').disabled = true;
    let found = 0, empty = 0;
    try {
      for (const [index, item] of due.entries()) {
        if (index) await new Promise(resolve => setTimeout(resolve, FILL_PAUSE));
        msg.textContent = `Revisando ${index + 1} de ${due.length}: ${item.brand_name}. Si cierras esta pestaña, se retoma al volver a pulsar.`;
        const nodes = await lookupCategories(item.brand_name);
        const checkedAt = new Date().toISOString();
        await request(`free_sample_submissions?id=eq.${encodeURIComponent(item.id)}&status=eq.approved`, {
          method: 'PATCH', prefer: 'return=minimal', body: { ...(nodes.length ? { category_nodes: nodes } : {}), categories_checked_at: checkedAt }
        });
        item.categories_checked_at = checkedAt;
        if (nodes.length) found++; else empty++;
      }
      msg.textContent = `Listo: ${found} con categorías de Amazon${empty ? ` y ${empty} sin campañas abiertas` : ''}.`;
    } catch (error) { msg.textContent = `Se detuvo: ${error.message} Puedes volver a pulsar para seguir.`; }
    finally { filling = false; $('fillBtn').disabled = false; }
  }

  // ── Suggestions and bug reports (25.35.0) ───────────────────────────────────────
  const FEEDBACK_KINDS = { suggestion: '💡 Sugerencia', bug: '🐞 Error' };
  const FEEDBACK_STATUS = { new: ['Nuevo', 'warn'], seen: ['Visto', ''], resolved: ['Resuelto', 'ok'] };
  let feedback = [];
  async function loadFeedback() {
    const msg = $('feedbackMsg');
    msg.textContent = '';
    try {
      const rows = await rpc('admin_feedback', { p_limit: 300 });
      feedback = Array.isArray(rows) ? rows : [];
      renderFeedback();
    } catch (error) {
      $('feedbackList').innerHTML = '<div class="empty">No se pudieron cargar los mensajes.</div>';
      msg.textContent = error.status === 404 ? 'Falta aplicar en la base de datos la función de sugerencias.' : error.message;
    }
  }
  function renderFeedback() {
    const fresh = feedback.filter(r => r.status === 'new').length;
    $('feedbackNewBadge').hidden = !fresh;
    $('feedbackNewBadge').textContent = fresh;
    $('feedbackStats').innerHTML = [
      [fresh, 'nuevos'],
      [feedback.filter(r => r.kind === 'suggestion').length, 'sugerencias'],
      [feedback.filter(r => r.kind === 'bug').length, 'errores'],
      [feedback.filter(r => r.status === 'resolved').length, 'resueltos']
    ].map(([n, t]) => `<div class="stat"><b>${n}</b><span>${t}</span></div>`).join('');
    const kind = $('feedbackKind').value, status = $('feedbackStatus').value;
    const list = feedback.filter(r => (!kind || r.kind === kind) && (!status || (status === 'open' ? r.status !== 'resolved' : r.status === status)));
    $('feedbackList').innerHTML = list.length ? list.map(r => {
      const [label, tone] = FEEDBACK_STATUS[r.status] || [r.status, ''];
      const subject = encodeURIComponent(r.kind === 'bug' ? 'Tu reporte en Mila.Desk' : 'Tu sugerencia para Mila.Desk');
      const tech = [r.app_version && `Versión ${r.app_version}`, r.browser].filter(Boolean).join(' · ') || 'Sin datos técnicos';
      const actions = [
        r.status !== 'seen' && r.status !== 'resolved' ? `<button type="button" data-fb="${esc(r.id)}" data-to="seen">Marcar visto</button>` : '',
        r.status !== 'resolved' ? `<button type="button" class="primary" data-fb="${esc(r.id)}" data-to="resolved">Resuelto</button>` : '',
        r.status !== 'new' ? `<button type="button" data-fb="${esc(r.id)}" data-to="new">Volver a nuevo</button>` : ''
      ].join('');
      return `<div class="fb${r.status === 'new' ? ' new' : ''}"><div class="fb-top"><div><span class="tag">${FEEDBACK_KINDS[r.kind] || esc(r.kind)}</span> <span class="tag ${tone}">${esc(label)}</span></div><div class="fb-meta">${esc(date(r.created_at))}</div></div>`
        + `<div class="fb-text">${esc(r.message)}</div>`
        + `<div class="fb-top"><div><div class="fb-who">${esc(r.username || 'Sin usuario')}<small>${esc(r.email || '')}</small></div><div class="fb-meta">${esc(tech)}</div></div>`
        + `<div class="actions">${r.email ? `<a href="mailto:${esc(r.email)}?subject=${subject}">Responder por correo</a>` : ''}${actions}</div></div></div>`;
    }).join('') : '<div class="empty">No hay mensajes con este filtro.</div>';
  }
  async function setFeedbackStatus(button) {
    button.disabled = true;
    try {
      await rpc('admin_set_feedback_status', { p_id: button.dataset.fb, p_status: button.dataset.to });
      const row = feedback.find(r => r.id === button.dataset.fb);
      if (row) row.status = button.dataset.to;
      renderFeedback();
    } catch (error) { $('feedbackMsg').textContent = error.message; button.disabled = false; }
  }

  // ── Media kits: link name change requests (the name is fixed; only an admin changes it) ──
  async function loadKits() {
    const box = $('kitList');
    $('kitMsg').textContent = '';
    try {
      const rows = await rpc('media_kit_slug_requests');
      const list = Array.isArray(rows) ? rows : [];
      $('kitBadge').hidden = !list.length; $('kitBadge').textContent = String(list.length);
      box.innerHTML = list.length ? list.map(r => `<div class="card" data-kit="${esc(r.user_id)}"><b>${esc(r.email || 'Sin correo')}</b>`
        + `<div>${esc(r.slug)} → <b>${esc(r.requested_slug)}</b> · <span class="hint">${esc(date(r.requested_at))}</span></div>`
        + (r.taken ? '<div class="hint">⚠️ Ese nombre ya lo usa otro media kit: no se puede aceptar.</div>' : '')
        + `<div class="actions" style="margin-top:10px"><button type="button" class="primary" data-kit-accept="1"${r.taken ? ' disabled' : ''}>Aceptar cambio</button><button type="button" class="danger" data-kit-accept="0">Rechazar</button></div></div>`).join('')
        : '<div class="empty">No hay solicitudes de cambio de nombre.</div>';
    } catch (error) { box.innerHTML = '<div class="empty">No se pudieron cargar las solicitudes.</div>'; $('kitMsg').textContent = error.message; }
  }
  async function reviewKit(button) {
    const card = button.closest('[data-kit]'), accept = button.dataset.kitAccept === '1';
    if (!card || !confirm(accept ? '¿Aceptar el cambio? El enlace anterior dejará de funcionar ahora mismo.' : '¿Rechazar la solicitud? El enlace se queda igual.')) return;
    card.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      const slug = await rpc('review_media_kit_slug', { p_user: card.dataset.kit, p_accept: accept });
      await loadKits();
      $('kitMsg').textContent = accept ? `Listo: el nuevo enlace es mila-desk.com/kit/?u=${slug}` : 'Solicitud rechazada.';
    } catch (error) { card.querySelectorAll('button').forEach(b => { b.disabled = false; }); $('kitMsg').textContent = /23505|duplicate/i.test(error.message) ? 'Ese nombre ya lo usa otro media kit.' : error.message; }
  }

  async function start() {
    try {
      const c = await connection();
      me = c.userId;
      const admin = await rpc('is_admin');
      if (admin !== true) throw new Error('Esta página es solo para administradores de Mila.Desk.');
      $('who').textContent = 'Solo tú ves esta página. Cada acción se comprueba también en la base de datos.';
      $('app').hidden = false; $('sectionsNav').hidden = false; $('earningsOpen').hidden = false;
      await Promise.all([loadSignups(), loadAccess(), loadSamples(), loadKits(), loadFeedback(), loadEarnings()]);
    } catch (error) {
      $('who').textContent = '';
      $('locked').hidden = false;
      $('locked').textContent = error.message;
    }
  }

  $('signupsRefresh').addEventListener('click', loadSignups);
  $('signupSearch').addEventListener('input', renderSignups);
  $('signupOnlyFree').addEventListener('change', renderSignups);
  $('signupStats').addEventListener('click', e => { const b = e.target.closest('[data-sview]'); if (b) { signupView = b.dataset.sview; renderSignups(); } });
  $('signupRows').addEventListener('click', e => { const b = e.target.closest('[data-grant-email]'); if (b) grantFromSignups(b); });
  $('accessRefresh').addEventListener('click', loadAccess);
  $('grantSearch').addEventListener('input', renderGrants);
  $('mentoras').addEventListener('click', e => { if (!e.target.closest('summary')) mentorClick(e); });
  $('mentoras').addEventListener('change', e => { // «Para redes» codes give 20 days by default
    if (!e.target.matches('[data-msocial]')) return;
    const days = e.target.closest('[data-mentor-card]')?.querySelector('[data-mdays]'); if (days) days.value = e.target.checked ? 20 : 30;
  });
  $('mentorsRefresh').addEventListener('click', loadAccess);
  $('sectionsNav').addEventListener('click', () => { if (currentMentor) showMentor(''); showEarnings(false); });
  $('grantBtn').addEventListener('click', grantAccess);
  $('grantWho').addEventListener('keydown', e => { if (e.key === 'Enter') grantAccess(); });
  $('codeCreate').addEventListener('click', createCode);
  $('codeCount').addEventListener('input', createLabel);
  $('codeCopyAll').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('codeBatchList').value); $('accessMsg').textContent = 'Códigos copiados.'; } catch { $('codeBatchList').select(); } });
  $('codeCsv').addEventListener('click', downloadCsv);
  $('codePdf').addEventListener('click', () => printPdf(batch));
  $('accesos').addEventListener('click', e => { if (e.target.closest('#codeList,#grantList') && !e.target.closest('summary')) accessClick(e); });
  $('earningsRefresh').addEventListener('click', async () => { await loadMentorPanel(); await loadEarnings(); });
  $('earningsOpen').addEventListener('click', () => showEarnings(true));
  $('earningsBack').addEventListener('click', () => showEarnings(false));
  $('ganancias').addEventListener('click', earningsClick);
  $('ganancias').addEventListener('mouseover', earningsHover);
  $('earningsCsv').addEventListener('click', downloadEarningsCsv);
  $('samplesRefresh').addEventListener('click', loadSamples);
  $('sampleCards').addEventListener('click', e => { const b = e.target.closest('[data-review]'); if (b) review(b); });
  $('fillBtn').addEventListener('click', fillCategories);
  $('kitsRefresh').addEventListener('click', loadKits);
  $('kitList').addEventListener('click', e => { const b = e.target.closest('[data-kit-accept]'); if (b) reviewKit(b); });
  $('feedbackRefresh').addEventListener('click', loadFeedback);
  $('feedbackKind').addEventListener('change', renderFeedback);
  $('feedbackStatus').addEventListener('change', renderFeedback);
  $('feedbackList').addEventListener('click', e => { const b = e.target.closest('[data-fb]'); if (b) setFeedbackStatus(b); });
  start();
})();
