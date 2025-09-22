// FRONT DEMO: si API_BASE queda vacío, solo muestra el QR y no envía nada.
const API_BASE = ""; 
const SEND_ENABLED = !!API_BASE;
const PENDING_KEY = "checkin.pending";

document.addEventListener('DOMContentLoaded', async () => {
  const video     = document.getElementById('video');
  const btnStart  = document.getElementById('btnStart');
  const btnStop   = document.getElementById('btnStop');
  const btnCopy   = document.getElementById('btnCopy');
  const btnSync   = document.getElementById('btnSync');
  const statusEl  = document.getElementById('status');
  const outputEl  = document.getElementById('output');
  const openLink  = document.getElementById('openLink');
  const eventIdEl = document.getElementById('eventId');
  const attendantEl = document.getElementById('attendant');
  const attTokenEl  = document.getElementById('attToken');

  // ZXing reader
  let codeReader = null;
  let currentDeviceId = null;

  function setStatus(msg, type){ statusEl.className = 'status' + (type ? ' ' + type : ''); statusEl.textContent = msg; }
  function setResult(text){
    outputEl.textContent = text || '—'; btnCopy.disabled = !text;
    try { const url = new URL(text); openLink.style.display = 'inline-block'; openLink.href = url.href; }
    catch { openLink.style.display = 'none'; openLink.removeAttribute('href'); }
  }

  function loadPending(){ try { return JSON.parse(localStorage.getItem(PENDING_KEY) || "[]"); } catch { return []; } }
  function savePending(list){ localStorage.setItem(PENDING_KEY, JSON.stringify(list)); }

  async function sendCheckin(payload){
    if (!SEND_ENABLED) throw new Error("DEMO_MODE_NO_BACKEND");
    const res = await fetch(`${API_BASE}/api/checkin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${attTokenEl.value.trim()}` },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function handleScan(text){
    const eventId   = (eventIdEl?.value || "").trim();
    const attendant = (attendantEl?.value || "").trim();

    setResult(text);

    if (!SEND_ENABLED) { setStatus('QR leído (modo demo: no se envía).', 'ok'); return; }
    if (!eventId || !attendant || !attTokenEl.value.trim()) { setStatus('Completa Evento, Azafata y Token.', 'err'); return; }

    const payload = {
      eventId, code: text, attendant,
      deviceId: await deviceId(), scannedAt: new Date().toISOString()
    };

    try {
      const data = await sendCheckin(payload);
      if (data.duplicate) setStatus(`Duplicado (primera vez: ${new Date(data.firstSeenAt).toLocaleTimeString()})`, 'err');
      else setStatus('¡Check-in registrado!', 'ok');
    } catch (e) {
      const pend = loadPending(); pend.push(payload); savePending(pend);
      setStatus(`Sin conexión. Guardado (${pend.length} pendiente/s).`, 'err');
    }
  }

  // --------- LISTADO DE CÁMARAS SIN ZXING (Web API nativa) ----------
  async function listCameras() {
    // Pide permiso primero para que enumerateDevices devuelva labels en iOS/Android
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      tmp.getTracks().forEach(t => t.stop());
    } catch (e) {
      throw new Error("Permiso de cámara denegado o no disponible");
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const vids = devices.filter(d => d.kind === "videoinput");
    if (!vids.length) throw new Error("No se han encontrado cámaras");

    // Prioriza trasera por nombre
    vids.sort((a, b) => {
      const sa = (a.label || "").toLowerCase();
      const sb = (b.label || "").toLowerCase();
      const score = s => /back|rear|environment|trasera|posterior/.test(s) ? 1 : 0;
      return score(sb) - score(sa);
    });

    currentDeviceId = vids[0].deviceId;
  }
  // ------------------------------------------------------------------

  async function start() {
    try {
      // Comprueba ZXing cargado
      if (!window.ZXing || !ZXing.BrowserMultiFormatReader) {
        throw new Error("ZXing no se ha cargado. Revisa la etiqueta <script> de @zxing/library.");
      }
      codeReader = new ZXing.BrowserMultiFormatReader();

      await listCameras(); // ← usamos Web API, no ZXing.listVideoInputDevices
      btnStart.disabled = true; btnStop.disabled = false;
      setStatus('Escaneando…', 'ok');

      await codeReader.decodeFromVideoDevice(currentDeviceId, video, (result, err, controls) => {
        if (result) {
          const text = result.getText();
          handleScan(text);
          // Evitar dobles lecturas (reanuda cuando pulses de nuevo Iniciar)
          controls.stop(); btnStart.disabled=false; btnStop.disabled=true;
        }
        if (err && !(err instanceof ZXing.NotFoundException)) console.debug(err);
      });
    } catch (e) {
      btnStart.disabled=false; btnStop.disabled=true;
      setStatus(`Error: ${e.message||e}`, 'err');
    }
  }

  async function stop() {
    try {
      codeReader?.reset();
      const ms = video.srcObject;
      if (ms?.getTracks) ms.getTracks().forEach(t => t.stop());
    } catch {}
    btnStart.disabled=false; btnStop.disabled=true; setStatus('Cámara detenida.');
  }

  btnStart.addEventListener('click', start);
  btnStop.addEventListener('click', stop);

  btnSync?.addEventListener('click', async () => {
    const pend = loadPending(); if (!pend.length) { setStatus('No hay pendientes.', 'ok'); return; }
    let ok=0, fail=0;
    for (const p of [...pend]) {
      try { await sendCheckin(p); ok++; pend.shift(); savePending(pend); }
      catch { fail++; }
    }
    setStatus(`Sincronización: ${ok} enviados, ${fail} fallidos.`, fail? 'err':'ok');
  });

  btnCopy.addEventListener('click', async () => {
    const t = outputEl.textContent.trim(); if (!t || t==='—') return;
    try { await navigator.clipboard.writeText(t); setStatus('Copiado.', 'ok'); } catch { setStatus('No se pudo copiar.', 'err'); }
  });

  video.addEventListener('loadedmetadata', () => { video.setAttribute('playsinline','true'); video.play().catch(()=>{}); });

  async function deviceId(){
    const KEY='checkin.deviceId';
    let id = localStorage.getItem(KEY);
    if (!id) { id = (crypto?.randomUUID?.() || Math.random().toString(36).slice(2)); localStorage.setItem(KEY,id); }
    return id;
  }
});
