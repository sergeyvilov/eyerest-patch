// Injected by libfsaux.dylib into eyeREST's WebViews (main window only).
//
// 1. "Auto" camera: adds a virtual first entry to the camera dropdown. While it
//    is selected, the app uses the first external camera that is connected and
//    falls back to the built-in one; plugging/unplugging a camera switches the
//    running stream over. The entry's label shows the camera currently in use.
//    Because it is the first entry, the app also picks it by itself whenever
//    the previously selected camera is missing.
// 2. While monitoring is running and no face is detected, the blink smile is
//    shown continuously (the window stacking itself is handled in fsaux.m).
// 3. Start/stop: monitoring starts by itself every time the app opens, also
//    after a manual Stop. The menu-bar menu (fsaux.m) calls
//    window.__fsaux.start()/stop().
// 4. Usage statistics: a "Statistics" button in the footer opens two
//    GitHub-style yearly grids, one square per day: the share of screen-on
//    time with monitoring running, and smiles per hour of monitoring with a
//    face in view, not counting time and smiles while looking down. Screen-on
//    time comes from the macOS power log (fsaux.m).
// 5. "Run at startup" checkbox under the start/stop button. The window starts
//    hidden (fsaux.m) unless the camera permission or intro is still pending.
(() => {
  if (location.pathname !== '/' && location.pathname !== '/index.html') return;

  const AUTO_ID = 'fsaux-auto';
  const AUTO_PREFIX = 'Auto ⟳ ';
  const BUILTIN = /FaceTime|MacBook|iMac|Built-?in|Integrated|Integriert/i;
  // Cameras never picked automatically (still selectable by hand).
  const IGNORE = /Desk View|Schreibtischansicht|Virtual|OBS|Zoom|Snap Camera|Camo/i;
  const SHOW_EVERY_MS = 1500;

  const post = (o) => { try { window.webkit.messageHandlers.fsaux.postMessage(o); } catch (e) {} };
  const log = (msg) => post({ cmd: 'log', msg });
  const invoke = (cmd) => window.__TAURI_INTERNALS__.invoke(cmd).catch((e) => log(cmd + ' failed: ' + e));
  // WebKit pauses page timers while the window is hidden; timers driven by a
  // Worker keep running (the app's own face detector does the same).
  function workerInterval(fn, ms) {
    const src = 'setInterval(() => postMessage(0), ' + ms + ');';
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = fn;
    return w;
  }
  function workerTimeout(fn, ms) {
    const w = workerInterval(() => { w.terminate(); fn(); }, ms);
  }

  const md = navigator.mediaDevices;
  const origEnumerate = md.enumerateDevices.bind(md);
  const origGetUserMedia = md.getUserMedia.bind(md);

  // ---------- 1. automatic camera ----------

  // One-time switch of the saved camera to Auto (runs before the app reads it).
  try {
    if (!localStorage.getItem('fsaux-auto-migrated')) {
      const st = JSON.parse(localStorage.getItem('settings'));
      if (st && st.global) { st.global.deviceId = AUTO_ID; localStorage.setItem('settings', JSON.stringify(st)); }
      localStorage.setItem('fsaux-auto-migrated', '1');
    }
  } catch (e) {}

  let cams = [];          // real video inputs [{deviceId,label}]
  let current = null;     // deviceId the auto stream is using
  let autoStream = null;  // MediaStream handed to the app for AUTO_ID
  const videos = new Set();

  async function listCams() {
    let list = (await origEnumerate()).filter((d) => d.kind === 'videoinput');
    if (list.some((d) => !d.label)) {
      // WebKit hides labels until the page has used the camera once.
      try {
        const s = await origGetUserMedia({ video: true });
        s.getTracks().forEach((t) => t.stop());
        list = (await origEnumerate()).filter((d) => d.kind === 'videoinput');
      } catch (e) { log('label unlock failed: ' + e); }
    }
    cams = list.map((d) => ({ deviceId: d.deviceId, label: d.label }));
    return cams;
  }

  function best() {
    const usable = cams.filter((c) => !IGNORE.test(c.label));
    return usable.find((c) => !BUILTIN.test(c.label)) || usable.find((c) => BUILTIN.test(c.label)) || cams[0] || null;
  }

  const autoLabel = () => AUTO_PREFIX + (best() ? best().label : '—');

  md.enumerateDevices = async () => {
    const all = await origEnumerate();
    await listCams();
    if (!cams.length) return all;
    const virt = { deviceId: AUTO_ID, groupId: '', kind: 'videoinput', label: autoLabel(), toJSON() { return this; } };
    return [virt, ...all];
  };

  function wantsAuto(c) {
    const id = c && c.video && c.video.deviceId;
    return id === AUTO_ID || (id && (id.exact === AUTO_ID || id.ideal === AUTO_ID));
  }

  function withDevice(c, deviceId) {
    return { ...c, video: { ...c.video, deviceId: { exact: deviceId } } };
  }

  let lastConstraints = null;
  md.getUserMedia = async (c) => {
    // WebKit only grants camera requests while the page is visible; ask the
    // native side to put the hidden window on screen invisibly meanwhile.
    const ghost = document.hidden;
    if (ghost) post({ cmd: 'ghost', on: true });
    try { return await getUserMediaInner(c); }
    catch (e) { log('getUserMedia failed: ' + e); throw e; }
    finally { if (ghost) post({ cmd: 'ghost', on: false }); }
  };
  async function getUserMediaInner(c) {
    if (!wantsAuto(c)) return origGetUserMedia(c);
    await listCams();
    const b = best();
    if (!b) throw new DOMException('No camera connected', 'NotFoundError');
    lastConstraints = c;
    current = b.deviceId;
    autoStream = await origGetUserMedia(withDevice(c, current));
    log('auto camera -> ' + b.label);
    refreshLabels();
    return autoStream;
  }

  // Remember the app's <video> elements so a swapped stream can be re-attached.
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    configurable: true,
    get() { return srcDesc.get.call(this); },
    set(v) { if (v) videos.add(this); else videos.delete(this); srcDesc.set.call(this, v); },
  });

  const streamActive = () => autoStream && autoStream.getVideoTracks().some((t) => !t.fsauxStopped);
  const origStop = MediaStreamTrack.prototype.stop;
  MediaStreamTrack.prototype.stop = function () { this.fsauxStopped = true; return origStop.call(this); };

  async function onDeviceChange() {
    await listCams();
    refreshLabels();
    const b = best();
    if (!streamActive() || !b || b.deviceId === current) return;
    log('camera change -> ' + b.label);
    try {
      const ghost = document.hidden;
      if (ghost) post({ cmd: 'ghost', on: true });
      let fresh;
      try { fresh = await origGetUserMedia(withDevice(lastConstraints, b.deviceId)); }
      finally { if (ghost) post({ cmd: 'ghost', on: false }); }
      for (const t of autoStream.getVideoTracks()) { autoStream.removeTrack(t); origStop.call(t); }
      for (const t of fresh.getVideoTracks()) autoStream.addTrack(t);
      current = b.deviceId;
      for (const v of videos) {
        if (srcDesc.get.call(v) === autoStream) { srcDesc.set.call(v, null); srcDesc.set.call(v, autoStream); v.play().catch(() => {}); }
      }
    } catch (e) { log('camera switch failed: ' + e); }
  }
  md.addEventListener('devicechange', () => workerTimeout(onDeviceChange, 500));

  // The dropdown reads labels only when it mounts; keep the Auto label current.
  function refreshLabels() {
    const want = autoLabel();
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue.startsWith(AUTO_PREFIX) && n.nodeValue !== want) n.nodeValue = want;
    }
  }
  new MutationObserver(() => refreshLabels()).observe(document.documentElement, { childList: true, subtree: true });

  // ---------- 2. smile while no face is detected ----------

  function popupEnabled() {
    try { return JSON.parse(localStorage.getItem('settings')).config.popupStatus !== 'disabled'; } catch (e) { return true; }
  }

  // The app hides the face-detector canvas container (after a 2 s debounce)
  // and shows a "face not found" card instead.
  function noFace() {
    const canvas = document.getElementById('canvas-face-detector');
    return !!(canvas && canvas.closest('[hidden]'));
  }

  let showing = false;
  workerInterval(() => {
    const want = noFace() && popupEnabled();
    if (want) {
      if (!showing) { log('no face -> showing smile'); window.__fsaux.faceLost(); }
      showing = true;
      invoke('show_blink_popup');
    } else if (showing) {
      showing = false;
      log('face back -> hiding smile');
      invoke('hide_blink_popup');
    }
  }, SHOW_EVERY_MS);

  // ---------- 3. start / stop ----------

  // The start/stop button is the page's only 2xl button; monitoring is running
  // while the face-detector canvas exists.
  const toggleButton = () => document.querySelector('button.button--size_2xl');
  const running = () => !!document.getElementById('canvas-face-detector');
  // Left over from earlier versions, which remembered a manual Stop.
  try { localStorage.removeItem('fsaux-user-stopped'); } catch (e) {}
  // The window starts hidden (fsaux.m); show it while the camera permission or
  // the app's first-run intro still needs the user.
  try {
    const g = JSON.parse(localStorage.getItem('settings') || '{}').global || {};
    if (g.permission !== 'granted' || g.presentation) { log('setup pending -> open window'); post({ cmd: 'menu', item: 'open' }); }
  } catch (e) {}

  document.addEventListener('click', (e) => {
    const b = toggleButton();
    if (b && b.contains(e.target)) log(running() ? 'user stop' : 'user start');
  }, true);

  function start() {
    const b = toggleButton();
    if (running() || !b || b.disabled) return false;
    b.click();
    return true;
  }
  function stop() {
    const b = toggleButton();
    if (!running() || !b) return false;
    b.click();
    return true;
  }
  window.__fsaux = { start, stop, running };

  // Auto-start shortly after launch, once the camera is selected.
  let autoTries = 0;
  const autoStart = workerInterval(() => {
    if (++autoTries > 60 || running()) { autoStart.terminate(); return; }
    const b = toggleButton();
    if (b && !b.disabled) {
      log('auto start');
      b.click();
      autoStart.terminate();
    }
  }, 1000);

  // Tell the native side whether monitoring is running (menu) and the app's
  // language (exit confirmation).
  let lastState = null;
  workerInterval(() => {
    let lang = false;
    try { lang = JSON.parse(localStorage.getItem('settings')).global.languageCode === 'de'; } catch (e) {}
    const st = { cmd: 'state', running: running(), de: lang };
    const key = JSON.stringify(st);
    if (key !== lastState) { lastState = key; post(st); }
  }, 500);

  // ---------- 4. usage statistics ----------

  const STATS_KEY = 'fsaux-stats';
  const TICK_MS = 10000;
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

  // {since: first day recorded, days: {'YYYY-MM-DD': {track, face, smiles, screen}}}
  // track: seconds monitoring ran with the screen on; face: the part of it with
  // a face in view; smiles: blink smiles shown (not the no-face smile);
  // screen: screen-on seconds from the power log.
  function loadStats() {
    try {
      const s = JSON.parse(localStorage.getItem(STATS_KEY));
      if (s && s.days) return s;
    } catch (e) {}
    return { since: dayKey(new Date()), days: {} };
  }
  const stats = loadStats();
  const saveStats = () => { try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (e) {} };
  const today = () => {
    const k = dayKey(new Date());
    return stats.days[k] || (stats.days[k] = { track: 0, face: 0, smiles: 0, screen: 0 });
  };

  // Looking down (writing, reading notes) makes the eyelids look half closed to
  // the face model, so the app misses blinks and shows smiles. Such time and
  // smiles are left out of the smile rate. The app passes MediaPipe's
  // blendshapes (52 categories, '_neutral' first) through Array#filter/#find
  // to pick the eyeBlink scores; that is where the scores are read.
  const LOOK_DOWN = 0.4;       // eyeLookDownLeft/Right average from here on = looking down (screen: ~0.1)
  const LOOK_DOWN_HOLD = 4000; // a smile up to this long after looking down is not counted
  let downSamples = 0, upSamples = 0, lastDownAt = 0;
  let gazeSum = 0, blinkSum = 0;  // per tick, for the log
  function onBlendshapes(cats) {
    let down = 0, blink = 0;
    for (const c of cats) {
      if (c.categoryName === 'eyeLookDownLeft' || c.categoryName === 'eyeLookDownRight') down += c.score / 2;
      else if (c.categoryName === 'eyeBlinkLeft' || c.categoryName === 'eyeBlinkRight') blink += c.score / 2;
    }
    gazeSum += down; blinkSum += blink;
    if (down >= LOOK_DOWN) { downSamples++; lastDownAt = Date.now(); } else upSamples++;
  }
  const isBlendshapes = (a) => a.length > 40 && a[0] && a[0].categoryName === '_neutral';
  for (const name of ['filter', 'find']) {
    const orig = Array.prototype[name];
    Array.prototype[name] = function () {
      if (isBlendshapes(this)) onBlendshapes(this);
      return orig.apply(this, arguments);
    };
  }

  let screenOn = true;
  let lastTick = Date.now();
  workerInterval(() => {
    const now = Date.now();
    // Timers stop while the Mac sleeps; never count more than one missed tick.
    const dt = Math.min(now - lastTick, 2 * TICK_MS) / 1000;
    lastTick = now;
    const samples = downSamples + upSamples;
    const upShare = samples ? upSamples / samples : 1;
    if (samples) log('gaze: down ' + (gazeSum / samples).toFixed(2) + ' blink ' + (blinkSum / samples).toFixed(2) + ' looking down ' + Math.round(100 * (1 - upShare)) + '%');
    downSamples = upSamples = 0; gazeSum = blinkSum = 0;
    if (!screenOn || !running()) return;
    const d = today();
    d.track += dt;
    // Face time counts only the part spent not looking down.
    if (!noFace()) d.face += dt * upShare;
    saveStats();
  }, TICK_MS);

  // The app shows its own smile ~3 s after the face goes away (no blinks),
  // before the no-face state is noticed (2 s debounce + polling). Smiles from
  // just before a face loss are taken back.
  const UNDO_MS = 5000;
  let recentSmiles = [];
  window.__fsaux.smileShown = () => {
    if (showing || !running() || noFace()) return;
    if (Date.now() - lastDownAt < LOOK_DOWN_HOLD) { log('smile while looking down: not counted'); return; }
    today().smiles++;
    recentSmiles.push(Date.now());
    saveStats();
  };
  window.__fsaux.faceLost = () => {
    const undo = recentSmiles.filter((ts) => Date.now() - ts < UNDO_MS).length;
    recentSmiles = [];
    if (!undo) return;
    const d = today();
    d.smiles = Math.max(0, d.smiles - undo);
    saveStats();
    log('face lost: ' + undo + ' smile(s) not counted');
  };
  window.__fsaux.screenOn = (on) => { screenOn = on; lastTick = Date.now(); };
  window.__fsaux.screenTime = ({ first, days }) => {
    for (const [k, sec] of Object.entries(days)) {
      // The log only reaches back about a week; keep what older runs saw.
      const d = stats.days[k] || (stats.days[k] = { track: 0, face: 0, smiles: 0, screen: 0 });
      if (k > first) d.screen = sec; else d.screen = Math.max(d.screen, sec);
    }
    saveStats();
    if (panel && !panel.hidden) renderStats();
  };
  const requestScreenTime = () => post({ cmd: 'screentime' });
  workerTimeout(requestScreenTime, 3000);
  workerInterval(requestScreenTime, 30 * 60 * 1000);

  // Values per day (null = no data).
  function coverage(d) {
    if (!d || !d.screen || d.screen < 60) return null;
    return Math.min(100, (100 * d.track) / d.screen);
  }
  function smileRate(d) {
    if (!d || d.face < 300) return null;  // under 5 minutes says nothing
    return d.smiles / (d.face / 3600);
  }

  const de = () => {
    try { return JSON.parse(localStorage.getItem('settings')).global.languageCode === 'de'; } catch (e) { return false; }
  };
  const T = {
    stats: ['Statistics', 'Statistik'],
    autostart: ['Run at startup', 'Beim Systemstart ausführen'],
    approval: ['allow eyeREST in System Settings → General → Login Items', 'eyeREST unter Systemeinstellungen → Allgemein → Anmeldeobjekte erlauben'],
    covTitle: ['Monitoring time', 'Überwachungszeit'],
    covSub: ['share of screen time with eyeREST monitoring', 'Anteil der Bildschirmzeit mit eyeREST-Überwachung'],
    smileTitle: ['Smiles per hour', 'Smileys pro Stunde'],
    smileSub: ['while monitoring with a face in view; fewer means you blink more often', 'während der Überwachung mit erkanntem Gesicht; weniger heißt: Sie blinzeln öfter'],
    noData: ['no data', 'keine Daten'],
    of: ['of', 'von'],
    smilesIn: ['smiles in', 'Smileys in'],
    perHour: ['/h', '/h'],
    last7: ['Last 7 days', 'Letzte 7 Tage'],
    prev7: ['previous 7 days', 'vorherige 7 Tage'],
    less: ['Less', 'Weniger'],
    more: ['More', 'Mehr'],
  };
  const t = (k) => T[k][de() ? 1 : 0];
  const fmtDur = (sec) => {
    const m = Math.round(sec / 60);
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + pad(m % 60) + ' min';
  };
  const fmtDate = (d) => d.toLocaleDateString(de() ? 'de-DE' : 'en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  // GitHub's light-theme greens, and an orange ramp for smiles (more = worse).
  const GREENS = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'];
  const ORANGES = ['#ebedf0', '#ffdf9e', '#ffb35c', '#f0782b', '#bd3f0e'];
  const WEEKS = 53;
  const CELL = 10, GAP = 3;

  // Level 1..4 for a value: fixed quarters for percentages, quartiles of the
  // non-empty days for smile rates (as GitHub does for contributions).
  function levels(values, fixedMax) {
    if (fixedMax) return (v) => (v <= 0 ? 0 : Math.min(4, Math.ceil((4 * v) / fixedMax)));
    const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    const cuts = sorted.length ? [q(0.25), q(0.5), q(0.75)] : [];
    return (v) => (v <= 0 ? 0 : 1 + cuts.filter((c) => v > c).length);
  }

  function grid(valueOf, colors, fixedMax, describe) {
    const end = new Date(); end.setHours(12, 0, 0, 0);
    const start = new Date(end);
    // Columns are weeks starting on Monday; the last one holds today.
    start.setDate(end.getDate() - ((end.getDay() + 6) % 7) - 7 * (WEEKS - 1));
    // Monitoring time and smiles are only known from the first recorded day.
    const days = [];
    for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const k = dayKey(d);
      days.push({ date: new Date(d), v: k >= stats.since ? valueOf(stats.days[k]) : null, d: stats.days[k] });
    }
    const lvl = levels(days.map((x) => x.v || 0), fixedMax);
    const W = 30 + WEEKS * (CELL + GAP), H = 16 + 7 * (CELL + GAP);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.style.display = 'block';
    const text = (x, y, s) => {
      const e = document.createElementNS(ns, 'text');
      e.setAttribute('x', x); e.setAttribute('y', y); e.setAttribute('font-size', '9'); e.setAttribute('fill', '#57606a');
      e.textContent = s; svg.appendChild(e);
    };
    const dayNames = de() ? ['Mo', 'Mi', 'Fr'] : ['Mon', 'Wed', 'Fri'];
    [0, 2, 4].forEach((r, i) => text(0, 16 + r * (CELL + GAP) + 8, dayNames[i]));
    let lastMonth = -1;
    days.forEach((x, i) => {
      const col = Math.floor(i / 7), row = i % 7;
      if (row === 0 && x.date.getMonth() !== lastMonth && col < WEEKS - 2) {
        lastMonth = x.date.getMonth();
        text(30 + col * (CELL + GAP), 9, x.date.toLocaleDateString(de() ? 'de-DE' : 'en-US', { month: 'short' }));
      }
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', 30 + col * (CELL + GAP)); r.setAttribute('y', 16 + row * (CELL + GAP));
      r.setAttribute('width', CELL); r.setAttribute('height', CELL); r.setAttribute('rx', 2);
      r.setAttribute('fill', x.v == null ? '#f6f8fa' : colors[lvl(x.v)]);
      r.setAttribute('stroke', 'rgba(27,31,36,0.06)');
      r.addEventListener('mouseenter', () => showTip(r, fmtDate(x.date) + ': ' + (x.v == null ? t('noData') : describe(x.v, x.d))));
      r.addEventListener('mouseleave', hideTip);
      svg.appendChild(r);
    });
    const legend = document.createElement('div');
    legend.style.cssText = 'display:flex;align-items:center;gap:3px;justify-content:flex-end;font-size:10px;color:#57606a;margin-top:4px';
    legend.append(t('less'));
    colors.forEach((c) => { const b = document.createElement('span'); b.style.cssText = 'width:10px;height:10px;border-radius:2px;background:' + c; legend.append(b); });
    legend.append(t('more'));
    const wrap = document.createElement('div');
    wrap.append(svg, legend);
    return wrap;
  }

  // Average over a span of days, weighted by time: a 7-day trend line.
  function span(fromDaysAgo, toDaysAgo) {
    let track = 0, screen = 0, face = 0, smiles = 0;
    for (let i = fromDaysAgo; i > toDaysAgo; i--) {
      const d = new Date(); d.setDate(d.getDate() - i + 1);
      const x = stats.days[dayKey(d)];
      if (!x) continue;
      track += x.track; screen += x.screen; face += x.face; smiles += x.smiles;
    }
    return { cov: screen >= 60 ? Math.min(100, (100 * track) / screen) : null, rate: face >= 300 ? smiles / (face / 3600) : null };
  }

  let panel = null, tip = null;
  function showTip(target, s) {
    if (!tip) {
      tip = document.createElement('div');
      tip.style.cssText = 'position:fixed;z-index:1001;pointer-events:none;background:#24292f;color:#fff;font-size:11px;padding:5px 8px;border-radius:6px;white-space:nowrap';
      document.body.appendChild(tip);
    }
    tip.textContent = s;
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const w = tip.offsetWidth;
    tip.style.left = Math.max(4, Math.min(innerWidth - w - 4, r.left + r.width / 2 - w / 2)) + 'px';
    tip.style.top = (r.top - tip.offsetHeight - 6) + 'px';
  }
  function hideTip() { if (tip) tip.hidden = true; }

  function section(title, sub, body, summary) {
    const s = document.createElement('div');
    s.style.cssText = 'margin-bottom:22px';
    const h = document.createElement('div');
    h.style.cssText = 'font-weight:600;font-size:15px;text-transform:uppercase';
    h.textContent = title;
    const p = document.createElement('div');
    p.style.cssText = 'font-size:12px;color:#57606a;margin:2px 0 10px';
    p.textContent = sub;
    const f = document.createElement('div');
    f.style.cssText = 'font-size:12px;margin-top:6px';
    f.textContent = summary;
    s.append(h, p, body, f);
    return s;
  }

  function renderStats() {
    const body = panel.querySelector('.fsaux-stats-body');
    hideTip();
    body.textContent = '';
    const now7 = span(7, 0), prev7 = span(14, 7);
    const pct = (v) => (v == null ? '—' : Math.round(v) + ' %');
    const rate = (v) => (v == null ? '—' : v.toFixed(1) + t('perHour'));
    body.append(
      section(t('covTitle'), t('covSub'),
        grid(coverage, GREENS, 100, (v, d) => Math.round(v) + ' % (' + fmtDur(d.track) + ' ' + t('of') + ' ' + fmtDur(d.screen) + ')'),
        t('last7') + ': ' + pct(now7.cov) + '  ·  ' + t('prev7') + ': ' + pct(prev7.cov)),
      section(t('smileTitle'), t('smileSub'),
        grid(smileRate, ORANGES, 0, (v, d) => v.toFixed(1) + t('perHour') + ' (' + d.smiles + ' ' + t('smilesIn') + ' ' + fmtDur(d.face) + ')'),
        t('last7') + ': ' + rate(now7.rate) + '  ·  ' + t('prev7') + ': ' + rate(prev7.rate)),
    );
  }

  function openStats() {
    if (!panel) {
      panel = document.createElement('div');
      // Covers the content between the title bar and the footer.
      panel.style.cssText = 'position:fixed;left:16px;right:16px;top:57px;bottom:44px;z-index:1000;overflow:auto;' +
        'padding:16px 18px;border:1px dashed #000;background:' + (getComputedStyle(document.body).backgroundColor || '#fff');
      const close = document.createElement('button');
      close.textContent = '✕';
      close.style.cssText = 'position:absolute;right:12px;top:10px;font-size:16px;cursor:pointer;background:none;border:none';
      close.addEventListener('click', () => { panel.hidden = true; hideTip(); });
      const body = document.createElement('div');
      body.className = 'fsaux-stats-body';
      panel.append(close, body);
      document.body.appendChild(panel);
    }
    panel.hidden = false;
    renderStats();
    requestScreenTime();
  }

  // The footer ("// eyeREST: Comfort Vision" ... bot icon) gets a button.
  function addStatsButton() {
    if (document.getElementById('fsaux-stats-btn')) return;
    const bot = document.querySelector('svg.lucide-bot');
    if (!bot || !bot.parentElement) return;
    const b = document.createElement('button');
    b.id = 'fsaux-stats-btn';
    b.className = 'text textStyle_xs';
    b.style.cssText = 'margin-left:auto;margin-right:12px;cursor:pointer;background:none;border:none;text-decoration:underline';
    b.textContent = t('stats');
    b.addEventListener('click', () => (panel && !panel.hidden ? (panel.hidden = true, hideTip()) : openStats()));
    bot.parentElement.insertBefore(b, bot);
  }
  new MutationObserver(addStatsButton).observe(document.documentElement, { childList: true, subtree: true });

  // ---------- 5. run at startup ----------

  let autostart = null;  // 'on' | 'off' | 'approval' | 'unsupported', from fsaux.m
  window.__fsaux.autostartState = (st) => { autostart = st; addAutostartBox(true); };

  function addAutostartBox(update) {
    const b = toggleButton();
    const row = b && b.parentElement;
    if (!row || !row.parentElement || autostart === null || autostart === 'unsupported') return;
    let box = document.getElementById('fsaux-autostart');
    if (box && !update) return;
    if (!box) {
      box = document.createElement('label');
      box.id = 'fsaux-autostart';
      box.className = 'text textStyle_xs';
      box.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:2px;margin-top:10px;cursor:pointer';
      box.innerHTML = '<span style="display:flex;align-items:center;gap:6px"><input type="checkbox" style="width:14px;height:14px;cursor:pointer"><span></span></span><span style="color:#57606a"></span>';
      box.querySelector('input').addEventListener('change', (e) => post({ cmd: 'autostart', on: e.target.checked }));
      row.parentElement.insertBefore(box, row.nextSibling);
    }
    box.querySelector('input').checked = autostart === 'on' || autostart === 'approval';
    box.querySelector('span span').textContent = t('autostart');
    box.lastChild.textContent = autostart === 'approval' ? t('approval') : '';
  }
  new MutationObserver(() => addAutostartBox(false)).observe(document.documentElement, { childList: true, subtree: true });
  post({ cmd: 'autostart' });

  log('inject ready');
})();
