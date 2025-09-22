// ==== CONFIGURACIÓN (mismo origen en Koyeb) ====
// Si tu frontend y backend están en el mismo dominio, deja API_BASE = "" (sin CORS)
const API_BASE = "";
const ATTENDANT_TOKEN = "scan-XYZ123"; // debe coincidir con tu var de entorno en Koyeb
const EVENT_ID = "MF2025";             // opcional, informativo

document.addEventListener("DOMContentLoaded", () => {
  const video    = document.getElementById("video");
  const startBtn = document.getElementById("btnStart");
const stopBtn  = document.getElementById("btnStop");
  const statusEl = document.getElementById("status");
  const outputEl = document.getElementById("output");
  const eventIdEl= document.getElementById("eventId");

  let codeReader = null;
  let lastText = null;
  let lastAt = 0;

  const setStatus = (msg, type) => {
    statusEl.className = "status" + (type ? " " + type : "");
    statusEl.textContent = msg;
  };
  const setResult = (text) => {
    outputEl.textContent = text || "—";
  };

  function ensureZXing() {
    if (!window.ZXing || !ZXing.BrowserMultiFormatReader) {
      throw new Error(
        'ZXing no se ha cargado. Usa: <script src="https://unpkg.com/@zxing/library@0.20.0/umd/index.min.js"></script>'
      );
    }
    startBtn.disabled = true;
  stopBtn.disabled  = false;
  }

  async function pickBackCamera() {
    // iOS: pedir un stream breve para obtener labels
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      s.getTracks().forEach(t => t.stop());
    } catch { /* ignore */ }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const vids = devices.filter(d => d.kind === "videoinput");
    const back = vids.find(d => /back|rear|environment|trasera|posterior|atr[aá]s/i.test(d.label));
    return back?.deviceId || vids[1]?.deviceId || vids[0]?.deviceId || null;
  }

  async function startCamera() {
    try {
      ensureZXing();
      if (eventIdEl) eventIdEl.value = EVENT_ID;

      codeReader = new ZXing.BrowserMultiFormatReader();

      const deviceId = await pickBackCamera();
      const constraints = deviceId
        ? { video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } }
        : { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } };

      // Abrir cámara
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play();

      // Decodificar continuamente
      await codeReader.decodeFromVideoDevice(deviceId || null, video, (result, err) => {
        if (result) {
          const text = result.getText();
          const now = Date.now();
          if (text === lastText && now - lastAt < 1200) return; // anti-doble
          lastText = text; lastAt = now;
          setResult(text);
          sendCheckin(text).catch(e => {
            console.error(e);
            setStatus("Error enviando check-in", "err");
          });
        }
        // Los NotFound son normales mientras no hay QR en cuadro
      });

      startBtn.disabled = true;
      setStatus("Cámara encendida. Escaneando…", "ok");
    } catch (e) {
      console.error("Error al iniciar cámara:", e);
      setStatus("No se pudo abrir la cámara. Revisa permisos y vuelve a intentarlo.", "err");
    }
  }

  async function sendCheckin(codeText) {
    if (!ATTENDANT_TOKEN) {
      setStatus("Falta ATTENDANT_TOKEN", "err");
      return;
    }
    const payload = { code: codeText, via: "camera" }; // el backend solo necesita esto
    const res = await fetch(`${API_BASE}/api/checkin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ATTENDANT_TOKEN}`
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    const msg = data.duplicate ? "⚠️ DUPLICADO" : "✅ OK";
    setStatus(`Check-in: ${msg}`, data.duplicate ? "err" : "ok");
  }

  startBtn.addEventListener("click", startCamera);

stopBtn.addEventListener("click", () => {
  try {
    codeReader?.reset();
    const ms = video.srcObject;
    ms?.getTracks?.().forEach(t => t.stop());
  } catch {}
  startBtn.disabled = false;
  stopBtn.disabled  = true;
  statusEl.textContent = "Cámara detenida.";
});

  video.addEventListener("loadedmetadata", () => {
    video.setAttribute("playsinline", "true");
    video.play().catch(() => {});
  });

  setStatus('Listo. Pulsa "Iniciar cámara".');
  setResult("—");
});
