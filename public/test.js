(function () {
  const v = document.getElementById('v');
  const btn = document.getElementById('btn');
  const log = document.getElementById('log');
  const writeln = (m) => { log.textContent += m + '\n'; };

  // Captura errores globales para verlos en el <pre>
  window.addEventListener('error', (e) => {
    writeln('💥 window.error: ' + (e.message || e.error?.message || e.type));
  });
  window.addEventListener('unhandledrejection', (e) => {
    writeln('💥 unhandledrejection: ' + (e.reason?.message || e.reason || 'desconocido'));
  });

  function infoEntorno() {
    writeln('UA: ' + navigator.userAgent);
    writeln('HTTPS: ' + (location.protocol === 'https:' ? 'sí' : 'no'));
    writeln('mediaDevices: ' + (!!navigator.mediaDevices));
    writeln('getUserMedia: ' + (!!navigator.mediaDevices?.getUserMedia));
  }

  async function pickBackId() {
    try {
      // Esto ayuda a que aparezcan labels en iOS
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      s.getTracks().forEach(t => t.stop());
    } catch (_) {}
    const devs = await navigator.mediaDevices.enumerateDevices();
    const vids = devs.filter(d => d.kind === 'videoinput');
    const back = vids.find(d => /back|rear|environment|trasera|atr[aá]s/i.test(d.label));
    return back?.deviceId || vids[1]?.deviceId || vids[0]?.deviceId || null;
  }

  async function start() {
    infoEntorno();

    if (!navigator.mediaDevices?.getUserMedia) {
      writeln('❌ getUserMedia no soportado');
      return;
    }
    try {
      const id = await pickBackId();
      const constraints = id
        ? { video: { deviceId: { exact: id } } }
        : { video: { facingMode: { ideal: 'environment' } } };

      writeln('Constraints: ' + JSON.stringify(constraints));
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      v.srcObject = stream;
      await v.play();
      writeln('✅ Cámara funcionando');
    } catch (e) {
      writeln('❌ Error al abrir cámara: ' + (e.name || e.message));
      console.error(e);
      alert('No se pudo abrir la cámara: ' + (e.message || e.name));
    }
  }

  btn.addEventListener('click', start);
  writeln('⊛ Script cargado. Pulsa "Iniciar cámara".');
})();
