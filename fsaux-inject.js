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
// 6. A "4s" choice in the pop-up timer (the app offers 3/5/10/15 s).
// 7. "Count incomplete blinks" checkbox below the eye choice; blinks detected
//    here are also passed on to the app's smile timer (section 4).
// 8. "Any" eye choice; detection quality line, and a note in the smile
//    window when it stays poor (second script below, for that window).
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
  // Blink: eye aspect ratio (EAR, eyelid gap / eye width) per eye, relative
  // to its usual openness (slow average over open frames). Which eye counts
  // follows the eye choice: L or R that eye, LR both together (average, as
  // in the app), Any (added by the patch) whichever closes further, best
  // when the camera sees one eye much more obliquely. A blink: below
  // BLINK_CLOSED, open again (above BLINK_OPEN) within BLINK_MAX_MS. Full if
  // it got below BLINK_FULL, else incomplete. Shallower eyelid movements are
  // not counted: they blend into slow eyelid movements (reading, gaze).
  // Calibrated with 2 x 20 counted blinks (found 20 and 21, 2 false in 70 s
  // of reading/holding the eyes open). As in the app, L is MediaPipe's left
  // eye (points 362...), R its right eye (points 33...).
  // Looking down: head pitch (forehead vs chin in 3D) in degrees, relative to
  // the usual pitch for this camera (30th percentile of the last 5 minutes,
  // so a camera above the screen doesn't count as "down" and long writing
  // sessions don't shift it), or the irises clearly low in the eyes.
  // A frame counts (time and blinks) only while you are not looking down, and
  // not just after a smile (the first blink after it and any within
  // SMILE_HOLD are deliberate) or after the face was found again.
  const BLINK_CLOSED = 0.55, BLINK_OPEN = 0.8, BLINK_MAX_MS = 800;
  const EYE_ANY = 'ANY';
  const BLINK_FULL = 0.47;      // closed to under this share of usual openness = full blink, else incomplete
  const PITCH_DOWN = 12;        // degrees below the usual head pitch (writing: ~25, keyboard: ~15)
  const IRIS_DOWN = 0.12;       // iris drop below usual, in eye widths
  const GAZE_WINDOW = 300;      // seconds of history for the usual pitch/iris
  const DOWN_HOLD = 1500;       // ms after looking down that still don't count
  const SMILE_HOLD = 3000;      // ms after a smile appears that don't count
  const GAP_HOLD = 1000;        // ms after a pause in frames (face just found again)
  const R_EYE = [33, 160, 158, 133, 153, 144], L_EYE = [362, 385, 387, 263, 373, 380];
  let lastFrameAt = 0, lastDownAt = 0, lastSmileAt = 0, afterSmile = false, resumeAt = 0;
  let baseL = 0, baseR = 0, closedSince = 0, closedMin = 1, blinkAll = 0, blinkFull = 0, passed = 0;
  function eyeChoice() {
    try { return JSON.parse(localStorage.getItem('settings')).config.eyeStatus || 'LR'; } catch (e) { return 'LR'; }
  }
  let eyes = eyeChoice();
  let gazeHistory = [], gazeCamera = null, secStart = 0, secPitch = 0, secIris = 0, secN = 0;
  let usualPitch = null, usualIris = null;
  let frames = 0, usableFrames = 0, tickPitch = [], tickIris = [], tickEar = [];  // per tick, for the log

  const P = (lm, i) => ({ x: lm[i].x * videoW, y: lm[i].y * videoH, z: lm[i].z * videoW });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  // The eyelid gap is measured in 3D (MediaPipe's z), so a camera looking
  // from below or above (lid angle) foreshortens it less than in the image.
  const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  function ear(lm, idx) {
    const [p1, p2, p3, p4, p5, p6] = idx.map((i) => P(lm, i));
    return (dist3(p2, p6) + dist3(p3, p5)) / (2 * dist3(p1, p4));
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

  // Detection quality, from geometry only (no per-person calibration): the
  // open eyelid gap in camera pixels (distance, camera angle and resolution
  // together; the face model places points to within ~1-2 px, so an
  // incomplete blink in a small gap barely shows) and the head angle to the
  // camera. Medians over the last minute. Shared with the smile window
  // through localStorage.
  const QUALITY_KEY = 'fsaux-quality';
  const GAP_GOOD = 9, GAP_FAIR = 6, ANGLE_GOOD = 15, ANGLE_FAIR = 25;
  let qGap = [], qAngle = [], qHistory = [], quality = null;
  function noteQuality(lm, pitch) {
    const gap = (idx) => { const [p1, p2, p3, p4, p5, p6] = idx.map((i) => P(lm, i)); return (dist(p2, p6) + dist(p3, p5)) / 2; };
    const a = P(lm, 234), b = P(lm, 454);  // face edges, for the turn to the side
    const yaw = (Math.atan2(b.z - a.z, b.x - a.x) * 180) / Math.PI;
    qGap.push(Math.max(gap(L_EYE), gap(R_EYE)));
    qAngle.push(Math.max(Math.abs(yaw), Math.abs(pitch)));
  }
  // Away from the camera (or just sitting down / getting up) says nothing
  // about the camera angle: start the minute over and hide the smile note.
  window.__fsaux.faceLost = () => {
    qGap = []; qAngle = []; qHistory = [];
    if (quality) log('detection quality: face lost, measuring again');
    quality = null;
    try { localStorage.setItem(QUALITY_KEY, JSON.stringify({ level: null, poorFor: false, at: Date.now() })); } catch (e) {}
    const line = document.getElementById('fsaux-quality');
    if (line) line.remove();
  };
  function updateQuality() {
    if (qGap.length >= 20) qHistory.push([median(qGap), median(qAngle)]);
    qGap = []; qAngle = [];
    if (qHistory.length > 6) qHistory.shift();
    if (!qHistory.length || noFace()) return;
    const gap = median(qHistory.map((q) => q[0])), angle = median(qHistory.map((q) => q[1]));
    const level = gap < GAP_FAIR || angle > ANGLE_FAIR ? 'poor' : gap < GAP_GOOD || angle > ANGLE_GOOD ? 'fair' : 'good';
    const changed = !quality || quality.level !== level;
    quality = { level, gap: +gap.toFixed(1), angle: Math.round(angle), at: Date.now() };
    // The smile window shows its note only after a minute of poor quality.
    // poorFor: a whole minute of poor quality since the face was last found.
    const poorFor = qHistory.length >= 6 && qHistory.every((q) => q[0] < GAP_FAIR || q[1] > ANGLE_FAIR);
    try { localStorage.setItem(QUALITY_KEY, JSON.stringify({ ...quality, poorFor })); } catch (e) {}
    if (changed) log('detection quality ' + level + ' (eyelid gap ' + quality.gap + ' px, head angle ' + quality.angle + ' deg)');
    addQualityLine();
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
    const rL = eL / baseL, rR = eR / baseR;
    const ratio = eyes === 'L' ? rL : eyes === 'R' ? rR : eyes === EYE_ANY ? Math.min(rL, rR) : (rL + rR) / 2;
    const closed = ratio < BLINK_CLOSED;
    const open = ratio > BLINK_OPEN;
    if (rL > 0.85 && rR > 0.85) noteQuality(lm, pitch);
    if (closed) {
      if (!closedSince) { closedSince = now; closedMin = 1; }
      closedMin = Math.min(closedMin, ratio);
      return;
    }
    if (closedSince) closedMin = Math.min(closedMin, ratio);
    if (rL > 0.85 && rR > 0.85) {
      // Usual openness follows slowly (about 2 s), from clearly open frames only.
      baseL += (eL - baseL) * 0.05; baseR += (eR - baseR) * 0.05;
    }
    if (!closedSince || !open) return;
    const ms = now - closedSince;
    closedSince = 0;
    if (ms > BLINK_MAX_MS) return;  // eyes closed for a while, not a blink
    const full = closedMin < BLINK_FULL;
    blinkAll++;
    if (full) blinkFull++;
    passBlinkToApp(now, full);
    if (afterSmile) { afterSmile = false; return; }  // the blink that answers a smile
    if (!usable || !running()) return;
    const d = today();
    d.blinks = (d.blinks || 0) + 1;
    if (full) d.fullBlinks = (d.fullBlinks || 0) + 1;
  }

  // The app decides when the smile appears from its own blink rule, on
  // MediaPipe's eyeBlink blendshape scores, which it reads through
  // Array#filter (LR) / #find (L, R) once per frame, right after the face
  // points. Blinks detected here are passed on to it by handing it those
  // scores as 1 (fully closed) on the next frame, which it counts as a blink,
  // so its smile timer starts over.
  // - "Count incomplete blinks" on (default): the app's rule keeps working;
  //   it is replayed here, and blinks it missed (none counted within
  //   APP_BLINK_WINDOW) are passed on.
  // - Off: only full blinks count. Between them the app gets a neutral low
  //   score (APP_NEUTRAL; a 0 would be skipped, and with only 1s its average
  //   would be 1 and no 1 would stand out), and only full blinks detected
  //   here are passed on. The same goes for the Any eye choice, for which the
  //   app's own lookup finds no eye.
  const APP_JUMP = 0.2, APP_BLINK_WINDOW = 700, APP_NEUTRAL = 0.01;
  const INCOMPLETE_KEY = 'fsaux-count-incomplete';
  const countIncomplete = () => { try { return localStorage.getItem(INCOMPLETE_KEY) !== '0'; } catch (e) { return true; } };
  let appValues = [], appBlinkAt = 0, passPending = false, fullOnly = !countIncomplete();
  function passBlinkToApp(now, full) {
    if (fullOnly ? full : eyes === EYE_ANY || now - appBlinkAt > APP_BLINK_WINDOW) passPending = true;
  }
  const isBlendshapes = (a) => a.length > 40 && a[0] && a[0].categoryName === '_neutral';
  function appScore(cats) {
    let l = 0, r = 0;
    for (const c of cats) {
      if (c.categoryName === 'eyeBlinkLeft') l = c.score;
      else if (c.categoryName === 'eyeBlinkRight') r = c.score;
    }
    return eyes === 'L' ? l : eyes === 'R' ? r : eyes === EYE_ANY ? 0 : (l + r) / 2;
  }
  function replayAppRule(u, now) {
    if (!u) return;
    appValues.push(u);
    const mean = appValues.reduce((a, b) => a + b, 0) / appValues.length;
    if (u > mean + APP_JUMP) { appValues = []; appBlinkAt = now; }
  }
  const withScore = (score) => (c) => (c && /^eyeBlink/.test(c.categoryName) ? { ...c, score } : c);
  const handTo = (result, score) => (Array.isArray(result) ? result.map(withScore(score)) : withScore(score)(result));
  for (const name of ['filter', 'find']) {
    const orig = Array.prototype[name];
    Array.prototype[name] = function () {
      const result = orig.apply(this, arguments);
      if (!isBlendshapes(this)) return result;
      const now = Date.now();
      if (passPending && (fullOnly || eyes === EYE_ANY || now - appBlinkAt > APP_BLINK_WINDOW)) {
        passPending = false;
        passed++;
        replayAppRule(1, now);
        // With Any the app's own lookup finds no eye; hand it one.
        if (result === undefined) return { index: 9, categoryName: 'eyeBlinkLeft', displayName: '', score: 1 };
        return handTo(result, 1);
      }
      passPending = false;
      if (result === undefined && eyes === EYE_ANY) return { index: 9, categoryName: 'eyeBlinkLeft', displayName: '', score: APP_NEUTRAL };
      if (fullOnly || eyes === EYE_ANY) return handTo(result, APP_NEUTRAL);
      replayAppRule(appScore(this), now);
      return result;
    };
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
        ' (min ' + f2(Math.min(...tickEar)) + '), usable ' + Math.round(100 * usableShare) + '%, blinks ' + blinkAll + ' detected (' + blinkFull + ' full, ' + passed + ' passed to app), today ' + (today().blinks || 0) + ' counted');
    }
    frames = usableFrames = 0; tickPitch = []; tickIris = []; tickEar = []; blinkAll = 0; blinkFull = 0; passed = 0;
    eyes = eyeChoice();
    fullOnly = !countIncomplete();
    updateQuality();
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
  // Share of incomplete blinks, from days that record full blinks.
  function incompleteShare(blinks, full) {
    return blinks > 0 && full != null ? Math.round((100 * (blinks - full)) / blinks) : null;
  }
  const incompleteText = (p) => (p == null ? '' : ', ' + t('incomplete').replace('{p}', p));
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
      en: "spontaneous blinks while your face is found and you look at the screen; blinks right after a smile don't count; more is better. Incomplete: the eyelid closed less than 60 %",
      de: 'spontane Blinzler, solange Ihr Gesicht erkannt wird und Sie auf den Bildschirm schauen; Blinzler direkt nach einem Smiley zählen nicht; mehr ist besser. Unvollständig: Lid weniger als 60 % geschlossen',
      it: 'battiti di ciglia spontanei mentre il viso è rilevato e guardi lo schermo; quelli subito dopo uno smile non contano; più è meglio. Incompleti: palpebra chiusa meno del 60 %',
      es: 'parpadeos espontáneos mientras se detecta tu cara y miras la pantalla; los que siguen a una carita no cuentan; más es mejor. Incompletos: párpado cerrado menos del 60 %',
      ru: 'спонтанные моргания, пока лицо в кадре и вы смотрите на экран; моргания сразу после смайлика не считаются; чем больше, тем лучше. Неполные: веко закрылось меньше чем на 60 %',
      ja: '顔が検出され画面を見ているときの自然なまばたき。スマイル表示直後のまばたきは数えません。多いほど良好です。不完全: まぶたの閉じ方が60%未満',
      zh: '检测到面部且注视屏幕时的自然眨眼；笑脸出现后紧接着的眨眼不计入；越多越好。不完全：眼睑闭合不足60%',
    },
    noData: { en: 'no data', de: 'keine Daten', it: 'nessun dato', es: 'sin datos', ru: 'нет данных', ja: 'データなし', zh: '无数据' },
    of: { en: 'of', de: 'von', it: 'su', es: 'de', ru: 'из', ja: '/', zh: '/' },
    blinksIn: { en: 'blinks in', de: 'Blinzler in', it: 'battiti in', es: 'parpadeos en', ru: 'морганий за', ja: '回 /', zh: '次 /' },
    perMin: { en: '/min', de: '/min', it: '/min', es: '/min', ru: '/мин', ja: '/分', zh: '/分钟' },
    last7: { en: 'Last 7 days', de: 'Letzte 7 Tage', it: 'Ultimi 7 giorni', es: 'Últimos 7 días', ru: 'Последние 7 дней', ja: '直近7日間', zh: '最近7天' },
    prev7: { en: 'previous 7 days', de: 'vorherige 7 Tage', it: '7 giorni precedenti', es: '7 días anteriores', ru: 'предыдущие 7 дней', ja: 'その前の7日間', zh: '之前7天' },
    less: { en: 'Less', de: 'Weniger', it: 'Meno', es: 'Menos', ru: 'Меньше', ja: '少', zh: '少' },
    more: { en: 'More', de: 'Mehr', it: 'Più', es: 'Más', ru: 'Больше', ja: '多', zh: '多' },
    eyeAny: { en: 'Any', de: 'Beliebig', it: 'Uno', es: 'Uno', ru: 'Любой', ja: '片方', zh: '任一' },
    eyeAnyTip: {
      en: 'A blink counts when either eye closes. Best when the camera sees you at an angle.',
      de: 'Ein Blinzler zählt, wenn eines der Augen schließt. Am besten, wenn die Kamera Sie schräg sieht.',
      it: "Un battito conta quando si chiude uno qualsiasi dei due occhi. Ideale se la fotocamera ti vede di lato.",
      es: 'Un parpadeo cuenta cuando se cierra cualquiera de los dos ojos. Ideal si la cámara te ve de lado.',
      ru: 'Моргание засчитывается, когда закрывается любой глаз. Лучше всего, если камера видит вас под углом.',
      ja: 'どちらかの目が閉じればまばたきとして数えます。カメラが斜めから見ている場合に最適です。',
      zh: '任一只眼睛闭合即计为眨眼。适合摄像头从侧面看到您的情况。',
    },
    quality: { en: 'Detection', de: 'Erkennung', it: 'Rilevamento', es: 'Detección', ru: 'Распознавание', ja: '検出', zh: '检测' },
    good: { en: 'good', de: 'gut', it: 'buono', es: 'buena', ru: 'хорошее', ja: '良好', zh: '良好' },
    fair: { en: 'fair', de: 'mittel', it: 'medio', es: 'regular', ru: 'среднее', ja: '普通', zh: '一般' },
    poor: { en: 'poor', de: 'schlecht', it: 'scarso', es: 'mala', ru: 'плохое', ja: '不良', zh: '较差' },
    qualityHint: {
      en: 'face the camera more directly or move closer',
      de: 'Kamera gerader auf das Gesicht richten oder näher rücken',
      it: 'mettiti più di fronte alla fotocamera o avvicinati',
      es: 'colócate más de frente a la cámara o acércate',
      ru: 'расположите камеру прямо напротив лица или сядьте ближе',
      ja: 'カメラに顔を正面に向けるか、近づいてください',
      zh: '请正对摄像头或靠近一些',
    },
    countIncomplete: { en: 'Count incomplete blinks', de: 'Unvollständige Blinzler zählen', it: 'Conta i battiti di ciglia incompleti', es: 'Contar parpadeos incompletos', ru: 'Учитывать неполные моргания', ja: '不完全なまばたきも数える', zh: '计入不完全眨眼' },
    countIncompleteOff: {
      en: 'only full blinks dismiss the smile',
      de: 'nur vollständige Blinzler beenden den Smiley',
      it: 'solo i battiti completi chiudono lo smile',
      es: 'solo los parpadeos completos quitan la carita',
      ru: 'смайлик убирают только полные моргания',
      ja: '完全なまばたきだけがスマイルを消します',
      zh: '只有完整眨眼才能关闭笑脸',
    },
    incomplete: { en: '{p}% incomplete', de: '{p} % unvollständig', it: '{p}% incompleti', es: '{p}% incompletos', ru: '{p}% неполных', ja: '不完全 {p}%', zh: '不完全 {p}%' },
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
    let track = 0, screen = 0, blinkSec = 0, blinks = 0, splitBlinks = 0, full = 0;
    for (let i = fromDaysAgo; i > toDaysAgo; i--) {
      const d = new Date(); d.setDate(d.getDate() - i + 1);
      const k = dayKey(d), x = stats.days[k];
      if (!x || k < stats.since) continue;  // before recording started
      // Only days that show a value themselves (e.g. not under 5 minutes).
      if (coverage(x) != null) { track += x.track; screen += x.screen; }
      if (blinkRate(x) != null) { blinkSec += x.blinkSec; blinks += x.blinks || 0; }
      if (blinkRate(x) != null && x.fullBlinks != null) { splitBlinks += x.blinks || 0; full += x.fullBlinks; }
    }
    return { cov: screen >= 60 ? Math.min(100, (100 * track) / screen) : null, rate: blinkSec >= MIN_BLINK_SEC ? blinks / (blinkSec / 60) : null,
      incomplete: incompleteShare(splitBlinks, splitBlinks ? full : null) };
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
    const rateSplit = (s) => rate(s.rate) + (s.rate != null && s.incomplete != null ? ' (' + t('incomplete').replace('{p}', s.incomplete) + ')' : '');
    body.append(
      section(t('covTitle'), t('covSub'),
        grid(coverage, GREENS, 100, (v, d) => Math.round(v) + ' % (' + fmtDur(d.track) + ' ' + t('of') + ' ' + fmtDur(d.screen) + ')'),
        t('last7') + ': ' + pct(now7.cov) + '  ·  ' + t('prev7') + ': ' + pct(prev7.cov)),
      section(t('blinkTitle'), t('blinkSub'),
        grid(blinkRate, BLUES, 0, (v, d) => v.toFixed(1) + t('perMin') + ' (' + (d.blinks || 0) + ' ' + t('blinksIn') + ' ' + fmtDur(d.blinkSec) +
          incompleteText(incompleteShare(d.blinks || 0, d.fullBlinks)) + ')'),
        t('last7') + ': ' + rateSplit(now7) + '  ·  ' + t('prev7') + ': ' + rateSplit(prev7)),
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

  // ---------- 8. "Any" eye choice and detection quality ----------
  // A copy of the LR button; choosing it saves eyeStatus = 'ANY' and reloads
  // (the app reads its settings at start). The app's own blink rule finds no
  // eye for it, so only blinks detected here reach it (see passBlinkToApp).
  function addAnyButton() {
    const lr = document.querySelector('[data-scope="radio-group"][data-part="item"] input[type="radio"][value="LR"]');
    const itemLR = lr && lr.closest('[data-part="item"]');
    if (!itemLR) return;
    let item = document.getElementById('fsaux-eye-any');
    if (!item) {
      item = itemLR.cloneNode(true);
      item.id = 'fsaux-eye-any';
      item.removeAttribute('for');
      item.querySelector('input').remove();
      for (const el of item.querySelectorAll('[id]')) el.removeAttribute('id');
      item.style.cursor = 'pointer';
      // The app's buttons have a fixed width; this label can be longer.
      item.style.width = 'auto';
      item.style.minWidth = getComputedStyle(itemLR).width;
      item.style.paddingInline = '12px';
      item.addEventListener('click', (e) => {
        e.preventDefault();
        if (eyeChoice() === EYE_ANY) return;
        try {
          const st = JSON.parse(localStorage.getItem('settings'));
          st.config.eyeStatus = EYE_ANY;
          localStorage.setItem('settings', JSON.stringify(st));
        } catch (err) { log('Any eye choice failed: ' + err); return; }
        log('eye choice -> Any, reloading');
        location.reload();
      });
      itemLR.after(item);
    }
    const text = item.querySelector('[data-part="item-text"]');
    if (text && text.textContent !== t('eyeAny')) text.textContent = t('eyeAny');
    if (item.title !== t('eyeAnyTip')) item.title = t('eyeAnyTip');
    const state = eyeChoice() === EYE_ANY ? 'checked' : 'unchecked';
    for (const el of [item, ...item.querySelectorAll('[data-state]')]) {
      if (el.getAttribute('data-state') !== state) el.setAttribute('data-state', state);
    }
  }
  new MutationObserver(addAnyButton).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-state'] });

  // "Detection: ● good" below the "count incomplete blinks" checkbox.
  const QUALITY_COLORS = { good: '#2da44e', fair: '#d4a72c', poor: '#cf222e' };
  function addQualityLine() {
    const box = document.getElementById('fsaux-incomplete');
    if (!box || !quality || !running()) { const old = document.getElementById('fsaux-quality'); if (old && !running()) old.remove(); return; }
    let line = document.getElementById('fsaux-quality');
    if (!line) {
      line = document.createElement('div');
      line.id = 'fsaux-quality';
      line.className = 'text textStyle_sm';
      line.style.cssText = 'margin-top:10px;font-size:13px';
      box.after(line);
    }
    const want = '<span style="color:' + QUALITY_COLORS[quality.level] + '">●</span> ' + t('quality') + ': ' + t(quality.level) +
      (quality.level === 'good' ? '' : '<div style="color:#57606a;font-size:12px">' + t('qualityHint') + '</div>');
    if (line.innerHTML !== want) line.innerHTML = want;
    line.title = quality.gap + ' px, ' + quality.angle + '°';
  }
  new MutationObserver(() => { if (quality && !document.getElementById('fsaux-quality')) addQualityLine(); }).observe(document.documentElement, { childList: true, subtree: true });

  // ---------- 7. "count incomplete blinks" checkbox ----------
  // Below the eye choice (L / R / LR). See passBlinkToApp() above.
  function addIncompleteBox() {
    const lr = document.querySelector('[data-scope="radio-group"][data-part="item"] input[type="radio"][value="LR"]');
    const group = lr && lr.closest('[data-part="root"]');
    if (!group || !group.parentElement) return;
    let box = document.getElementById('fsaux-incomplete');
    if (!box) {
      box = document.createElement('label');
      box.id = 'fsaux-incomplete';
      box.className = 'text textStyle_sm';
      box.style.cssText = 'display:flex;flex-direction:column;gap:2px;margin-top:12px;cursor:pointer';
      box.innerHTML = '<span style="display:flex;align-items:center;gap:6px"><input type="checkbox" style="width:14px;height:14px;cursor:pointer"><span></span></span><span style="color:#57606a;font-size:12px"></span>';
      box.querySelector('input').addEventListener('change', (e) => {
        try { localStorage.setItem(INCOMPLETE_KEY, e.target.checked ? '1' : '0'); } catch (err) {}
        fullOnly = !e.target.checked;
        log('count incomplete blinks: ' + e.target.checked);
        addIncompleteBox();
      });
      group.after(box);
    }
    const on = countIncomplete();
    const input = box.querySelector('input');
    if (input.checked !== on) input.checked = on;
    const label = box.querySelector('span span'), hint = box.lastChild;
    if (label.textContent !== t('countIncomplete')) label.textContent = t('countIncomplete');
    const h = on ? '' : t('countIncompleteOff');
    if (hint.textContent !== h) hint.textContent = h;
  }
  new MutationObserver(addIncompleteBox).observe(document.documentElement, { childList: true, subtree: true });

  // ---------- 6. 4 s pop-up timer ----------
  // The app's timer buttons come from a fixed list that can't be extended,
  // but the setting takes any number of seconds. The 4s button is a copy of
  // the 3s one; choosing it saves timerDuration = 4 and reloads the page, as
  // the app only reads its settings at start (monitoring restarts by itself).
  const EXTRA_TIMER = 4;
  function timerSetting() {
    try { return JSON.parse(localStorage.getItem('settings')).config.timerDuration; } catch (e) { return null; }
  }
  function addTimerButton() {
    const three = document.querySelector('[data-scope="radio-group"][data-part="item"] input[type="radio"][value="3"]');
    const item3 = three && three.closest('[data-part="item"]');
    if (!item3) return;
    let item = document.getElementById('fsaux-timer-4');
    if (!item) {
      item = item3.cloneNode(true);
      item.id = 'fsaux-timer-4';
      item.removeAttribute('for');
      item.querySelector('input').remove();
      for (const el of item.querySelectorAll('[id]')) el.removeAttribute('id');
      item.style.cursor = 'pointer';
      item.addEventListener('click', (e) => {
        e.preventDefault();
        if (timerSetting() === EXTRA_TIMER) return;
        try {
          const st = JSON.parse(localStorage.getItem('settings'));
          st.config.timerDuration = EXTRA_TIMER;
          localStorage.setItem('settings', JSON.stringify(st));
        } catch (err) { log('4s timer failed: ' + err); return; }
        log('timer -> 4 s, reloading');
        location.reload();
      });
      item3.after(item);
    }
    // Same wording as the app's own button in the current language (3s, 3с, 3秒…).
    const text3 = item3.querySelector('[data-part="item-text"]'), text = item.querySelector('[data-part="item-text"]');
    const label = text3 ? text3.textContent.replace('3', String(EXTRA_TIMER)) : EXTRA_TIMER + 's';
    if (text && text.textContent !== label) text.textContent = label;
    const state = timerSetting() === EXTRA_TIMER ? 'checked' : 'unchecked';
    for (const el of [item, ...item.querySelectorAll('[data-state]')]) {
      if (el.getAttribute('data-state') !== state) el.setAttribute('data-state', state);
    }
  }
  new MutationObserver(addTimerButton).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-state'] });

  log('inject ready');
})();

