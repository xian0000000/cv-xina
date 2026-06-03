/**
 * tracker.js
 * 
 * Smart visitor tracker dengan dual-mode:
 *  - Mode LIVE  : kirim langsung ke backend Golang via ngrok
 *  - Mode BUFFER: simpan ke Firebase Realtime DB (fallback)
 * 
 * Saat backend aktif & ada data di Firebase → ambil semua → kirim ke backend → hapus dari Firebase
 */

// ═══════════════════════════════════════════════
//  CONFIG — GANTI SESUAI SETUP LO
// ═══════════════════════════════════════════════
const CONFIG = {
  backendUrl: 'https://panorama-proud-stung.ngrok-free.dev',
  
  // Endpoint di backend
  trackEndpoint: '/api/visit',
  flushEndpoint: '/api/visit/flush',   // untuk terima bulk data dari Firebase

  // Firebase config lo
  firebase: {
    databaseUrl: 'https://xian000-default-rtdb.asia-southeast1.firebasedatabase.app',
    bufferPath: '/cv_visitors',          // node di Firebase
  },

  // Timeout cek backend (ms)
  pingTimeout: 4000,
};
// ═══════════════════════════════════════════════

(async function initTracker() {
  const statusEl  = document.getElementById('track-status');
  const labelEl   = document.getElementById('track-label');

  function setStatus(mode) {
    if (!statusEl) return;
    statusEl.className = mode; // 'live' | 'firebase' | ''
    labelEl.textContent = mode === 'live'
      ? 'connected'
      : mode === 'firebase'
        ? 'buffered'
        : 'tracking...';
  }

  // ── 1. Kumpulin data visitor ──────────────────
  const visitData = await collectVisitorData();

  // ── 2. Cek apakah backend aktif ──────────────
  const backendAlive = await pingBackend();

  if (backendAlive) {
    setStatus('live');

    // Kirim data visitor langsung
    await sendToBackend(CONFIG.trackEndpoint, visitData);

    // Cek apakah ada data numpuk di Firebase → drain ke backend
    await drainFirebaseToBackend();

  } else {
    setStatus('firebase');

    // Backend mati → simpan ke Firebase sebagai buffer
    await pushToFirebase(visitData);
  }
})();


// ═══════════════════════════════════════════════
//  COLLECT DATA
// ═══════════════════════════════════════════════
async function collectVisitorData() {
  const nav = window.navigator;
  const scr = window.screen;

  // Ambil IP + geo via free API (no key needed)
  let geo = {};
  try {
    const r = await Promise.race([
      fetch('https://ipapi.co/json/').then(r => r.json()),
      new Promise((_, rej) => setTimeout(() => rej('timeout'), 5000))
    ]);
    geo = {
      ip:           r.ip,
      city:         r.city,
      region:       r.region,
      country:      r.country_name,
      country_code: r.country_code,
      latitude:     r.latitude,
      longitude:    r.longitude,
      org:          r.org,          // ISP/provider
      timezone:     r.timezone,
    };
  } catch (_) {
    geo = { ip: 'unknown', error: 'geo_fetch_failed' };
  }

  return {
    timestamp:      new Date().toISOString(),
    timezone_local: Intl.DateTimeFormat().resolvedOptions().timeZone,

    // GEO
    ...geo,

    // BROWSER & OS
    user_agent:     nav.userAgent,
    language:       nav.language,
    languages:      nav.languages?.join(', '),
    platform:       nav.platform,
    vendor:         nav.vendor,

    // SCREEN
    screen_w:       scr.width,
    screen_h:       scr.height,
    viewport_w:     window.innerWidth,
    viewport_h:     window.innerHeight,
    color_depth:    scr.colorDepth,
    pixel_ratio:    window.devicePixelRatio,

    // REFERRER & NAVIGATION
    referrer:       document.referrer || 'direct',
    page_url:       window.location.href,

    // CONNECTION
    connection_type: navigator.connection?.effectiveType || 'unknown',
    downlink:        navigator.connection?.downlink || null,

    // MISC
    touch_support:  'ontouchstart' in window,
    cookies_enabled: nav.cookieEnabled,
    do_not_track:   nav.doNotTrack === '1',
  };
}


// ═══════════════════════════════════════════════
//  PING BACKEND
// ═══════════════════════════════════════════════
async function pingBackend() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.pingTimeout);

    const res = await fetch(`${CONFIG.backendUrl}/ping`, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'ngrok-skip-browser-warning': '1' },
    });
    clearTimeout(timer);
    return res.ok;
  } catch (_) {
    return false;
  }
}


// ═══════════════════════════════════════════════
//  SEND TO BACKEND
// ═══════════════════════════════════════════════
async function sendToBackend(endpoint, data) {
  try {
    await fetch(`${CONFIG.backendUrl}${endpoint}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' },
      body:    JSON.stringify(data),
    });
  } catch (err) {
    console.warn('[tracker] Failed to send to backend:', err.message);
  }
}


// ═══════════════════════════════════════════════
//  FIREBASE: PUSH (buffer saat backend mati)
// ═══════════════════════════════════════════════
async function pushToFirebase(data) {
  const url = `${CONFIG.firebase.databaseUrl}${CONFIG.firebase.bufferPath}.json`;
  try {
    await fetch(url, {
      method:  'POST',    // POST = auto-generate key (push)
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    console.log('[tracker] Buffered to Firebase');
  } catch (err) {
    console.warn('[tracker] Firebase push failed:', err.message);
  }
}


// ═══════════════════════════════════════════════
//  FIREBASE: DRAIN ke backend (saat backend aktif kembali)
// ═══════════════════════════════════════════════
async function drainFirebaseToBackend() {
  const url = `${CONFIG.firebase.databaseUrl}${CONFIG.firebase.bufferPath}.json`;

  try {
    // 1. Ambil semua data dari Firebase
    const res  = await fetch(url);
    const data = await res.json();

    if (!data || Object.keys(data).length === 0) return; // kosong, skip

    console.log(`[tracker] Found ${Object.keys(data).length} buffered visits in Firebase`);

    // 2. Kirim bulk ke backend
    const visits = Object.entries(data).map(([key, val]) => ({ _fbKey: key, ...val }));
    await sendToBackend(CONFIG.flushEndpoint, { visits });

    // 3. Hapus dari Firebase (set null = delete di RTDB)
    await fetch(url, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(null),
    });

    console.log('[tracker] Firebase buffer drained & cleared');

  } catch (err) {
    console.warn('[tracker] Firebase drain failed:', err.message);
  }
}
