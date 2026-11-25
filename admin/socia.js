// Mila.Desk. Copyright (c) 2026 Jhoun Milanes (Milanes Production). All rights reserved. See LICENSE.txt. MD-ORIGIN-7F3A91C2
// Partner panel (owner's request, 2026-11-21): a mentor or influencer, signed in with the
// account the admin linked to her, sees her students, commissions, activity and codes. Read
// only. The data comes from my_partner_panel(), which returns only her own rows, with masked
// emails and opaque ids; the commission is the same calculation as the admin panel.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
  const usd = c => '$' + ((Number(c) || 0) / 100).toFixed(2);
  const day = iso => iso ? new Date(iso).toLocaleDateString('es-DO', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const monthName = key => new Date(`${key}-15T12:00:00`).toLocaleDateString('es-DO', { month: 'long', year: 'numeric' });
  const STATE = { pagando: ['Pagando (con suscripción)', 'ok'], gratis: ['Periodo gratis', 'warn'], sin_pagar: ['Terminó sin pagar', ''], cancelo: ['Canceló', 'bad'], otro_acceso: ['Otro acceso', ''] };
  const TYPE = { mensual: 'Mensual', anual: 'Anual', primero: 'Primer pago (mensual)', primero_anual: 'Primer pago (anual)' };
  let data = null, filter = '';
  // «Mis códigos» (owner's request 2026-11-25): its own screen; 5 codes per group until «Mostrar todos»;
  // a copied code waits to be marked as sent, and sent ones go to the end of the list.
  let codesView = false;
  const expanded = new Set(), copied = new Set(), PAGE = 5;
  // Admin preview (owner's request, 2026-11-21): socia.html?socia=<name> shows that partner's panel
  // exactly as she sees it; admin_partner_panel() answers only to an admin.
  const preview = new URLSearchParams(location.search).get('socia') || '';

  async function connection() {
    const c = await chrome.runtime.sendMessage({ type: 'MILA_ADMIN_CONNECTION' }).catch(() => null);
    if (!c?.ok) throw new Error(c?.error || 'Inicia sesión en Mila.Desk desde el popup y vuelve a abrir esta página.');
    return c;
  }

  async function load() {
    $('error').hidden = true;
    try {
      const c = await connection();
      const res = await fetch(`${c.url}/rest/v1/rpc/${preview ? 'admin_partner_panel' : 'my_partner_panel'}`, {
        method: 'POST', headers: { apikey: c.key, Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(preview ? { p_name: preview } : {})
      });
      if (!res.ok) throw new Error(preview && (res.status === 401 || res.status === 403) ? 'Solo una cuenta de administración puede ver el panel de otra persona.' : `No se pudo cargar tu panel (${res.status}).`);
      data = await res.json();
      if (!data?.partner) throw new Error(preview ? `No hay ninguna mentora ni influencer llamada «${preview}».` : 'Esta cuenta no está ligada a ninguna mentora ni influencer. Si crees que es un error, escríbenos.');
      $('previewNote').hidden = !preview;
      if (preview) $('previewNote').textContent = `👁 Vista de administración: así ve su panel ${data.partner.name}. Se actualiza sola cada 2 minutos.`;
      render();
    } catch (error) {
      $('app').hidden = true; $('who').textContent = '';
      $('error').textContent = error.message; $('error').hidden = false;
    }
  }

  function render() {
    const p = data.partner, influencer = p.kind === 'influencer', now = Date.now();
    // The alliance starts on the first paid charge of one of her people (owner, 2026-11-24).
    const allianceFrom = MilaCore.firstPaidCharge(data.payments);
    $('who').textContent = `${p.name}${allianceFrom ? ` · alianza desde el ${day(allianceFrom + 'T12:00:00')}` : ' · tu alianza empieza con la primera suscripción pagada'}${p.active === false ? ' · alianza terminada' : ''}`;
    document.title = `Mila.Desk · Panel de colaboración de ${p.name}`;
    // Her own access, small, under her name (owner's request 2026-11-22).
    const acc = p.access, accUntil = Date.parse(acc?.expires_at || '');
    $('myAccess').hidden = !acc?.plan;
    if (acc?.plan) $('myAccess').textContent = Number.isFinite(accUntil)
      ? (accUntil > now ? `Tu acceso a Mila.Desk: hasta el ${day(acc.expires_at)}` : `Tu acceso a Mila.Desk terminó el ${day(acc.expires_at)}`)
      : 'Tu acceso a Mila.Desk: sin fecha límite';
    // A mentor's free year from the alliance start (alliance document, 2026-11-22).
    const yearEnd = !influencer && MilaCore.mentorFreeYearEnd(p.started_at);
    if (yearEnd) { $('myAccess').hidden = false; $('myAccess').textContent = `Tu año de Premium gratis por la alianza: hasta el ${day(yearEnd + 'T12:00:00')}`; }
    // The rate she earns this month so far (mentors only; an influencer earns fixed amounts).
    const r = MilaCore.mentorRateNow({ payments: data.payments, now });
    $('rateNow').hidden = influencer;
    if (!influencer) $('rateNow').innerHTML = (r.students
      ? `Este mes estás ganando el <b>${Math.round(r.rate * 100)} %</b> porque ${r.students === 1 ? 'ya pagó 1 alumna' : `ya pagaron ${r.students} alumnas`} con plan mensual en ${esc(monthName(r.month))}.`
      : `Este mes todavía no ha pagado ninguna alumna con plan mensual. Con la primera ganas el <b>25 %</b>.`)
      + (r.next && r.students ? `<small>Con ${r.next.missing} ${r.next.missing === 1 ? 'alumna más' : 'alumnas más'} pagando este mes (${r.next.students} en total) subes al ${Math.round(r.next.rate * 100)} % de todo el mes.</small>` : '')
      + (!r.next ? '<small>Ya estás en el porcentaje más alto.</small>' : '');
    const c = MilaCore.mentorCommissions({ payments: data.payments, payouts: data.payouts, now, kind: p.kind });

    // Money: what she is owed now, what waits, totals.
    const monthEnd = new Date(); monthEnd.setMonth(monthEnd.getMonth() + 1, 1); monthEnd.setHours(0, 0, 0, 0);
    const releasing = c.pending.filter(x => Date.parse(x.releaseAt) < monthEnd.getTime()).reduce((t, x) => t + x.estimateCents, 0);
    const thisMonth = c.months.find(m => m.month === new Date().toISOString().slice(0, 7));
    $('money').innerHTML = [
      [c.owedCents, 'Por cobrar (confirmado)', 'main'], [c.pendingEstimateCents, 'En espera (30 días)'],
      [c.earnedCents, 'Ganado en total'], [c.paidCents, 'Ya te pagamos'], [thisMonth?.commissionCents || 0, 'Confirmado de pagos de este mes']
    ].map(([v, t, cls]) => `<div class="stat ${cls || ''}"><b>${usd(v)}</b><span>${t}</span></div>`).join('');
    const nextTotal = c.owedCents + releasing;
    $('nextPay').textContent = nextTotal >= 2500
      ? `Si no hay reembolsos, a fin de ${monthName(new Date().toISOString().slice(0, 7))} tendrías unos ${usd(nextTotal)} por cobrar.`
      : `Por ahora llevas ${usd(nextTotal)} para el próximo pago; se paga al llegar a 25 USD (lo que falte se acumula).`;
    $('rules').innerHTML = (influencer
      ? ['Ganas 5 USD por cada persona que pague su primer mes con tu código, o 15 USD si paga el plan anual (una sola vez por persona).',
        'Mientras la persona está en sus días de prueba no hay comisión.']
      : ['Alumnas con plan mensual: del 25 % al 40 % de lo que paga, según cuántas pagan en el mes (1–25: 25 %, 26–50: 30 %, 51–99: 35 %, 100+: 40 %).',
        'Alumnas con plan anual: 25 USD fijos cada año que pagan (no cuentan para subir el porcentaje).'])
      .concat(['Cada pago cuenta 30 días después de cobrado, si no hubo reembolso ni reclamo.', 'Si un pago se reembolsa después de pagarte, se descuenta del siguiente pago.'])
      .map(t => `<li>${esc(t)}</li>`).join('');

    // Waiting payments.
    const names = new Map((data.students || []).map(s => [s.id, s.username || 'Sin usuario']));
    $('pending').innerHTML = c.pending.length ? `<div class="tablewrap"><table><thead><tr><th>Alumna</th><th>Tipo</th><th>Pagó el</th><th>Se libera el</th><th>Comisión aprox.</th></tr></thead><tbody>${
      c.pending.slice().sort((a, b) => Date.parse(a.releaseAt) - Date.parse(b.releaseAt)).map(x => `<tr><td>${esc(names.get(x.user_id) || 'Alumna')}</td><td>${TYPE[x.type]}</td><td class="small">${day(x.occurred_at)}</td><td>${day(x.releaseAt)}</td><td><b>${usd(x.estimateCents)}</b>${x.type === 'mensual' ? ' <span class="small">(mínimo)</span>' : ''}</td></tr>`).join('')
    }</tbody></table></div>` : '<div class="empty">No hay pagos esperando.</div>';

    // Months.
    $('months').innerHTML = c.months.length ? `<div class="tablewrap"><table><thead><tr><th>Mes del pago</th>${influencer ? '<th>Personas</th>' : '<th>Mensuales</th><th>%</th><th>Anuales</th>'}<th>Comisión</th></tr></thead><tbody>${
      c.months.slice().reverse().map(m => `<tr><td>${esc(monthName(m.month))}</td>${influencer ? `<td>${m.fixedCount}</td>` : `<td>${m.students}</td><td>${m.students ? Math.round(m.rate * 100) + ' %' : '—'}</td><td>${m.fixedCount}</td>`}<td><b>${usd(m.commissionCents)}</b></td></tr>`).join('')
    }</tbody></table></div>` : '<div class="empty">Todavía no hay comisiones confirmadas.</div>';

    // Students.
    const perStudent = new Map();
    for (const m of c.months) for (const i of m.items) perStudent.set(i.user_id, (perStudent.get(i.user_id) || 0) + i.commissionCents);
    const lastType = new Map();
    for (const pay of (data.payments || []).slice().reverse()) if (pay.kind === 'charge') lastType.set(pay.student, Number(pay.total_cents) >= 6000 ? 'Anual' : 'Mensual');
    // Course or social media: the offer of the code she redeemed (codes «para redes», 2026-11-24).
    const socialCodes = new Set((data.codes || []).filter(x => x.offer === 'mila').map(x => x.code));
    const students = (data.students || []).map(s => ({ ...s, state: MilaCore.mentorStudentState(s, now), origin: socialCodes.has(s.code) ? 'redes' : 'curso' }));
    const count = {}; for (const s of students) count[s.state] = (count[s.state] || 0) + 1;
    $('studentStats').innerHTML = [['', 'Todos', students.length], ...Object.entries(STATE).filter(([k]) => count[k] || k === 'pagando' || k === 'gratis').map(([k, [t]]) => [k, t, count[k]])]
      .concat(socialCodes.size ? [['o:curso', 'De tu curso', students.filter(s => s.origin === 'curso').length], ['o:redes', 'De tus redes', students.filter(s => s.origin === 'redes').length]] : [])
      .map(([k, t, n]) => `<button type="button" class="stat ${filter === k ? 'on' : ''}" data-filter="${k}"><b>${n}</b><span>${t}</span></button>`).join('');
    const shown = students.filter(s => !filter || s.state === filter || filter === 'o:' + s.origin);
    $('students').innerHTML = shown.length ? `<table><thead><tr><th>Usuario</th><th>Correo</th><th>Estado</th><th>Plan</th>${socialCodes.size ? '<th>Vino por</th>' : ''}<th>Canjeó</th><th>Te dejó</th></tr></thead><tbody>${
      shown.map(s => { const [t, cls] = STATE[s.state] || ['—', '']; const left = s.state === 'gratis' ? MilaCore.freeDaysLeft(s, now) : null; return `<tr><td><b>${esc(s.username || 'Sin usuario')}</b></td><td class="small">${esc(s.email || '')}</td><td><span class="tag ${cls}">${left == null ? t : `${t} · ${left === 1 ? 'queda 1 día' : `quedan ${left} días`}`}</span></td><td class="small">${lastType.get(s.id) || '—'}</td>${socialCodes.size ? `<td class="small">${s.origin === 'redes' ? '🌐 Redes' : '🎓 Curso'}</td>` : ''}<td class="small">${day(s.redeemed_at)}</td><td>${usd(perStudent.get(s.id) || 0)}</td></tr>`; }).join('')
    }</tbody></table>` : '<div class="empty">Todavía no hay alumnos con tus códigos.</div>';

    // Activity.
    const feed = MilaCore.partnerActivity({ students: data.students, payments: data.payments, payouts: data.payouts });
    $('feed').innerHTML = feed.length ? feed.slice(0, 150).map(e => `<div><span>${esc(e.text)}</span><small>${day(e.at)}</small></div>`).join('') : '<div class="empty">Sin movimientos todavía.</div>';

    // Codes.
    const codes = data.codes || [];
    const checkout = codes.filter(x => x.checkout), access = codes.filter(x => !x.checkout);
    const free = access.filter(x => x.active && Number(x.uses) < Number(x.max_uses));
    const freeCourse = free.filter(x => x.offer !== 'mila'), freeSocial = free.filter(x => x.offer === 'mila');
    const social = access.filter(x => x.offer === 'mila');
    $('codeStats').innerHTML = (social.length
      ? [[access.length - social.length, 'Códigos del curso'], [freeCourse.length, 'Libres del curso'], [social.length, 'Códigos para redes'], [freeSocial.length, 'Libres para redes']]
      : [[access.length, 'Códigos'], [access.length - free.length, 'Usados o apagados'], [free.length, 'Libres']])
      .map(([n, t]) => `<div class="stat"><b>${n}</b><span>${t}</span></div>`).join('');
    const sentDay = iso => new Date(iso).toLocaleDateString('es-DO', { day: 'numeric', month: 'short' });
    const codeRow = x => {
      const sent = !!x.sent_at, cp = !sent && copied.has(x.code), code = esc(x.code);
      return `<div class="crow ${sent ? 'sent' : cp ? 'copied' : ''}"><code>${code}</code>${sent ? `<span class="tag ok">Enviado · ${sentDay(x.sent_at)}</span>` : cp ? '<span class="tag warn">Copiado</span>' : ''}<div class="actions noprint">${sent
        ? (preview ? '' : `<button type="button" data-unsend="${code}">Deshacer</button>`)
        : `<button type="button" data-copy="${code}">${cp ? 'Copiar otra vez' : 'Copiar'}</button>${cp && !preview ? `<button type="button" class="primary" data-send="${code}">Marcar como enviado</button>` : ''}`}</div></div>`;
    };
    const group = (key, list, title) => {
      const sorted = list.filter(x => !x.sent_at).concat(list.filter(x => x.sent_at).sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at)));
      const open = expanded.has(key), waiting = list.length - list.filter(x => x.sent_at).length;
      return `<div class="group-title"><h3>${title}</h3><span class="hint" style="margin:0">${waiting} sin enviar · ${list.length - waiting} enviados</span></div>`
        + `<div class="clist">${(open ? sorted : sorted.slice(0, PAGE)).map(codeRow).join('')}</div>`
        + (sorted.length > PAGE ? `<button type="button" class="more noprint" data-more="${key}">${open ? 'Mostrar menos' : `Mostrar todos (${sorted.length})`}</button>` : '');
    };
    $('codes').innerHTML = (checkout.length ? `<p class="hint">Código para el plan anual (se escribe en la ventana de pago): ${checkout.map(x => `<code>${esc(x.code)}</code>`).join(' ')}</p>` : '')
      + '<p class="hint noprint" id="copyMsg"></p>'
      + (!free.length ? '<div class="empty">No te quedan códigos libres.</div>'
        : !social.length ? group('todos', free, 'Tus códigos libres')
        : (freeCourse.length ? group('curso', freeCourse, '🎓 Para tu curso') : '') + (freeSocial.length ? group('redes', freeSocial, '🌐 Para tus redes (20 días gratis, el primer mes 15 USD)') : ''));
    $('app').classList.toggle('codes-view', codesView);
    $('app').hidden = false;
  }

  document.addEventListener('click', async event => {
    const b = event.target.closest('button'); if (!b) return;
    if (b.dataset.filter !== undefined) { filter = b.dataset.filter; render(); return; }
    if (b.id === 'openCodes' || b.id === 'closeCodes') { codesView = b.id === 'openCodes'; render(); window.scrollTo(0, 0); return; }
    if (b.dataset.more) { expanded.has(b.dataset.more) ? expanded.delete(b.dataset.more) : expanded.add(b.dataset.more); render(); return; }
    if (b.dataset.copy) {
      let ok = true;
      try { await navigator.clipboard.writeText(b.dataset.copy); } catch { ok = false; }
      // Even if the browser refused, she can copy it by hand and still mark it as sent.
      copied.add(b.dataset.copy); render();
      if (!ok) $('copyMsg').textContent = 'No se pudo copiar solo. Mantén presionado el código para copiarlo.';
      return;
    }
    const code = b.dataset.send || b.dataset.unsend;
    if (code) {
      b.disabled = true;
      try {
        const c = await connection();
        const res = await fetch(`${c.url}/rest/v1/rpc/partner_mark_code_sent`, {
          method: 'POST', headers: { apikey: c.key, Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p_code: code, p_sent: !!b.dataset.send })
        });
        if (!res.ok) throw new Error();
        const item = (data.codes || []).find(x => x.code === code);
        if (item) item.sent_at = await res.json();
        copied.delete(code);
        render();
      } catch { b.disabled = false; $('copyMsg').textContent = 'No se pudo guardar. Revisa tu conexión y vuelve a intentarlo.'; }
    }
  });
  $('refresh').addEventListener('click', load);
  // Always current: reload every 2 minutes while the tab is visible, and when it comes back.
  setInterval(() => { if (!document.hidden) load(); }, 120000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && data) load(); });
  $('pdf').addEventListener('click', () => { const before = filter; filter = ''; render(); window.print(); filter = before; render(); });
  load();
})();
