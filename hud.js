// hud.js — live Pace & Filler Word HUD for EchoMetrics Studio.
// Electron has no built-in speech recognition, so this transcribes short audio
// segments (SEGMENT_MS) with your existing 'transcribe-audio' IPC handler and
// derives WPM + fillers from those. The mic level / voice-activity part uses Web Audio.
(function () {
  const { ipcRenderer } = require('electron');

  const SEGMENT_MS = 6000;       // length of each audio chunk sent to Whisper
  const WINDOW_SEGMENTS = 3;     // WPM is computed over the last 3 chunks (~18s)
  const MAX_PENDING = 3;         // skip chunks if transcription falls this far behind
  const VOICED_RMS = 0.02;       // mic level treated as "someone is speaking"
  const MIN_VOICED_RATIO = 0.08; // below this a chunk is treated as silence (not sent)
  const FILLER_RE = /\b(um+|uh+|er+m?|ah+|hmm+|like|you know|i mean)\b/gi;

  const getTarget = () => Number(localStorage.getItem('hud_target_wpm')) || 160;

  // ---------- Styles ----------
  const style = document.createElement('style');
  style.textContent = `
    .hud { position:absolute; inset:0; pointer-events:none; border-radius:8px; border:2px solid transparent;
           display:flex; flex-direction:column; justify-content:space-between; padding:8px; transition:border-color .2s; }
    .hud[hidden] { display:none; }
    .hud-chips { display:flex; gap:6px; }
    .hud-chip { background:rgba(15,23,42,.82); border-radius:6px; padding:4px 8px; font-size:12px; color:#cbd5e1; }
    .hud-chip b { font-size:18px; color:#f8fafc; font-variant-numeric:tabular-nums; }
    .hud-wpm.ok b { color:#4ade80; }
    .hud.fast { border-color:#ef4444; }
    .hud.fast .hud-wpm { animation:hudFlash .7s ease-in-out infinite; }
    .hud.fast .hud-wpm b { color:#fca5a5; }
    @keyframes hudFlash { 0%,100% { background:rgba(15,23,42,.82); } 50% { background:rgba(127,29,29,.95); } }
    @media (prefers-reduced-motion: reduce) { .hud.fast .hud-wpm { animation:none; background:rgba(127,29,29,.95); } }
    .hud-caption { background:rgba(15,23,42,.82); border-radius:6px; padding:6px 8px; font-size:12px; line-height:1.4;
                   color:#e2e8f0; max-height:54px; overflow:hidden; text-align:left; }
    .hud-caption mark { background:#f59e0b; color:#0f172a; border-radius:3px; padding:0 2px; font-weight:bold; }
    .hud-caption .hud-note { color:#94a3b8; }
    .hud-meter { height:4px; background:rgba(15,23,42,.82); border-radius:2px; overflow:hidden; margin-top:6px; }
    .hud-meter i { display:block; height:100%; width:0; background:#38bdf8; }
  `;
  document.head.appendChild(style);

  // ---------- Settings: pace target ----------
  const settingsTab = document.getElementById('tab-settings');
  if (settingsTab) {
    settingsTab.insertAdjacentHTML('beforeend', `
      <div class="section-title">Live HUD</div>
      <div class="api-config">
        <label for="hudTarget" style="font-size:13px;color:#94a3b8;">Flash warning above (WPM):</label>
        <input type="number" id="hudTarget" min="80" max="300" step="5" style="max-width:100px;" />
      </div>`);
    const input = document.getElementById('hudTarget');
    input.value = getTarget();
    input.addEventListener('input', () => localStorage.setItem('hud_target_wpm', input.value));
  }

  function renderMarked(container, text) {
    container.textContent = '';
    let last = 0, m;
    FILLER_RE.lastIndex = 0;
    while ((m = FILLER_RE.exec(text)) !== null) {
      container.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.textContent = m[0];
      container.appendChild(mark);
      last = m.index + m[0].length;
    }
    container.appendChild(document.createTextNode(text.slice(last)));
  }

  const countWords = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);
  const countFillers = (s) => (s.match(FILLER_RE) || []).length;

  // ---------- One HUD per video preview ----------
  function createHud(videoEl) {
    const host = videoEl.parentElement;
    host.style.position = 'relative';
    const el = document.createElement('div');
    el.className = 'hud';
    el.hidden = true;
    el.innerHTML = `
      <div class="hud-chips">
        <span class="hud-chip hud-wpm"><b>--</b> WPM</span>
        <span class="hud-chip hud-fill"><b>0</b> fillers</span>
      </div>
      <div>
        <div class="hud-caption"></div>
        <div class="hud-meter"><i></i></div>
      </div>`;
    host.appendChild(el);

    const wpmChip = el.querySelector('.hud-wpm');
    const wpmVal = wpmChip.querySelector('b');
    const fillVal = el.querySelector('.hud-fill b');
    const caption = el.querySelector('.hud-caption');
    const meterFill = el.querySelector('.hud-meter i');

    let active = false, audioCtx = null, raf = null, recorder = null, segTimer = null;
    let audioStream = null, getKey = null;
    let segStart = 0, voiced = 0, frames = 0, chunks = [];
    let segments = [], fillerTotal = 0, pending = 0, queue = Promise.resolve();

    function note(msg) {
      caption.textContent = '';
      const s = document.createElement('span');
      s.className = 'hud-note';
      s.textContent = msg;
      caption.appendChild(s);
    }

    function refresh() {
      const recent = segments.slice(-WINDOW_SEGMENTS);
      const secs = recent.reduce((a, s) => a + s.dur, 0);
      const words = recent.reduce((a, s) => a + s.words, 0);
      if (secs > 0) {
        const wpm = Math.round((words / secs) * 60);
        wpmVal.textContent = wpm;
        const fast = wpm > getTarget();
        el.classList.toggle('fast', fast && active);
        wpmChip.classList.toggle('ok', !fast && wpm > 0);
      }
      fillVal.textContent = fillerTotal;
      const text = recent.slice(-2).map(s => s.text).join(' ').trim();
      if (text) renderMarked(caption, text);
    }

    function startMeter() {
      audioCtx = new AudioContext();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      audioCtx.createMediaStreamSource(audioStream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        meterFill.style.width = Math.min(100, rms * 300) + '%';
        frames++;
        if (rms > VOICED_RMS) voiced++;
        raf = requestAnimationFrame(tick);
      };
      tick();
    }

    function startSegment() {
      chunks = [];
      voiced = 0;
      frames = 0;
      segStart = Date.now();
      recorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm;codecs=opus' });
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      const myChunks = () => chunks;
      recorder.onstop = () => {
        const blob = new Blob(myChunks(), { type: 'audio/webm' });
        const dur = (Date.now() - segStart) / 1000;
        const voicedRatio = frames ? voiced / frames : 0;
        if (active) startSegment(); // begin the next chunk right away
        handleSegment(blob, dur, voicedRatio);
      };
      recorder.start();
      segTimer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, SEGMENT_MS);
    }

    function handleSegment(blob, dur, voicedRatio) {
      if (dur < 1) return;
      if (voicedRatio < MIN_VOICED_RATIO) {
        // Silence still counts toward the time window, so long pauses pull WPM down.
        segments.push({ dur, words: 0, text: '' });
        refresh();
        return;
      }
      if (pending >= MAX_PENDING) return; // transcription is behind; drop this chunk
      pending++;
      queue = queue.then(async () => {
        try {
          const apiKey = getKey ? getKey() : '';
          const res = await ipcRenderer.invoke('transcribe-audio', { audioArrayBuffer: await blob.arrayBuffer(), apiKey });
          if (!res.success) { note('Live HUD: ' + res.error); return; }
          const text = (res.text || '').trim();
          segments.push({ dur, words: countWords(text), text });
          fillerTotal += countFillers(text);
          refresh();
        } catch (err) {
          note('Live HUD error: ' + err.message);
        } finally {
          pending--;
        }
      });
    }

    return {
      start(stream, keyGetter) {
        if (!stream) return;
        getKey = keyGetter;
        active = true;
        segments = []; fillerTotal = 0; pending = 0; queue = Promise.resolve();
        wpmVal.textContent = '--';
        fillVal.textContent = '0';
        el.classList.remove('fast');
        wpmChip.classList.remove('ok');
        el.hidden = false;
        note(getKey && getKey() ? 'Listening... first reading in about ' + (SEGMENT_MS / 1000) + 's.'
                                : 'Add your Hugging Face key in Settings to enable live pace and fillers.');
        audioStream = new MediaStream(stream.getAudioTracks());
        startMeter();
        if (getKey && getKey()) startSegment();
      },
      stop() {
        active = false;
        clearTimeout(segTimer);
        if (recorder && recorder.state === 'recording') recorder.stop(); // last partial chunk is still counted
        if (raf) cancelAnimationFrame(raf);
        raf = null;
        if (audioCtx) audioCtx.close();
        audioCtx = null;
        meterFill.style.width = '0%';
        el.classList.remove('fast');
      }
    };
  }

  window.EchoHud = {
    practice: createHud(document.getElementById('preview')),
    reading: createHud(document.getElementById('previewReading'))
  };
})();