// ==== CONFIGURACIÓN (mismo origen en Koyeb) ====
// Si frontend y backend están en el mismo dominio, deja API_BASE = "" (sin CORS)
const API_BASE = "";
const ATTENDANT_TOKEN = "scan-XYZ123"; // debe coincidir con tu var de entorno en Koyeb
const EVENT_ID = "MF2025";             // opcional, informativo

document.addEventListener("DOMContentLoaded", () => {
  const video     = document.getElementById("video");
  const startBtn  = document.getElementById("startCam");
  const statusEl  = document.getElementById("status");
  const outputEl  = document.getElementById("output");
  const btnCopy   = document.getElementById("btnCopy");
  const openLink  = document.getElementById("openLink");
  const eventIdEl = document.getElementById("eventId");

  let codeReader = null;
  let lastText = null;
  let lastAt = 0;

  const setStatus = (msg, type) => {
    statusEl.className = "status" + (type ? " " + type : "");
    statusEl.textContent = msg;
  };
  const setResult = (text) => {
    outputEl.textContent = text || "—";
    try {
      const url = new URL(text);
      openLink.style.display = "inline-block";
      openLink.href = url.href;
    } catch {
      openLink.style.display = "none";
      openLink.removeAttribute("href");
    }
    btnCopy.disabled = !text || text === "—";
  };

  function ensureZXing() {
    if (!window.ZXing || !ZXing.BrowserMultiFormatReader) {
      throw new Error("ZXing no se ha cargado (usa /vendor/zxing.umd.min.js).");
    }
  }

  async function pickBackCamera() {
    // iOS: pedir un stream breve para revelar labels
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

      // 1) Forzar PROMPT de permisos con stream temporal mínimo
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
        tmp.getTracks().forEach(t => t.stop());
      } catch (e) {
        console.error("Permiso cámara falló:", e);
        setStatus("No se pudo solicitar permiso de cámara. Revisa el icono del candado y vuelve a intentarlo.", "err");
        return;
      }

      // 2) Con permisos concedidos, elegir trasera y arrancar ZXing
      codeReader = new ZXing.BrowserMultiFormatReader();

      const deviceId = await pickBackCamera();
      const constraints = deviceId
        ? { video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } }
        : { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play();

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
        // NotFound/Checksum son normales mientras no hay QR en cuadro
      });

      startBtn.disabled = true;
      setStatus("Cámara encendida. Escaneando…", "ok");
    } catch (e) {
      console.error("Error al iniciar cámara:", e);
      setStatus(`No se pudo abrir la cámara (${e.name || e.message}). Revisa permisos del sitio.`, "err");
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

  // Listeners
  startBtn.addEventListener("click", startCamera);

  btnCopy.addEventListener("click", async () => {
    const t = outputEl.textContent.trim();
    if (!t || t === "—") return;
    try {
      await navigator.clipboard.writeText(t);
      setStatus("Copiado.", "ok");
    } catch {
      setStatus("No se pudo copiar.", "err");
    }
  });

  video.addEventListener("loadedmetadata", () => {
    video.setAttribute("playsinline", "true");
    video.play().catch(() => {});
  });

  setStatus('Listo. Pulsa "Iniciar cámara".');
  setResult("—");
});
