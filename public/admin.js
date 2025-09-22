(function () {
  const $ = (sel) => document.querySelector(sel);
  const tbodyScans = $('#tblScans tbody');
  const tbodyU     = $('#tblUnique tbody');
  const tbodyDL    = $('#tblDupLive tbody');

  const baseUrlInput = $('#baseUrl');
  const tokenInput   = $('#adminToken');
  const eventInput   = $('#eventId');

  const connEl      = $('#conn');
  const totalEl     = $('#totalScans');
  const uniqueEl    = $('#uniqueCodes');
  const dupsEl      = $('#dupsCount');
  const evtTitleEl  = $('#evtTitle');
  const evtUniqueEl = $('#evtUnique');

  let cfg = { base: '', token: '', eventId: 'MF2025' };
  let scans = [];     // histórico crudo de la API (server.js: id, code, ts, via, ip, ua)
  let uniqs = [];     // primeros por code
  let dups  = [];     // duplicados (code visto + de 1 vez)

  // Valores por defecto
  window.addEventListener('DOMContentLoaded', () => {
    const DEF = window.location.origin;
    baseUrlInput.value = DEF;
    eventInput.value   = 'MF2025';
    evtTitleEl.textContent  = 'MF2025';
    evtUniqueEl.textContent = 'MF2025';
    connEl.textContent = '—';
  });

  function recompute() {
    // ordenar por ts asc para calcular primeros
    const sorted = scans.slice().sort((a,b) => new Date(a.ts) - new Date(b.ts));

    const firstByCode = new Map();
    const dupList = [];
    const counts = new Map();

    for (const r of sorted) {
      counts.set(r.code, (counts.get(r.code) || 0) + 1);
      if (!firstByCode.has(r.code)) firstByCode.set(r.code, r);
    }
    for (const [code, n] of counts) {
      if (n > 1) {
        // última aparición como "dup" solo para mostrar hora reciente
        const last = sorted.filter(x => x.code === code).slice(-1)[0];
        dupList.push({ code, duplicateAt: last.ts });
      }
    }
    uniqs = Array.from(firstByCode.values());
    dups  = dupList;
  }

  function render() {
    totalEl.textContent  = String(scans.length);
    uniqueEl.textContent = String(uniqs.length);
    dupsEl.textContent   = String(Math.max(scans.length - uniqs.length, 0));

    // Histórico (desc por hora)
    const sortedDesc = scans.slice().sort((a,b) => new Date(b.ts) - new Date(a.ts));
    tbodyScans.innerHTML = sortedDesc.map((r,i) => `
      <tr>
        <td>${i+1}</td>
        <td>${new Date(r.ts).toLocaleTimeString()}</td>
        <td><code>${r.code}</code></td>
        <td class="${/* dup detectado por tener + de 1 */ ''}">${/* marcado simple en render */ ''}</td>
        <td class="small">${r.ip || ''}</td>
      </tr>
    `).join('');

    // Únicos
    const uniqSorted = uniqs.slice().sort((a,b) => new Date(a.ts) - new Date(b.ts));
    tbodyU.innerHTML = uniqSorted.map((r,i) => `
      <tr>
        <td>${i+1}</td>
        <td><code>${r.code}</code></td>
        <td>${new Date(r.ts).toLocaleTimeString()}</td>
      </tr>
    `).join('');

    // Duplicados recientes (derivados del histórico)
    const dupSorted = dups.slice().sort((a,b) => new Date(b.duplicateAt) - new Date(a.duplicateAt));
    tbodyDL.innerHTML = dupSorted.map((d,i) => `
      <tr>
        <td>${i+1}</td>
        <td>${new Date(d.duplicateAt).toLocaleTimeString()}</td>
        <td><code>${d.code}</code></td>
      </tr>
    `).join('');
  }

  async function loadScans() {
    const url = `${cfg.base}/admin/scans`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.token}` } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    // server.js devuelve { ok, total, scans: [{ id, code, ts, via, ip, ua }...] }
    const list = Array.isArray(data.scans) ? data.scans : [];
    scans = list.map(r => ({
      id: r.id,
      code: r.code,
      ts:  r.ts || r.createdAt || r.scannedAt,
      via: r.via,
      ip:  r.ip,
      ua:  r.ua,
    }));
    recompute();
    render();
  }

  async function handleLoadClick() {
    cfg.base   = (baseUrlInput.value || '').replace(/\/+$/,'') || window.location.origin;
    cfg.token  = (tokenInput.value || '').trim();
    cfg.eventId= (eventInput.value || '').trim();
    evtTitleEl.textContent  = cfg.eventId || '—';
    evtUniqueEl.textContent = cfg.eventId || '—';
    connEl.textContent = 'cargando…';
    try {
      await loadScans();
      connEl.textContent = 'ok · auto 5s';
    } catch (e) {
      console.error(e);
      connEl.textContent = 'error';
      alert('No se pudo cargar /admin/scans. Revisa la URL y el token.');
      return;
    }
    // Auto-refresh cada 5s
    if (window.__adminInterval) clearInterval(window.__adminInterval);
    window.__adminInterval = setInterval(async () => {
      try {
        await loadScans();
        connEl.textContent = 'ok · auto 5s';
      } catch {
        connEl.textContent = 'error';
      }
    }, 5000);
  }

  $('#btnLoad').addEventListener('click', handleLoadClick);
})();