// Smile window (/src/windows/blink/index.html): a short note at the bottom
// while the main window reports poor detection for a minute (localStorage
// 'fsaux-quality', written by the main window; the 'storage' event fires
// here when it changes).
(() => {
  if (!/\/windows\/blink\//.test(location.pathname)) return;
  const NOTE = {
    en: 'Adjust the camera angle', de: 'Kamerawinkel anpassen', it: "Regola l'angolo della fotocamera", es: 'Ajusta el ángulo de la cámara',
    ru: 'Поправьте угол камеры', ja: 'カメラの角度を調整してください', zh: '请调整摄像头角度',
  };
  const STALE_MS = 2 * 60 * 1000;
  function update() {
    let q = null, lang = 'en';
    try { q = JSON.parse(localStorage.getItem('fsaux-quality')); } catch (e) {}
    try { lang = JSON.parse(localStorage.getItem('settings')).global.languageCode || 'en'; } catch (e) {}
    const show = !!(q && q.poorFor && Date.now() - q.at < STALE_MS);
    let note = document.getElementById('fsaux-note');
    if (!show) { if (note) note.remove(); return; }
    if (!document.body) return;
    if (!note) {
      note = document.createElement('div');
      note.id = 'fsaux-note';
      note.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:10;text-align:center;font:500 10px/1.3 -apple-system,sans-serif;' +
        'color:rgba(60,60,60,0.75);background:transparent;border:1px solid rgba(0,0,0,0.18);border-radius:6px;padding:2px 6px;pointer-events:none';
      document.body.appendChild(note);
    }
    note.textContent = NOTE[lang] || NOTE.en;
  }
  window.addEventListener('storage', (e) => { if (!e.key || e.key === 'fsaux-quality' || e.key === 'settings') update(); });
  document.addEventListener('visibilitychange', update);
  document.addEventListener('DOMContentLoaded', update);
})();
