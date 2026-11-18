// Mila.Desk. Copyright (c) 2026 Jhoun Milanes (Milanes Production). All rights reserved. See LICENSE.txt. MD-ORIGIN-7F3A91C2
// Public media kit (mila-desk.com/kit/?u=<slug>). Reads only get_media_kit(), which returns a
// kit only while it is published. Everything is drawn with textContent; links and images are
// accepted only from the expected sites.
(() => {
  'use strict';
  const SUPABASE_URL = 'https://sbbcjnsyljjdljoihack.supabase.co';
  const KEY = 'sb_publishable_przw0W41bKFfL3-XOvZdhA_b3ueCU6T';
  // Always in English: brands on Amazon read and answer in English (owner, 2026-11-17).
  // Only the preview notes, which the creator alone sees, follow her language.
  const TEXT = { stats: 'Amazon numbers', videos: 'Featured videos', links: 'Where I post', rates: 'Rates', contact: 'Contact', address: 'Shipping address', phone: 'Phone {n}',
    videosN: 'published videos', views: 'total views', pct: 'of the video watched on average', campaigns: 'campaigns accepted', collabs: 'collaborations completed',
    taken: 'Data taken from Amazon by Mila.Desk on {date}.', followers: '{n} followers', viewsN: '{n} views', store: 'Amazon storefront',
    proof: 'Amazon metrics report', proofBtn: 'View my Amazon metrics',
    made: 'Media kit made with', independent: 'Mila.Desk is not affiliated with Amazon.', none: 'This media kit does not exist or is not published.', error: 'The media kit could not be loaded. Try again.' };
  const OWN = (navigator.language || '').toLowerCase().startsWith('es')
    ? { preview: 'Vista previa: así lo verán las marcas (en inglés), con lo último que guardaste. Solo tú la ves.', noSaved: 'Todavía no has guardado tu media kit.' }
    : { preview: 'Preview: this is how brands will see it, with what you last saved. Only you can see it.', noSaved: "You haven't saved your media kit yet." };
  const NETS = { storefront: [/^https:\/\/www\.amazon\.com\/shop\//i, ''], instagram: [/^https:\/\/(www\.)?instagram\.com\//i, 'Instagram'], tiktok: [/^https:\/\/(www\.)?tiktok\.com\//i, 'TikTok'],
    youtube: [/^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i, 'YouTube'], pinterest: [/^https:\/\/([a-z]{2,3}\.|www\.)?pinterest\.[a-z.]{2,6}\//i, 'Pinterest'], facebook: [/^https:\/\/(www\.|m\.)?facebook\.com\//i, 'Facebook'] };
  const $ = id => document.getElementById(id);
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  const T = (k, vars) => String(TEXT[k]).replace(/\{(\w+)\}/g, (_, v) => vars?.[v] ?? '');
  const n = v => Number(v).toLocaleString('en-US');
  const date = at => new Date(at).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
  const labels = () => { for (const e of document.querySelectorAll('[data-t]')) e.textContent = T(e.dataset.t); };

  // The creator's colors (theme.accent, theme.bg): text on the color is black or white,
  // whichever reads better, and the accent used as text is lightened or darkened to show.
  function paint(theme) {
    const hex = /^#[0-9a-f]{6}$/i.test(theme?.accent || '') ? theme.accent : '#ff6a1a';
    const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    const lum = rgb.map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
    const light = theme?.bg === 'light', mix = (to, k) => `rgb(${rgb.map(c => Math.round(c + (to - c) * k)).join(',')})`;
    const vars = { '--o': hex, '--o-soft': `rgba(${rgb.join(',')},${light ? 0.14 : 0.13})`, '--on': lum > 0.4 ? '#1a0b02' : '#ffffff', '--o-text': light ? mix(0, 0.3) : mix(255, 0.4) };
    if (light) Object.assign(vars, { '--b': '#f7f3ef', '--b2': '#ffffff', '--b3': '#f1ebe5', '--w': '#1d1a17', '--m': '#6f665e', '--l': '#e5ddd5' });
    for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
  }

  function draw(d, slug) {
    paint(d.theme);
    document.title = `${d.name || 'Media kit'} · Media kit`;
    $('name').textContent = d.name || ''; $('avatar').textContent = (d.name || '?').trim().charAt(0).toUpperCase();
    if (/^https:\/\/m\.media-amazon\.com\/images\//.test(d.photo || '')) {
      const img = el('img'); img.alt = ''; img.referrerPolicy = 'no-referrer';
      img.onerror = () => { img.remove(); $('avatar').textContent = (d.name || '?').trim().charAt(0).toUpperCase(); };
      img.src = d.photo; $('avatar').textContent = ''; $('avatar').append(img);
    }
    $('tagline').textContent = d.tagline || '';
    for (const topic of d.topics || []) $('topics').append(el('span', topic));
    const show = d.show || {};
    const s = d.stats;
    if (show.stats !== false && s) {
      const rows = [[s.videos, T('videosN')], [s.views, T('views')], [s.pctViewed == null ? null : `${s.pctViewed} %`, T('pct')], [s.campaigns, T('campaigns')], [s.collabsDone, T('collabs')]];
      for (const [v, label] of rows) { if (v == null || v === 0) continue; const box = el('div', null, 'stat'); box.append(el('b', typeof v === 'number' ? n(v) : v), el('span', label)); $('stats').append(box); }
      if (s.at) $('statsNote').textContent = T('taken', { date: date(s.at) });
      $('statsCard').hidden = !$('stats').children.length;
    }
    if (show.videos !== false) for (const v of d.top || []) {
      if (!/^https:\/\/www\.amazon\.com\/shop\//i.test(v.url || '')) continue;
      const a = el('a'); a.href = v.url; a.target = '_blank'; a.rel = 'noopener nofollow';
      if (/^https:\/\/m\.media-amazon\.com\//.test(v.thumb || '')) { const img = el('img'); img.src = v.thumb; img.alt = ''; img.loading = 'lazy'; a.append(img); }
      const cap = el('div', v.title || ''); if (v.views) cap.append(el('small', T('viewsN', { n: n(v.views) }))); a.append(cap);
      $('videos').append(a);
    }
    $('videosCard').hidden = !$('videos').children.length;
    for (const [k, [re, label]] of Object.entries(NETS)) {
      const url = d.links?.[k]; if (!url || !re.test(url)) continue;
      const a = el('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener nofollow';
      a.append(el('span', label || T('store')));
      if (show.followers !== false && d.followers?.[k]) a.append(el('small', T('followers', { n: n(d.followers[k]) })));
      $('links').append(a);
    }
    $('linksCard').hidden = !$('links').children.length;
    // The file itself is served by the media-kit-file function, which checks again that the
    // kit is published and the proof is shown.
    if (show.proof === true && d.proof && slug) {
      const a = el('a', T('proofBtn'), 'btn'); a.href = `${SUPABASE_URL}/functions/v1/media-kit-file?u=${slug}`; a.target = '_blank'; a.rel = 'noopener';
      $('proof').append(a);
      $('proofCard').hidden = false;
    }
    if (show.rates === true && d.rates) { $('rates').textContent = d.rates; $('ratesCard').hidden = false; }
    // Each contact shown on its own (older kits: one "contact" switch for all).
    const on = k => show[k] != null ? show[k] !== false : show.contact !== false;
    const line = (text, href, blank) => { const a = el('a', text); a.href = href; if (blank) { a.target = '_blank'; a.rel = 'noopener'; } $('contact').append(a, el('br')); };
    const c = d.contact || {};
    if (on('email') && c.email) line(c.email, 'mailto:' + c.email);
    if (on('phone') && c.phone) line(T('phone', { n: c.phone }), 'tel:' + c.phone.replace(/[^\d+]/g, ''));
    if (on('whatsapp') && c.whatsapp) line('WhatsApp ' + c.whatsapp, 'https://wa.me/' + c.whatsapp.replace(/\D/g, ''), true);
    $('contactCard').hidden = !$('contact').children.length;
    // Shipping address: only when the creator accepted showing it (empty lines are left out).
    const a = d.address;
    if (show.address === true && a?.line1) {
      for (const text of [a.name, a.line1, a.line2, [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')]) if (text) $('address').append(el('div', text));
      if (a.phone) $('address').append(el('div', T('phone', { n: a.phone })));
      if (a.email) $('address').append(el('div', a.email));
      $('addressCard').hidden = false;
    }
    $('empty').hidden = true; $('kit').hidden = false;
  }

  labels();
  // Inside the extension (kit-vista.html): the creator's own saved kit, through the service
  // worker, published or not. Nothing is fetched from the web.
  if (location.protocol === 'chrome-extension:' && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage({ type: 'MILA_MEDIA_KIT_LOAD' }).then(res => {
      if (!res?.ok) throw new Error(res?.error || 'error');
      if (!res.kit) { $('empty').textContent = OWN.noSaved; return; }
      draw(res.kit.data || {}, res.kit.slug); $('preview').textContent = OWN.preview; $('preview').hidden = false;
    }).catch(error => { $('empty').textContent = String(error?.message || T('error')); });
    return;
  }
  const slug = new URLSearchParams(location.search).get('u') || '';
  if (!/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(slug)) { $('empty').textContent = T('none'); return; }
  fetch(`${SUPABASE_URL}/rest/v1/rpc/get_media_kit`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_slug: slug }) })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(d => { if (d && typeof d === 'object') draw(d, slug); else $('empty').textContent = T('none'); })
    .catch(() => { $('empty').textContent = T('error'); });
})();
