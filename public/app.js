// ==== CONFIGURACIÓN (Koyeb mismo origen) ====
// Deja API_BASE vacío para mismo dominio (Express), sin CORS
const API_BASE = "";                       
const ATTENDANT_TOKEN = "scan-XYZ123"; // ATTENDANT_TOKEN de Koyeb
const EVENT_ID = "MF2025";              // Evento fijo

const PENDING_KEY = "checkin.pending";

document.addEventListener('DOMContentLoaded', async () => {
  const video     = document.getElementById('video');
  const camBox    = document.getElementById('camBox');
  const btnStart  = document.getElementById('btnStart');
  const btnStop   = document.getElementById('btnStop');
  const btnCopy   = document.getElementById('btnCopy');
  const statusEl  = document.getElementById('status');
  const outputEl  = document.getElementById('output');
  const openLink  = document.getElementById('openLink');
  const eventIdEl = document.getElementById('eventId'); // solo muestra MF2025

  let codeReader = null;
  let currentDeviceId = null;

  // Escaneo continuo + anti-dobles
  let scanning = false;
  let lastText = null;
  let lastAt   = 0;

  function setStatus(msg, type){ statusEl.className = 'status' + (type ? ' ' + type : ''); statusEl.textContent = msg; }
  function setResult(text){
    outputEl.textContent = text || '—'; btnCopy.disabled = !text;
    try { const url = new URL(text); openLink.style.display = 'inline-block'; openLink.href = url.href; }
    catch { openLink.style.display = 'none'; openLink.removeAttribute('href'); }
  }
  function flashCam(ms=400){ camBox?.classList.add('flash'); setTimeout(()=>camBox?.classList.remove('flash'), ms); }
  function loadPending(){ try { return JSON.parse(localStorage.getItem(PENDING_KEY) || "[]"); } catch { return []; } }
  function savePending(list){ localStorage.setItem(PENDING_KEY, JSON.stringify(list)); }

  async function sendCheckin(payload){
    if (!ATTENDANT_TOKEN) throw new Error("ATTENDANT_TOKEN_MISSING");
    const res = await fetch(`${API_BASE}/api/checkin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ATTENDANT_TOKEN}` },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function handleScan(text){
    flashCam();
    setResult(text);

    const payload = {
      eventId: EVENT_ID,
      code: text,
      attendant: null, // ya no usamos azafata
      deviceId: await deviceId(),
      scannedAt: new Date().toISOString()
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

  // ---------- Cámaras con Web API ----------
  async function listCameras() {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      tmp.getTracks().forEach(t => t.stop());
    } catch { throw new Error("Permiso de cámara denegado o no disponible"); }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const vids = devices.filter(d => d.kind === "videoinput");
    if (!vids.length) throw new Error("No se han encontrado cámaras");

    vids.sort((a, b) => {
      const sa = (a.label || "").toLowerCase(), sb = (b.label || "").toLowerCase();
      const score = s => /back|rear|environment|trasera|posterior/.test(s) ? 1 : 0;
      return score(sb) - score(sa);
    });
    currentDeviceId = vids[0].deviceId;
  }
  // -----------------------------------------

  // Bucle de escaneo continuo con debounce
  async function startScanLoop() {
    if (!scanning) return;

    const constraints = {
      video: {
        deviceId: { exact: currentDeviceId },
        facingMode: "environment",
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 }
      }
    };

    await codeReader.decodeFromConstraints(constraints, video, async (result, err, controls) => {
      if (result) {
        const text = result.getText();
        const now = Date.now();
        // Evita repetir el mismo código si se "ve" varias veces seguidas
        if (text === lastText && now - lastAt < 1200) return;

        lastText = text; lastAt = now;
        await handleScan(text);

        // Reinicia correctamente la sesión de ZXing antes de continuar
        controls.stop();
        codeReader.reset(); // ← ← ← ADICIÓN CLAVE

        if (scanning) setTimeout(() => startScanLoop(), 300);
      }
      if (err && !(err instanceof ZXing.NotFoundException)) console.debug(err);
    });
  }

  async function start() {
    try {
      if (!window.ZXing || !ZXing.BrowserMultiFormatReader) {
        throw new Error('ZXing no se ha cargado. Revisa <script src="https://unpkg.com/@zxing/library@0.20.0">');
      }
      if (eventIdEl) eventIdEl.value = EVENT_ID;

      const hints = new Map();
      hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.QR_CODE]);
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);

      codeReader = new ZXing.BrowserMultiFormatReader(hints);
      await listCameras();

      btnStart.disabled = true; btnStop.disabled = false;
      setStatus('Escaneando… (se reinicia tras cada lectura)', 'ok');

      scanning = true;
      await startScanLoop();
    } catch (e) {
      btnStart.disabled=false; btnStop.disabled=true;
      setStatus(`Error: ${e.message||e}`, 'err');
    }
  }

  async function stop() {
    scanning = false;
    try { codeReader?.reset(); const ms = video.srcObject; ms?.getTracks?.().forEach(t => t.stop()); } catch {}
    btnStart.disabled=false; btnStop.disabled=true; setStatus('Cámara detenida.');
  }

  btnStart.addEventListener('click', start);
  btnStop.addEventListener('click', stop);

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
