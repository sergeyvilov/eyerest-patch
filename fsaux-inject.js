// Injected by libfsaux.dylib into eyeREST's WebViews (main window only).
//
// 1. "Auto" camera: adds a virtual first entry to the camera dropdown. While it
//    is selected, the app uses the first external camera that is connected and
//    falls back to the built-in one; plugging/unplugging a camera restarts
//    monitoring with the new one. The entry's label shows the camera currently in use.
//    Because it is the first entry, the app also picks it by itself whenever
//    the previously selected camera is missing.
// 2. While monitoring is running and no face is detected, the blink smile is
//    shown continuously (the window stacking itself is handled in fsaux.m).
// 3. Start/stop: monitoring starts by itself every time the app opens, also
//    after a manual Stop. The menu-bar menu (fsaux.m) calls
//    window.__fsaux.start()/stop().
// 4. Usage statistics: a "Statistics" button in the footer opens two
//    GitHub-style yearly grids, one square per day: the share of screen-on
//    time with monitoring running, and spontaneous blinks per minute while
//    the face is found and not looking down, without blinks right after a
//    smile. Screen-on time comes from the macOS power log (fsaux.m).
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
  let videoW = 720, videoH = 576;  // size of the camera image (face points are relative to it)
  let current = null;     // deviceId the auto stream is using

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
    current = b.deviceId;
    const stream = await origGetUserMedia(withDevice(c, current));
    const vs = stream.getVideoTracks()[0] && stream.getVideoTracks()[0].getSettings();
    if (vs && vs.width && vs.height) { videoW = vs.width; videoH = vs.height; }
    // The camera went away (unplugged, display detached) without a devicechange.
    for (const t of stream.getVideoTracks()) t.addEventListener('ended', () => scheduleCameraCheck('camera ended'));
    log('auto camera -> ' + b.label);
    refreshLabels();
    return stream;
  }

  // When a better camera appears or the one in use goes away, monitoring is
  // stopped and started again, which opens the new camera. (Swapping the track
  // under the running detector leaves it without frames.) Several devicechange
  // events in a row, e.g. on wake, are handled once.
  let checkTimer = null, restarting = false;
  function scheduleCameraCheck(why) {
    if (checkTimer) checkTimer.terminate();
    checkTimer = workerInterval(() => { checkTimer.terminate(); checkTimer = null; checkCamera(why); }, 1500);
  }
  async function checkCamera(why) {
    await listCams();
    refreshLabels();
    const b = best();
    const ended = why === 'camera ended';
    if (restarting || !running() || !b || (b.deviceId === current && !ended)) return;
    restarting = true;
    log(why + ' -> restarting monitoring with ' + b.label);
    stop();
    let tries = 0;
    const retry = workerInterval(() => {
      if (running() || ++tries > 20 || start()) { retry.terminate(); restarting = false; }
    }, 1000);
  }
  md.addEventListener('devicechange', () => scheduleCameraCheck('camera change'));

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
      if (!showing) log('no face -> showing smile');
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
    const st = { cmd: 'state', running: running(), lang: lang() };
    const key = JSON.stringify(st);
    if (key !== lastState) { lastState = key; post(st); }
  }, 500);

  // ---------- 4. usage statistics ----------

  const STATS_KEY = 'fsaux-stats';
  const TICK_MS = 10000;
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

  // {since: first day recorded, days: {'YYYY-MM-DD': {track, screen, blinks, blinkSec}}}
  // track: seconds monitoring ran with the screen on; screen: screen-on seconds
  // from the power log; blinks: spontaneous blinks counted in blinkSec seconds
  // of usable face time (see below). Older entries also hold face/smiles.
  function loadStats() {
    try {
      const s = JSON.parse(localStorage.getItem(STATS_KEY));
      if (s && s.days) return s;
    } catch (e) {}
    return { since: dayKey(new Date()), days: {} };
  }
  const stats = loadStats();
  try { localStorage.removeItem('fsaux-stats-debug'); } catch (e) {}  // left over from testing
  const saveStats = () => { try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (e) {} };
  const dayEntry = (k) => stats.days[k] || (stats.days[k] = { track: 0, screen: 0 });
  const today = () => dayEntry(dayKey(new Date()));

  // Spontaneous blinks and looking down, from MediaPipe's 478 face points
  // (468 face + 10 iris), which the app's face model builds every processed
  // frame (~13/s) by pushing them one by one into an array; the array is
  // picked up when the last point arrives.
  //
  // Blink: eye aspect ratio (EAR, eyelid gap / eye width) per eye. A blink
  // is the eye(s) chosen in the app (L, R or LR = both) below BLINK_CLOSED
  // of their usual openness, open again within BLINK_MAX_MS. Usual openness:
  // slow average over open frames. As in the app, L is MediaPipe's left eye
  // (points 362...) and R its right eye (points 33...).
  // Looking down: head pitch (forehead vs chin in 3D) in degrees, relative to
  // the usual pitch for this camera (30th percentile of the last 5 minutes,
  // so a camera above the screen doesn't count as "down" and long writing
  // sessions don't shift it), or the irises clearly low in the eyes.
  // A frame counts (time and blinks) only while you are not looking down, and
  // not just after a smile (the first blink after it and any within
  // SMILE_HOLD are deliberate) or after the face was found again.
  const BLINK_CLOSED = 0.7, BLINK_OPEN = 0.85, BLINK_MAX_MS = 500;
  const PITCH_DOWN = 12;        // degrees below the usual head pitch (writing: ~25, keyboard: ~15)
  const IRIS_DOWN = 0.12;       // iris drop below usual, in eye widths
  const GAZE_WINDOW = 300;      // seconds of history for the usual pitch/iris
  const DOWN_HOLD = 1500;       // ms after looking down that still don't count
  const SMILE_HOLD = 3000;      // ms after a smile appears that don't count
  const GAP_HOLD = 1000;        // ms after a pause in frames (face just found again)
  const R_EYE = [33, 160, 158, 133, 153, 144], L_EYE = [362, 385, 387, 263, 373, 380];
  let lastFrameAt = 0, lastDownAt = 0, lastSmileAt = 0, afterSmile = false, resumeAt = 0;
  let baseL = 0, baseR = 0, closedSince = 0, blinkAll = 0;
  function eyeChoice() {
    try { return JSON.parse(localStorage.getItem('settings')).config.eyeStatus || 'LR'; } catch (e) { return 'LR'; }
  }
  let eyes = eyeChoice();
  let gazeHistory = [], gazeCamera = null, secStart = 0, secPitch = 0, secIris = 0, secN = 0;
  let usualPitch = null, usualIris = null;
  let frames = 0, usableFrames = 0, tickPitch = [], tickIris = [], tickEar = [];  // per tick, for the log

  const P = (lm, i) => ({ x: lm[i].x * videoW, y: lm[i].y * videoH, z: lm[i].z * videoW });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function ear(lm, idx) {
    const [p1, p2, p3, p4, p5, p6] = idx.map((i) => P(lm, i));
    return (dist(p2, p6) + dist(p3, p5)) / (2 * dist(p1, p4));
  }
  function pitchDeg(lm) {
    const top = P(lm, 10), chin = P(lm, 152);  // forehead, chin
    return (Math.atan2(chin.z - top.z, chin.y - top.y) * 180) / Math.PI;  // > 0: head down
  }
  function irisDrop(lm) {
    // Iris centre below the line between the eye corners, in eye widths.
    const one = (iris, a, b) => {
      const c = P(lm, iris), p = P(lm, a), q = P(lm, b);
      return (c.y - (p.y + q.y) / 2) / dist(p, q);
    };
    return (one(468, 33, 133) + one(473, 362, 263)) / 2;
  }
  const percentile = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(p * s.length)]; };
  const median = (a) => percentile(a, 0.5);

  function updateUsualGaze(now, pitch, iris) {
    if (gazeCamera !== current) { gazeCamera = current; gazeHistory = []; usualPitch = usualIris = null; }
    secPitch += pitch; secIris += iris; secN++;
    if (now - secStart < 1000) return;
    gazeHistory.push([secPitch / secN, secIris / secN]);
    if (gazeHistory.length > GAZE_WINDOW) gazeHistory.shift();
    secStart = now; secPitch = secIris = 0; secN = 0;
    if (gazeHistory.length >= 10) {
      usualPitch = percentile(gazeHistory.map((g) => g[0]), 0.3);
      usualIris = percentile(gazeHistory.map((g) => g[1]), 0.3);
    }
  }

  let lastLandmarks = null;
  function onLandmarks(lm) {
    if (lm === lastLandmarks) return;
    lastLandmarks = lm;
    const now = Date.now();
    if (now - lastFrameAt > 1000) resumeAt = now;
    lastFrameAt = now;
    const eL = ear(lm, L_EYE), eR = ear(lm, R_EYE), pitch = pitchDeg(lm), iris = irisDrop(lm);
    frames++; tickPitch.push(pitch); tickIris.push(iris); tickEar.push((eL + eR) / 2);
    updateUsualGaze(now, pitch, iris);
    const down = usualPitch === null || pitch > usualPitch + PITCH_DOWN || iris > usualIris + IRIS_DOWN;
    if (down) lastDownAt = now;
    const usable = now - lastDownAt > DOWN_HOLD && now - lastSmileAt > SMILE_HOLD && now - resumeAt > GAP_HOLD;
    if (usable) usableFrames++;

    if (!baseL) { baseL = eL; baseR = eR; }
    const useL = eyes !== 'R', useR = eyes !== 'L';
    const closed = (!useL || eL < baseL * BLINK_CLOSED) && (!useR || eR < baseR * BLINK_CLOSED);
    const open = (!useL || eL > baseL * BLINK_OPEN) && (!useR || eR > baseR * BLINK_OPEN);
    if (closed) {
      if (!closedSince) closedSince = now;
      return;
    }
    if (open) {
      // Usual openness follows slowly (about 2 s), from open frames only.
      baseL += (eL - baseL) * 0.05; baseR += (eR - baseR) * 0.05;
    }
    if (!closedSince || !open) return;
    const ms = now - closedSince;
    closedSince = 0;
    if (ms > BLINK_MAX_MS) return;  // eyes closed for a while, not a blink
    blinkAll++;
    if (afterSmile) { afterSmile = false; return; }  // the blink that answers a smile
    if (!usable || !running()) return;
    const d = today();
    d.blinks = (d.blinks || 0) + 1;
  }
  const origPush = Array.prototype.push;
  Array.prototype.push = function (...items) {
    const n = origPush.apply(this, items);
    if (n === 478 && items.length === 1 && typeof items[0].z === 'number' && typeof items[0].x === 'number') onLandmarks(this);
    return n;
  };

  let screenOn = true;
  let lastTick = Date.now();
  workerInterval(() => {
    const now = Date.now();
    // Timers stop while the Mac sleeps; never count more than one missed tick.
    const dt = Math.min(now - lastTick, 2 * TICK_MS) / 1000;
    lastTick = now;
    const usableShare = frames ? usableFrames / frames : 0;
    if (frames) {
      const f1 = (v) => (v == null ? '-' : v.toFixed(1)), f2 = (v) => (v == null ? '-' : v.toFixed(2));
      log('face: ' + frames + ' frames, pitch ' + f1(median(tickPitch)) + ' (max ' + f1(Math.max(...tickPitch)) + ', usual ' + f1(usualPitch) +
        '), iris ' + f2(median(tickIris)) + ' (max ' + f2(Math.max(...tickIris)) + ', usual ' + f2(usualIris) + '), EAR ' + f2(median(tickEar)) +
        ' (min ' + f2(Math.min(...tickEar)) + '), usable ' + Math.round(100 * usableShare) + '%, blinks ' + blinkAll + ' detected, today ' + (today().blinks || 0) + ' counted');
    }
    frames = usableFrames = 0; tickPitch = []; tickIris = []; tickEar = []; blinkAll = 0;
    eyes = eyeChoice();
    if (!screenOn || !running()) return;
    const d = today();
    d.track += dt;
    if (!noFace()) d.blinkSec = (d.blinkSec || 0) + dt * usableShare;
    saveStats();
  }, TICK_MS);

  // Every time the smile appears (fsaux.m), except the no-face smile.
  window.__fsaux.smileShown = () => {
    if (showing) return;
    lastSmileAt = Date.now();
    afterSmile = true;
  };
  window.__fsaux.screenOn = (on) => { screenOn = on; lastTick = Date.now(); };
  window.__fsaux.screenTime = ({ first, days }) => {
    for (const [k, sec] of Object.entries(days)) {
      // The log only reaches back about a week; keep what older runs saw.
      const d = dayEntry(k);
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
  const MIN_BLINK_SEC = 300;  // under 5 minutes of usable face time says nothing
  function blinkRate(d) {
    if (!d || !d.blinkSec || d.blinkSec < MIN_BLINK_SEC) return null;
    return (d.blinks || 0) / (d.blinkSec / 60);
  }

  // Texts in the app's languages (settings.global.languageCode); English
  // for anything else.
  const lang = () => {
    try { return JSON.parse(localStorage.getItem('settings')).global.languageCode || 'en'; } catch (e) { return 'en'; }
  };
  const LOCALES = { en: 'en-US', de: 'de-DE', it: 'it-IT', es: 'es-ES', ru: 'ru-RU', ja: 'ja-JP', zh: 'zh-CN' };
  const locale = () => LOCALES[lang()] || 'en-US';
  const T = {
    stats: { en: 'Statistics', de: 'Statistik', it: 'Statistiche', es: 'Estadísticas', ru: 'Статистика', ja: '統計', zh: '统计' },
    autostart: { en: 'Run at startup', de: 'Beim Systemstart ausführen', it: "Avvia all'accensione", es: 'Abrir al iniciar sesión', ru: 'Запускать при входе в систему', ja: 'ログイン時に起動', zh: '登录时启动' },
    approval: {
      en: 'allow eyeREST in System Settings → General → Login Items',
      de: 'eyeREST unter Systemeinstellungen → Allgemein → Anmeldeobjekte erlauben',
      it: 'consenti eyeREST in Impostazioni di Sistema → Generali → Elementi login',
      es: 'permite eyeREST en Ajustes del Sistema → General → Ítems de inicio',
      ru: 'разрешите eyeREST в Системных настройках → Основные → Объекты входа',
      ja: 'システム設定 → 一般 → ログイン項目 で eyeREST を許可してください',
      zh: '请在 系统设置 → 通用 → 登录项 中允许 eyeREST',
    },
    covTitle: { en: 'Monitoring time', de: 'Überwachungszeit', it: 'Tempo di monitoraggio', es: 'Tiempo de monitorización', ru: 'Время отслеживания', ja: 'モニタリング時間', zh: '监测时间' },
    covSub: {
      en: 'share of screen time with eyeREST monitoring',
      de: 'Anteil der Bildschirmzeit mit eyeREST-Überwachung',
      it: 'quota del tempo davanti allo schermo con il monitoraggio di eyeREST',
      es: 'parte del tiempo de pantalla con eyeREST monitorizando',
      ru: 'доля экранного времени, когда eyeREST вёл отслеживание',
      ja: '画面使用時間のうち eyeREST がモニタリングしていた割合',
      zh: '屏幕使用时间中 eyeREST 监测的比例',
    },
    blinkTitle: { en: 'Blinks per minute', de: 'Blinzler pro Minute', it: 'Battiti di ciglia al minuto', es: 'Parpadeos por minuto', ru: 'Морганий в минуту', ja: '1分あたりのまばたき', zh: '每分钟眨眼次数' },
    blinkSub: {
      en: "spontaneous blinks while your face is found and you look at the screen; blinks right after a smile don't count; more is better",
      de: 'spontane Blinzler, solange Ihr Gesicht erkannt wird und Sie auf den Bildschirm schauen; Blinzler direkt nach einem Smiley zählen nicht; mehr ist besser',
      it: 'battiti di ciglia spontanei mentre il viso è rilevato e guardi lo schermo; quelli subito dopo uno smile non contano; più è meglio',
      es: 'parpadeos espontáneos mientras se detecta tu cara y miras la pantalla; los que siguen a una carita no cuentan; más es mejor',
      ru: 'спонтанные моргания, пока лицо в кадре и вы смотрите на экран; моргания сразу после смайлика не считаются; чем больше, тем лучше',
      ja: '顔が検出され画面を見ているときの自然なまばたき。スマイル表示直後のまばたきは数えません。多いほど良好です',
      zh: '检测到面部且注视屏幕时的自然眨眼；笑脸出现后紧接着的眨眼不计入；越多越好',
    },
    noData: { en: 'no data', de: 'keine Daten', it: 'nessun dato', es: 'sin datos', ru: 'нет данных', ja: 'データなし', zh: '无数据' },
    of: { en: 'of', de: 'von', it: 'su', es: 'de', ru: 'из', ja: '/', zh: '/' },
    blinksIn: { en: 'blinks in', de: 'Blinzler in', it: 'battiti in', es: 'parpadeos en', ru: 'морганий за', ja: '回 /', zh: '次 /' },
    perMin: { en: '/min', de: '/min', it: '/min', es: '/min', ru: '/мин', ja: '/分', zh: '/分钟' },
    last7: { en: 'Last 7 days', de: 'Letzte 7 Tage', it: 'Ultimi 7 giorni', es: 'Últimos 7 días', ru: 'Последние 7 дней', ja: '直近7日間', zh: '最近7天' },
    prev7: { en: 'previous 7 days', de: 'vorherige 7 Tage', it: '7 giorni precedenti', es: '7 días anteriores', ru: 'предыдущие 7 дней', ja: 'その前の7日間', zh: '之前7天' },
    less: { en: 'Less', de: 'Weniger', it: 'Meno', es: 'Menos', ru: 'Меньше', ja: '少', zh: '少' },
    more: { en: 'More', de: 'Mehr', it: 'Più', es: 'Más', ru: 'Больше', ja: '多', zh: '多' },
    h: { en: 'h', de: 'h', it: 'h', es: 'h', ru: 'ч', ja: '時間', zh: '小时' },
    min: { en: 'min', de: 'min', it: 'min', es: 'min', ru: 'мин', ja: '分', zh: '分钟' },
  };
  const t = (k) => T[k][lang()] || T[k].en;
  const fmtDur = (sec) => {
    const m = Math.round(sec / 60);
    return m < 60 ? m + ' ' + t('min') : Math.floor(m / 60) + ' ' + t('h') + ' ' + pad(m % 60) + ' ' + t('min');
  };
  const fmtDate = (d) => d.toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  // GitHub's light-theme greens, and a blue ramp for blinks (more = better).
  const GREENS = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'];
  const BLUES = ['#ebedf0', '#c6dbef', '#6baed6', '#2171b5', '#08306b'];
  const WEEKS = 53;
  const CELL = 10, GAP = 3;

  // Level 1..4 for a value: fixed quarters for percentages, quartiles of the
  // non-empty days for blink rates (as GitHub does for contributions).
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
    // Monitoring time and blinks are only known from the first recorded day.
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
    // Row labels Mon/Wed/Fri: the first column starts on a Monday.
    [0, 2, 4].forEach((r) => {
      const d = new Date(start); d.setDate(start.getDate() + r);
      text(0, 16 + r * (CELL + GAP) + 8, d.toLocaleDateString(locale(), { weekday: 'short' }));
    });
    let lastMonth = -1;
    days.forEach((x, i) => {
      const col = Math.floor(i / 7), row = i % 7;
      if (row === 0 && x.date.getMonth() !== lastMonth && col < WEEKS - 2) {
        lastMonth = x.date.getMonth();
        text(30 + col * (CELL + GAP), 9, x.date.toLocaleDateString(locale(), { month: 'short' }));
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
    let track = 0, screen = 0, blinkSec = 0, blinks = 0;
    for (let i = fromDaysAgo; i > toDaysAgo; i--) {
      const d = new Date(); d.setDate(d.getDate() - i + 1);
      const k = dayKey(d), x = stats.days[k];
      if (!x || k < stats.since) continue;  // before recording started
      track += x.track; screen += x.screen; blinkSec += x.blinkSec || 0; blinks += x.blinks || 0;
    }
    return { cov: screen >= 60 ? Math.min(100, (100 * track) / screen) : null, rate: blinkSec >= MIN_BLINK_SEC ? blinks / (blinkSec / 60) : null };
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
    const rate = (v) => (v == null ? '—' : v.toFixed(1) + t('perMin'));
    body.append(
      section(t('covTitle'), t('covSub'),
        grid(coverage, GREENS, 100, (v, d) => Math.round(v) + ' % (' + fmtDur(d.track) + ' ' + t('of') + ' ' + fmtDur(d.screen) + ')'),
        t('last7') + ': ' + pct(now7.cov) + '  ·  ' + t('prev7') + ': ' + pct(prev7.cov)),
      section(t('blinkTitle'), t('blinkSub'),
        grid(blinkRate, BLUES, 0, (v, d) => v.toFixed(1) + t('perMin') + ' (' + (d.blinks || 0) + ' ' + t('blinksIn') + ' ' + fmtDur(d.blinkSec) + ')'),
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

  // Reopening the window shows the main view, not the statistics.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && panel && !panel.hidden) { panel.hidden = true; hideTip(); }
  });

  // The footer ("// eyeREST: Comfort Vision" ... bot icon) gets a button.
  function addStatsButton() {
    const old = document.getElementById('fsaux-stats-btn');
    if (old) { if (old.textContent !== t('stats')) old.textContent = t('stats'); return; }
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
    if (box && !update && box.querySelector('span span').textContent === t('autostart')) return;
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
