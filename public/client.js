'use strict';

/* Cliente de Hitser: una sola página, estados dirigidos por el servidor. */

const socket = io();
const $ = (id) => document.getElementById(id);

let S = null; // último estado recibido del servidor
let session = null; // { code, playerId, secret }
let isScreen = false; // modo pantalla (TV): espectador sin jugador
let timerInterval = null;
let serverOffset = 0; // desfase entre el reloj del servidor y el del cliente
let lastTurnKey = null; // detecta el cambio de turno para limpiar formularios
let lastPhase = null; // detecta transiciones para sonidos y confeti

// ── Avatares ────────────────────────────────────────────────────────────────
const AVATARS = ['🎧', '🎸', '🎤', '🥁', '🎹', '🎺', '🪩', '🎷', '🌟', '🔥'];
let myAvatar = localStorage.getItem('hitser_avatar') || AVATARS[Math.floor(Math.random() * AVATARS.length)];

// ── Colores por década para las cartas ──────────────────────────────────────
const DEC_COLORS = {
  1950: '#c98f45', 1960: '#e0653f', 1970: '#d84a86', 1980: '#a44ae0',
  1990: '#4a6ce0', 2000: '#2aa8b8', 2010: '#2ab86e', 2020: '#9bd42a',
};
function decadeOf(year) {
  return Math.floor(year / 10) * 10;
}

// ── Efectos de sonido sintetizados (sin ficheros) ───────────────────────────
let sfxCtx = null;
let muted = localStorage.getItem('hitser_muted') === '1';
function beep(seq) {
  if (muted) return;
  try {
    sfxCtx = sfxCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = sfxCtx.currentTime;
    for (const [freq, dur, at] of seq) {
      const o = sfxCtx.createOscillator();
      const g = sfxCtx.createGain();
      o.type = 'triangle';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(0.16, t0 + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      o.connect(g).connect(sfxCtx.destination);
      o.start(t0 + at);
      o.stop(t0 + at + dur + 0.05);
    }
  } catch { /* sin audio disponible */ }
}
const SFX = {
  correct: () => beep([[523, 0.15, 0], [659, 0.15, 0.12], [784, 0.3, 0.24]]),
  wrong: () => beep([[220, 0.3, 0], [185, 0.4, 0.15]]),
  steal: () => beep([[330, 0.12, 0], [330, 0.12, 0.15], [440, 0.28, 0.3]]),
  turn: () => beep([[440, 0.1, 0], [554, 0.16, 0.1]]),
  win: () => beep([[523, 0.15, 0], [659, 0.15, 0.13], [784, 0.15, 0.26], [1047, 0.5, 0.39]]),
};
function vibrate(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* nada */ }
}

// ── Confeti (canvas propio, sin librerías) ──────────────────────────────────
function confetti(count = 130, duration = 2600) {
  const cv = $('fx');
  const ctx = cv.getContext('2d');
  cv.width = innerWidth;
  cv.height = innerHeight;
  const colors = ['#1ed760', '#ffc93c', '#ff2d78', '#7c5cff', '#2aa8b8', '#ffffff'];
  const parts = Array.from({ length: count }, () => ({
    x: Math.random() * cv.width,
    y: -20 - Math.random() * cv.height * 0.4,
    w: 6 + Math.random() * 6,
    h: 8 + Math.random() * 8,
    vy: 2.2 + Math.random() * 3.4,
    vx: -1.4 + Math.random() * 2.8,
    rot: Math.random() * Math.PI,
    vr: -0.14 + Math.random() * 0.28,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const t0 = performance.now();
  (function frame(t) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (t - t0 < duration) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, cv.width, cv.height);
  })(t0);
}

// ── Overlay de cambio de turno ──────────────────────────────────────────────
let overlayTimer = null;
function showTurnOverlay(avatar, text) {
  const ov = $('turn-overlay');
  $('overlay-avatar').textContent = avatar;
  $('overlay-text').textContent = text;
  ov.classList.remove('hidden', 'out');
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => {
    ov.classList.add('out');
    setTimeout(() => ov.classList.add('hidden'), 320);
  }, 1300);
}

// ── Utilidades ──────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
}

function saveSession() {
  if (session) localStorage.setItem('hitser_session', JSON.stringify(session));
}
function clearSession() {
  session = null;
  localStorage.removeItem('hitser_session');
  localStorage.removeItem('hitser_screen');
}

function me() {
  return S ? S.players.find((p) => p.id === S.you) : null;
}
function playerName(id) {
  const p = S && S.players.find((q) => q.id === id);
  return p ? p.name : '?';
}

// ── Audio ───────────────────────────────────────────────────────────────────
const audio = new Audio();
audio.preload = 'auto';
let currentPreview = null;
let userInteracted = false; // los navegadores solo permiten autoplay tras un gesto
let autoPlayed = null; // URL ya auto-reproducida (para no pelear con el pause del usuario)
document.addEventListener('pointerdown', () => { userInteracted = true; });

// ── Búsqueda de previews desde el navegador (JSONP: iTunes → Deezer) ────────
// Cuando el servidor no consigue el preview (iTunes bloquea IPs de nube),
// cada teléfono lo busca por su cuenta desde su propia conexión.
function jsonp(url, ms = 6000) {
  return new Promise((resolve, reject) => {
    const name = 'jp' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    const t = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, ms);
    function cleanup() {
      delete window[name];
      s.remove();
      clearTimeout(t);
    }
    window[name] = (data) => { cleanup(); resolve(data); };
    s.src = url + '&callback=' + name;
    s.onerror = () => { cleanup(); reject(new Error('error')); };
    document.head.appendChild(s);
  });
}

async function clientLookup(term) {
  try {
    const d = await jsonp(
      'https://itunes.apple.com/search?media=music&entity=song&limit=5&term=' +
        encodeURIComponent(term)
    );
    const hit = (d.results || []).find((r) => r.previewUrl);
    if (hit) {
      return {
        previewUrl: hit.previewUrl,
        artworkUrl: hit.artworkUrl100 ? hit.artworkUrl100.replace('100x100', '300x300') : null,
      };
    }
  } catch { /* siguiente fuente */ }
  try {
    const d = await jsonp(
      'https://api.deezer.com/search?limit=5&output=jsonp&q=' + encodeURIComponent(term)
    );
    const hit = (d.data || []).find((r) => r.preview);
    if (hit) {
      return { previewUrl: hit.preview, artworkUrl: (hit.album && hit.album.cover_medium) || null };
    }
  } catch { /* sin suerte */ }
  return null;
}

let lookupState = { term: null, audio: null, pending: false };
function syncLookup() {
  const term = S && !S.audio && S.lookup ? S.lookup : null;
  if (!term) {
    if (lookupState.term && (!S || !S.lookup)) lookupState = { term: null, audio: null, pending: false };
    return;
  }
  if (lookupState.term === term) return; // ya resuelto o en curso
  lookupState = { term, audio: null, pending: true };
  clientLookup(term).then((res) => {
    if (lookupState.term !== term) return;
    lookupState.audio = res;
    lookupState.pending = false;
    if (S && S.turnPlayerId === S.you && !isScreen) {
      socket.emit('lookupResult', { found: !!res });
    }
    render();
  });
}

// Audio efectivo: el que resolvió el servidor o el que encontró este navegador.
function effectiveAudio() {
  return (S && S.audio) || lookupState.audio || null;
}

audio.addEventListener('play', () => {
  $('vinyl').classList.add('spinning');
  $('btn-play').textContent = '⏸ Pausar';
  $('btn-play').classList.remove('pulse');
});
audio.addEventListener('pause', () => {
  $('vinyl').classList.remove('spinning');
  $('btn-play').textContent = '▶ Escuchar canción';
  $('btn-play').classList.add('pulse');
});
audio.addEventListener('ended', () => {
  $('vinyl').classList.remove('spinning');
  $('btn-play').textContent = '🔁 Volver a escuchar';
  $('btn-play').classList.add('pulse');
});

// ── Spotify (embed oficial controlado desde nuestro botón) ─────────────────
// El iframe queda oculto durante el turno para no revelar la canción; con
// sesión de Spotify iniciada en el navegador suena la canción completa.
let spotifyCtrl = null;
let spotifyApiPromise = null;
let spotifyLoadedUri = null;
let spotifyPaused = true;

function loadSpotifyApi() {
  if (spotifyApiPromise) return spotifyApiPromise;
  spotifyApiPromise = new Promise((resolve, reject) => {
    window.onSpotifyIframeApiReady = (api) => resolve(api);
    const s = document.createElement('script');
    s.src = 'https://open.spotify.com/embed/iframe-api/v1';
    s.async = true;
    s.onerror = () => reject(new Error('No se pudo cargar Spotify'));
    document.head.appendChild(s);
    setTimeout(() => reject(new Error('Spotify tardó demasiado')), 10000);
  });
  return spotifyApiPromise;
}

function ensureSpotifyTrack(trackId) {
  const uri = 'spotify:track:' + trackId;
  if (spotifyCtrl) {
    if (spotifyLoadedUri !== uri) {
      spotifyCtrl.loadUri(uri);
      spotifyLoadedUri = uri;
      spotifyPaused = true;
    }
    return Promise.resolve(spotifyCtrl);
  }
  return loadSpotifyApi().then(
    (api) =>
      new Promise((resolve) => {
        api.createController(
          $('spotify-embed'),
          { uri, width: '100%', height: 152 },
          (ctrl) => {
            spotifyCtrl = ctrl;
            spotifyLoadedUri = uri;
            ctrl.addListener('playback_update', (e) => {
              spotifyPaused = !e || !e.data || e.data.isPaused !== false;
              $('vinyl').classList.toggle('spinning', !spotifyPaused);
              $('btn-play').textContent = spotifyPaused ? '▶ Escuchar canción' : '⏸ Pausar';
            });
            resolve(ctrl);
          }
        );
      })
  );
}

$('btn-play').addEventListener('click', async () => {
  const spId = S && S.audio && S.audio.spotifyTrackId;
  if (spId) {
    try {
      const ctrl = await ensureSpotifyTrack(spId);
      ctrl.togglePlay();
      return;
    } catch (err) {
      // Si el embed no carga (p. ej. sin acceso a Spotify), cae al preview.
      if (!(S.audio && S.audio.previewUrl)) return toast(err.message);
      if (!audio.src) audio.src = S.audio.previewUrl;
    }
  }
  if (audio.paused) audio.play().catch(() => toast('No se pudo reproducir'));
  else audio.pause();
});

function syncAudio() {
  const a = S ? S.audio : null;
  const spId = a ? a.spotifyTrackId : null;
  const revealPhase = S && (S.phase === 'reveal' || S.phase === 'gameover');
  // El embed solo se enseña en la revelación (con la carátula y el título).
  $('spotify-wrap').classList.toggle('hidden', !spId || !spotifyCtrl);
  $('spotify-wrap').classList.toggle('hidden-embed', !revealPhase);
  if (spId) {
    // Cambia de track si toca y silencia el reproductor de previews.
    if (spotifyCtrl && spotifyLoadedUri !== 'spotify:track:' + spId) {
      spotifyCtrl.loadUri('spotify:track:' + spId);
      spotifyLoadedUri = 'spotify:track:' + spId;
      spotifyPaused = true;
      $('vinyl').classList.remove('spinning');
      $('btn-play').textContent = '▶ Escuchar canción';
    }
    if (!audio.paused) audio.pause();
    currentPreview = null;
    audio.removeAttribute('src');
    return;
  }
  if (spotifyCtrl && !spotifyPaused) spotifyCtrl.pause();
  const eff = effectiveAudio();
  const url = eff ? eff.previewUrl : null;
  if (url !== currentPreview) {
    currentPreview = url;
    audio.pause();
    if (url) audio.src = url;
    else audio.removeAttribute('src');
    $('btn-play').textContent = '▶ Escuchar canción';
    autoPlayed = null;
  }
  // La canción arranca sola al empezar la ronda (una vez por canción; si el
  // usuario pausa, no se le vuelve a encender).
  if (
    url &&
    userInteracted &&
    autoPlayed !== url &&
    (S.phase === 'placing' || S.phase === 'steal')
  ) {
    autoPlayed = url;
    audio.play().catch(() => {});
  }
}

// ── Temporizador visual ─────────────────────────────────────────────────────
function syncTimer() {
  clearInterval(timerInterval);
  const fill = $('timerfill');
  if (!S || !S.timerEndsAt) {
    fill.style.width = '0%';
    $('timer-num').classList.add('hidden');
    return;
  }
  const secs =
    S.phase === 'steal'
      ? S.settings.stealSeconds
      : S.phase === 'reveal'
        ? S.settings.revealSeconds
        : S.settings.placeSeconds;
  const total = secs * 1000;
  const num = $('timer-num');
  const tick = () => {
    // Se usa el reloj del servidor (con desfase corregido) para que la barra
    // sea fiel aunque el reloj del móvil vaya mal.
    const left = S.timerEndsAt - (Date.now() + serverOffset);
    fill.style.width = Math.max(0, Math.min(100, (left / total) * 100)) + '%';
    // Cuenta atrás numérica en los últimos 10 segundos de colocación/robo.
    const sLeft = Math.ceil(left / 1000);
    const showNum = left > 0 && sLeft <= 10 && (S.phase === 'placing' || S.phase === 'steal');
    num.classList.toggle('hidden', !showNum);
    if (showNum) num.textContent = sLeft;
    if (left <= 0) {
      num.classList.add('hidden');
      clearInterval(timerInterval);
    }
  };
  tick();
  timerInterval = setInterval(tick, 500);
}

// ── Pantalla siempre encendida durante la partida ───────────────────────────
let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {
    /* no soportado o denegado: no pasa nada */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S) keepAwake();
});

// ── Render de líneas de tiempo ──────────────────────────────────────────────
function renderTimeline(el, player, { gaps = false, onGap = null, highlight = null } = {}) {
  el.innerHTML = '';
  const tl = player.timeline;
  const addGap = (i) => {
    const before = i > 0 ? tl[i - 1].year : null;
    const after = i < tl.length ? tl[i].year : null;
    const range =
      before === null
        ? `antes de ${after}`
        : after === null
          ? `después de ${before}`
          : `${before}–${after}`;
    const b = document.createElement('button');
    b.className = 'gap-btn';
    b.innerHTML = `<span class="gplus">+</span><span class="grange"></span>`;
    b.querySelector('.grange').textContent = range;
    b.setAttribute('aria-label', `Colocar ${range}`);
    b.addEventListener('click', () => onGap(i));
    el.appendChild(b);
  };
  const addCard = (c) => {
    const d = document.createElement('div');
    d.className = 'tcard';
    const dec = decadeOf(c.year);
    d.style.setProperty('--dec', DEC_COLORS[dec] || '#7c5cff');
    if (highlight && c.songIndex === highlight) d.classList.add('new-card');
    d.innerHTML = `
      <div class="tdecade">${String(dec).slice(2)}s</div>
      <div class="tyear">${c.year}</div>
      <div class="ttitle"></div>
      <div class="tartist"></div>`;
    d.querySelector('.ttitle').textContent = c.title;
    d.querySelector('.tartist').textContent = c.artist;
    el.appendChild(d);
  };
  if (gaps) addGap(0);
  tl.forEach((c, i) => {
    addCard(c);
    if (gaps) addGap(i + 1);
  });
  if (!tl.length && !gaps) {
    el.innerHTML = '<p class="hint">Sin cartas todavía</p>';
  }
}

// ── Render principal ────────────────────────────────────────────────────────
function render() {
  if (!S) return;

  if (S.phase === 'lobby') return renderLobby();
  if (S.phase === 'gameover') return renderGameOver();
  renderGame();
}

function renderLobby() {
  showScreen('screen-lobby');
  // Código como fichas de letras (solo A-Z generadas por el servidor).
  $('lobby-code').innerHTML = S.code
    .split('')
    .map((c) => `<span class="code-letter">${c}</span>`)
    .join('');
  // QR para unirse desde otros teléfonos (si el servicio de QR no carga, se oculta).
  const qr = $('qr-img');
  const joinUrl = `${location.origin}/?sala=${S.code}`;
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(joinUrl)}`;
  if (qr.dataset.for !== S.code) {
    qr.dataset.for = S.code;
    qr.onload = () => $('qr-box').classList.remove('hidden');
    qr.onerror = () => $('qr-box').classList.add('hidden');
    qr.src = qrSrc;
  }
  const ul = $('lobby-players');
  ul.innerHTML = '';
  for (const p of S.players) {
    const li = document.createElement('li');
    if (p.id === S.you) li.classList.add('me');
    if (!p.connected) li.style.opacity = '.45';
    li.innerHTML = `<span class="pavatar"></span><span class="pname"></span>
      ${p.id === S.hostId ? '<span class="host-tag">★ ANFITRIÓN</span>' : ''}
      <span class="right">${p.id === S.you ? 'tú' : ''}</span>`;
    li.querySelector('.pavatar').textContent = p.avatar || '🎧';
    li.querySelector('.pname').textContent = p.name;
    ul.appendChild(li);
  }
  const isHost = S.you === S.hostId;
  $('lobby-settings').classList.toggle('hidden', !isHost || isScreen);
  $('lobby-wait').classList.toggle('hidden', isHost && !isScreen);
  $('btn-start').disabled = S.players.length < 2;
  $('btn-start').textContent =
    S.players.length < 2 ? 'Faltan jugadores (mín. 2)' : '▶ Empezar partida';
}

function renderGame() {
  showScreen('screen-game');
  $('game-code').textContent = S.code;
  $('game-round').textContent = `Ronda ${S.round}`;

  // Chips de jugadores
  const strip = $('players-strip');
  strip.innerHTML = '';
  for (const p of S.players) {
    const d = document.createElement('div');
    d.className = 'pchip';
    if (p.id === S.turnPlayerId) d.classList.add('turn');
    if (p.id === S.you) d.classList.add('me-chip');
    if (!p.connected) d.classList.add('offline');
    const placedMark =
      S.settings.mode === 'simul' && S.phase === 'placing' && S.placedIds.includes(p.id)
        ? ' ✔'
        : '';
    const pct = Math.min(100, Math.round((p.cards / S.settings.targetCards) * 100));
    d.innerHTML = `<div class="pname"></div>
      <div class="pstats">🎴 ${p.cards}/${S.settings.targetCards} · 🪙 ${p.tokens}</div>
      <div class="pbar"><div class="pbar-fill" style="width:${pct}%"></div></div>`;
    d.querySelector('.pname').textContent =
      `${p.avatar || '🎧'} ${p.name}` + (p.id === S.you ? ' (tú)' : '') + placedMark;
    strip.appendChild(d);
  }

  const my = me();
  const simul = S.settings.mode === 'simul';
  const isMyTurn = !simul && S.turnPlayerId === S.you;
  const active = S.players.find((p) => p.id === S.turnPlayerId);

  // Banner de turno / ronda
  if (simul) {
    if (S.phase === 'placing') {
      const total = S.players.filter((p) => p.connected).length;
      $('turn-banner').innerHTML = `<span class="you">🎵 ¡Coloca la canción! (${S.placedIds.length}/${total})</span>`;
    } else {
      $('turn-banner').textContent = '';
    }
  } else {
    $('turn-banner').innerHTML = isMyTurn
      ? '<span class="you">🎯 ¡Es tu turno!</span>'
      : `Turno de <b></b>`;
    if (!isMyTurn) $('turn-banner').querySelector('b').textContent = active ? active.name : '?';
  }

  // Cajas visibles según fase y rol
  const boxes = ['audio-box', 'place-box', 'watch-box', 'stealwait-box', 'reveal-box'];
  boxes.forEach((b) => $(b).classList.add('hidden'));

  const av = effectiveAudio();
  const searching = (S.audioLoading || lookupState.pending) && !av;
  const clueMode = !av && !searching && S.currentCard && S.currentCard.hidden && S.currentCard.title;
  if (S.phase === 'placing' || S.phase === 'steal') {
    $('audio-box').classList.remove('hidden');
    const noAudio = !av;
    $('btn-play').classList.toggle('hidden', noAudio);
    const spMode = S.audio && S.audio.spotifyTrackId;
    $('btn-play').classList.toggle('pulse', !noAudio && (spMode ? spotifyPaused : audio.paused));
    $('no-audio').classList.toggle('hidden', !noAudio);
    if (searching) {
      $('no-audio').textContent = '⏳ Buscando la canción…';
    } else if (clueMode) {
      $('no-audio').innerHTML = '🔇 Sin audio — la canción es:<br>«<b></b>» de <b class="clue-artist"></b><br>¿En qué año salió?';
      $('no-audio').querySelector('b').textContent = S.currentCard.title;
      $('no-audio').querySelector('.clue-artist').textContent = S.currentCard.artist;
    } else if (noAudio) {
      $('no-audio').textContent = '🔇 Sin audio para esta canción';
    }
  }

  // Vista TV: enseña las líneas de tiempo de todos los jugadores.
  if (isScreen && (S.phase === 'placing' || S.phase === 'steal')) {
    $('watch-box').classList.remove('hidden');
    if (simul) {
      const total = S.players.filter((p) => p.connected).length;
      $('watch-msg').textContent = `🎵 Todos colocando la canción… (${S.placedIds.length}/${total})`;
    } else {
      $('watch-msg').innerHTML =
        S.phase === 'steal'
          ? `<b></b> ya colocó su carta. ¡Momento de robar!`
          : `<b></b> está colocando la canción en su línea de tiempo…`;
      $('watch-msg').querySelector('b').textContent = active ? active.name : '?';
    }
    const cont = $('watch-timeline');
    cont.innerHTML = '';
    cont.classList.remove('timeline');
    for (const p of S.players) {
      const h = document.createElement('div');
      h.className = 'tvline-name' + (p.id === S.turnPlayerId ? ' active' : '');
      h.textContent = `${p.id === S.turnPlayerId ? '🎯 ' : ''}${p.avatar || ''} ${p.name} · 🎴 ${p.cards} · 🪙 ${p.tokens}`;
      cont.appendChild(h);
      const tl = document.createElement('div');
      tl.className = 'timeline readonly';
      renderTimeline(tl, p, {});
      cont.appendChild(tl);
    }
    $('steal-offer').classList.add('hidden');
    $('steal-pick').classList.add('hidden');
    syncAudio();
    syncTimer();
    return;
  }
  $('watch-timeline').classList.add('timeline');

  // Modo simultáneo: todos colocan a la vez en su propia línea.
  if (simul && S.phase === 'placing') {
    const placed = !!S.myPlacement;
    if (my && !placed) {
      $('place-box').classList.remove('hidden');
      renderTimeline($('my-timeline'), my, { gaps: true, onGap: (g) => socket.emit('placeCard', { gap: g }) });
      $('guess-box').classList.toggle('hidden', !!clueMode); // sin audio no hay bonus
      $('guess-sent').classList.toggle('hidden', !S.myGuessSubmitted);
      $('btn-skip').classList.add('hidden'); // no hay cambio de canción en este modo
      $('btn-buy').disabled = my.tokens < 3;
    } else {
      $('watch-box').classList.remove('hidden');
      $('watch-msg').textContent = placed
        ? '✅ Carta colocada — esperando a los demás…'
        : 'Observando la ronda…';
      renderTimeline($('watch-timeline'), my || S.players[0], {});
      $('steal-offer').classList.add('hidden');
      $('steal-pick').classList.add('hidden');
    }
    syncAudio();
    syncTimer();
    return;
  }

  if (S.phase === 'placing') {
    if (isMyTurn) {
      $('place-box').classList.remove('hidden');
      renderTimeline($('my-timeline'), my, { gaps: true, onGap: (g) => socket.emit('placeCard', { gap: g }) });
      $('guess-box').classList.toggle('hidden', !!clueMode); // sin audio no hay bonus
      $('guess-sent').classList.toggle('hidden', !S.guessSubmitted);
      $('btn-skip').classList.remove('hidden');
      $('btn-skip').disabled = my.tokens < 1;
      $('btn-buy').disabled = my.tokens < 3;
    } else {
      $('watch-box').classList.remove('hidden');
      $('watch-msg').innerHTML = `<b></b> está colocando la canción en su línea de tiempo…`;
      $('watch-msg').querySelector('b').textContent = active ? active.name : '?';
      renderTimeline($('watch-timeline'), active, {});
      $('steal-offer').classList.add('hidden');
      $('steal-pick').classList.add('hidden');
    }
  }

  if (S.phase === 'steal') {
    if (isMyTurn) {
      $('stealwait-box').classList.remove('hidden');
    } else {
      $('watch-box').classList.remove('hidden');
      const alreadyBid = S.stealBids.some((b) => b.playerId === S.you);
      const canBid = my && my.tokens >= 1 && !alreadyBid;
      $('watch-msg').innerHTML = alreadyBid
        ? '🏴‍☠️ Apuesta hecha. Cruzemos los dedos…'
        : `<b></b> ya colocó su carta. ¿Crees que falló?`;
      if (!alreadyBid) $('watch-msg').querySelector('b').textContent = active ? active.name : '?';
      renderTimeline($('watch-timeline'), active, {});
      $('steal-offer').classList.toggle('hidden', !canBid);
      $('steal-pick').classList.add('hidden');
    }
  }

  if (S.phase === 'reveal') {
    renderReveal();
  }

  syncAudio();
  syncTimer();
}

function renderReveal() {
  const r = S.lastResult;
  if (!r) return;
  $('reveal-box').classList.remove('hidden');
  // Solo se muestra el reproductor si hay algo que escuchar.
  const av2 = effectiveAudio();
  $('audio-box').classList.toggle('hidden', !av2);
  $('btn-play').classList.toggle('hidden', !av2);
  $('no-audio').classList.add('hidden');

  const art = av2 && av2.artworkUrl;
  $('reveal-art').classList.toggle('hidden', !art);
  if (art) $('reveal-art').src = art;

  $('reveal-year').textContent = r.card.year;
  $('reveal-title').textContent = r.card.title;
  $('reveal-artist').textContent = r.card.artist;

  // Tu línea de tiempo actualizada, con la carta nueva brillando si la ganaste.
  const meP = me();
  const showTl = !!(meP && meP.timeline.length);
  $('reveal-timeline').classList.toggle('hidden', !showTl);
  if (showTl) {
    renderTimeline($('reveal-timeline'), meP, { highlight: r.card.songIndex });
  }

  const out = $('reveal-outcome');
  out.classList.remove('good', 'bad');

  // Resultado del modo simultáneo: cada uno ve el suyo + el resumen de todos.
  if (r.type === 'simul') {
    const names = (list) => list.map((x) => playerName(x.playerId)).join(', ');
    const oks = r.results.filter((x) => x.correct);
    const kos = r.results.filter((x) => !x.correct);
    const mine = r.results.find((x) => x.playerId === S.you);
    if (!mine) {
      out.textContent = `✅ ${oks.length} acierto(s) · ❌ ${kos.length} fallo(s)`;
    } else if (mine.bought) {
      out.textContent = '💰 Compraste la carta con 3 fichas';
      out.classList.add('good');
    } else if (mine.correct) {
      out.textContent = '✅ ¡Acertaste! Carta a tu línea de tiempo';
      out.classList.add('good');
    } else {
      out.textContent = '❌ Fallaste esta ronda…';
      out.classList.add('bad');
    }
    const extra = [];
    if (oks.length) extra.push('✅ ' + names(oks));
    if (kos.length) extra.push('❌ ' + names(kos));
    const fast = r.results.find((x) => x.firstBonus);
    if (fast) extra.push(`⚡ Más rápido: ${playerName(fast.playerId)} +1🪙`);
    const gw = r.results.filter((x) => x.guessTokenWon);
    if (gw.length) extra.push('🎤 Bonus artista+título: ' + names(gw));
    $('reveal-extra').textContent = extra.join('  ·  ');
    const canAdvance = S.you === S.hostId;
    $('btn-next').classList.toggle('hidden', !canAdvance);
    return;
  }

  const who = playerName(r.playerId);
  const isMe = r.playerId === S.you;

  if (r.type === 'buy') {
    out.textContent = `💰 ${isMe ? 'Compraste' : who + ' compró'} la carta con 3 fichas`;
    out.classList.add('good');
  } else if (r.correct) {
    out.textContent = `✅ ¡${isMe ? 'Acertaste' : who + ' acertó'}! Carta a la línea de tiempo`;
    out.classList.add('good');
  } else {
    out.textContent = `❌ ${isMe ? 'Fallaste' : who + ' falló'}…`;
    out.classList.add('bad');
    if (r.stealWinnerId) {
      const thief = playerName(r.stealWinnerId);
      out.textContent += ` 🏴‍☠️ ¡${r.stealWinnerId === S.you ? 'TÚ te llevas' : thief + ' se lleva'} la carta!`;
    }
  }

  const extra = [];
  if (r.guessResult) {
    if (r.guessResult.tokenWon) extra.push('🎤 ¡Artista y título correctos! +1 🪙');
    else if (r.guessResult.artistOk) extra.push('🎤 Artista correcto, pero el título no');
    else if (r.guessResult.titleOk) extra.push('🎤 Título correcto, pero el artista no');
    else extra.push('🎤 La respuesta del bonus no era correcta');
  }
  if (r.stealBids && r.stealBids.length && r.correct) {
    extra.push(`Las ${r.stealBids.length} apuesta(s) de robo se pierden`);
  }
  $('reveal-extra').textContent = extra.join(' · ');

  const canAdvance = S.you === S.hostId || S.you === r.playerId;
  $('btn-next').classList.toggle('hidden', !canAdvance);
}

function renderGameOver() {
  showScreen('screen-over');
  const winner = S.players.find((p) => p.id === S.winnerId);
  $('winner-name').textContent = winner ? winner.name : '—';
  // La última carta jugada, para que el final no se quede sin revelación.
  const last = S.lastResult;
  $('over-last').textContent = last
    ? `Última canción: «${last.card.title}» de ${last.card.artist} (${last.card.year})`
    : '';
  const ul = $('ranking');
  ul.innerHTML = '';
  const sorted = [...S.players].sort(
    (a, b) => b.cards - a.cards || b.tokens - a.tokens
  );
  sorted.forEach((p, i) => {
    const li = document.createElement('li');
    if (p.id === S.you) li.classList.add('me');
    const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}º`;
    const st = p.stats || {};
    li.innerHTML = `<span>${medal}</span><span class="pavatar"></span><span class="pname"></span>
      <span class="right">🎴 ${p.cards} · ✅ ${st.correct || 0} · 🏴‍☠️ ${st.steals || 0} · 🪙 ${st.tokensEarned || 0}</span>`;
    li.querySelector('.pavatar').textContent = p.avatar || '🎧';
    li.querySelector('.pname').textContent = p.name;
    ul.appendChild(li);
  });
  $('btn-again').classList.toggle('hidden', S.you !== S.hostId);
  audio.pause();
}

// ── Eventos de socket ───────────────────────────────────────────────────────
socket.on('state', (state) => {
  const prevPhase = S ? S.phase : null;
  S = state;
  isScreen = !!state.isScreen;
  if (state.now) serverOffset = state.now - Date.now();
  document.body.classList.toggle('screen-mode', isScreen);

  // Nuevo turno: limpia formularios y anuncia a quién le toca.
  const turnKey = `${state.round}:${state.turnPlayerId}`;
  if (turnKey !== lastTurnKey) {
    const isFirst = lastTurnKey === null;
    lastTurnKey = turnKey;
    $('inp-guess-artist').value = '';
    $('inp-guess-title').value = '';
    $('guess-box').removeAttribute('open');
    $('steal-pick').classList.add('hidden');
    if (!isFirst && state.phase === 'placing') {
      if (state.settings.mode === 'simul') {
        showTurnOverlay('🎵', `Ronda ${state.round}`);
        SFX.turn();
        if (!state.isScreen) vibrate(80);
      } else if (state.turnPlayerId) {
        const active = state.players.find((p) => p.id === state.turnPlayerId);
        const mine = state.turnPlayerId === state.you;
        showTurnOverlay(active ? active.avatar : '🎧', mine ? '¡Te toca!' : `Turno de ${active ? active.name : '?'}`);
        SFX.turn();
        if (mine) vibrate([90, 60, 90]);
      }
    }
  }

  // Sonidos y confeti según el desenlace de la ronda.
  if (state.phase !== prevPhase && prevPhase !== null) {
    const r = state.lastResult;
    if ((state.phase === 'reveal' || state.phase === 'gameover') && r && prevPhase !== 'reveal') {
      if (r.type === 'simul') {
        const mine = (r.results || []).find((x) => x.playerId === state.you);
        if (mine && mine.correct) {
          SFX.correct();
          confetti(70, 1800);
          vibrate(120);
        } else if (mine) {
          SFX.wrong();
          vibrate(220);
        } else {
          SFX.turn(); // pantalla TV o espectador
        }
      } else if (r.correct) {
        SFX.correct();
        if (r.playerId === state.you) { confetti(70, 1800); vibrate(120); }
      } else if (r.stealWinnerId) {
        SFX.steal();
        if (r.stealWinnerId === state.you) { confetti(70, 1800); vibrate([60, 40, 120]); }
      } else {
        SFX.wrong();
        if (r.playerId === state.you) vibrate(220);
      }
    }
    if (state.phase === 'gameover') {
      SFX.win();
      confetti(180, 3400);
    }
  }
  lastPhase = state.phase;

  syncLookup();
  keepAwake();
  render();
});

// Reacciones flotantes de otros jugadores.
socket.on('reaction', ({ name, emoji }) => {
  const d = document.createElement('div');
  d.className = 'float-emoji';
  d.style.left = 8 + Math.random() * 80 + 'vw';
  d.innerHTML = `<span class="who"></span>`;
  d.prepend(document.createTextNode(emoji));
  d.querySelector('.who').textContent = name;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 2700);
});

socket.on('errorMsg', (msg) => toast(msg));

socket.on('connect', () => {
  // Pantalla TV: vuelve a engancharse a la sala tras recarga o reconexión.
  const screenCode = localStorage.getItem('hitser_screen');
  if (screenCode) {
    socket.emit('joinScreen', { code: screenCode }, (res) => {
      if (!res || !res.ok) {
        localStorage.removeItem('hitser_screen');
        showScreen('screen-home');
      }
    });
    return;
  }
  // Reintenta reconectar a la sesión guardada.
  const saved = localStorage.getItem('hitser_session');
  if (saved && !S) {
    const sess = JSON.parse(saved);
    socket.emit('rejoin', sess, (res) => {
      if (res && res.ok) {
        session = sess;
      } else {
        clearSession();
        showScreen('screen-home');
      }
    });
  } else if (session) {
    socket.emit('rejoin', session, () => {});
  }
});

socket.on('disconnect', () => toast('Conexión perdida, reconectando…'));

// ── Botones ─────────────────────────────────────────────────────────────────
// Selector de avatar
function renderAvatarRow() {
  const row = $('avatar-row');
  row.innerHTML = '';
  for (const a of AVATARS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = a;
    b.setAttribute('role', 'radio');
    if (a === myAvatar) b.classList.add('on');
    b.addEventListener('click', () => {
      myAvatar = a;
      localStorage.setItem('hitser_avatar', a);
      renderAvatarRow();
    });
    row.appendChild(b);
  }
}
renderAvatarRow();

$('btn-create').addEventListener('click', () => {
  const name = $('inp-name').value.trim();
  if (!name) return toast('Pon tu nombre');
  socket.emit('createRoom', { name, avatar: myAvatar }, (res) => {
    if (res.error) return toast(res.error);
    session = { code: res.code, playerId: res.playerId, secret: res.secret };
    saveSession();
  });
});

$('btn-join').addEventListener('click', () => {
  const name = $('inp-name').value.trim();
  const code = $('inp-code').value.trim().toUpperCase();
  if (!name) return toast('Pon tu nombre');
  if (code.length !== 4) return toast('El código tiene 4 letras');
  socket.emit('joinRoom', { code, name, avatar: myAvatar }, (res) => {
    if (res.error) return toast(res.error);
    session = { code: res.code, playerId: res.playerId, secret: res.secret };
    saveSession();
  });
});

// Selectores segmentados de los ajustes
document.querySelectorAll('.seg').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    seg.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
    btn.classList.add('on');
  });
});
const segVal = (id) => $(id).querySelector('.on').dataset.v;

// Silenciar efectos de sonido
function renderMute() {
  $('btn-mute').textContent = muted ? '🔕' : '🔔';
}
renderMute();
$('btn-mute').addEventListener('click', () => {
  muted = !muted;
  localStorage.setItem('hitser_muted', muted ? '1' : '0');
  renderMute();
  if (!muted) SFX.turn();
});

// Reacciones
$('react-bar').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || isScreen) return;
  socket.emit('react', { emoji: btn.dataset.e });
});

$('btn-screen').addEventListener('click', () => {
  const code = $('inp-code').value.trim().toUpperCase();
  if (code.length !== 4) return toast('Escribe el código de la sala para proyectarla');
  socket.emit('joinScreen', { code }, (res) => {
    if (res.error) return toast(res.error);
    localStorage.setItem('hitser_screen', code);
  });
});

$('inp-target').addEventListener('input', (e) => {
  $('lbl-target').textContent = e.target.value;
});

$('btn-start').addEventListener('click', () => {
  socket.emit('startGame', {
    mode: segVal('seg-mode'),
    targetCards: +$('inp-target').value,
    allowSteal: $('inp-steal').checked,
    placeSeconds: +segVal('seg-speed'),
    yearMargin: +segVal('seg-margin'),
    era: segVal('seg-era'),
    lang: $('inp-lang').checked ? 'es' : 'all',
  });
});

// Tocar el código lo copia al portapapeles.
$('lobby-code').addEventListener('click', async () => {
  if (!S || !S.code) return;
  try {
    await navigator.clipboard.writeText(S.code);
    toast('✅ Código copiado: ' + S.code);
  } catch {
    toast(S.code);
  }
});

$('btn-leave').addEventListener('click', () => {
  clearSession();
  location.reload();
});
$('btn-home').addEventListener('click', () => {
  clearSession();
  location.reload();
});

$('btn-guess').addEventListener('click', () => {
  const artist = $('inp-guess-artist').value.trim();
  const title = $('inp-guess-title').value.trim();
  if (!artist && !title) return toast('Escribe artista y título');
  socket.emit('guessSong', { artist, title });
  toast('🎤 Respuesta enviada');
});

$('btn-skip').addEventListener('click', () => socket.emit('skipSong'));
$('btn-buy').addEventListener('click', () => socket.emit('buyCard'));
$('btn-resolve').addEventListener('click', () => socket.emit('resolveSteal'));
$('btn-next').addEventListener('click', () => socket.emit('nextTurn'));
$('btn-again').addEventListener('click', () => socket.emit('playAgain'));

$('btn-steal').addEventListener('click', () => {
  $('steal-offer').classList.add('hidden');
  $('steal-pick').classList.remove('hidden');
  renderTimeline($('steal-timeline'), me(), {
    gaps: true,
    onGap: (g) => {
      socket.emit('stealBid', { gap: g });
      $('steal-pick').classList.add('hidden');
    },
  });
});

// Código en mayúsculas automáticamente
$('inp-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
});

// Si llegas con un enlace/QR tipo ?sala=ABCD, el código viene puesto.
const salaParam = new URLSearchParams(location.search).get('sala');
if (salaParam && /^[A-Z]{4}$/i.test(salaParam)) {
  $('inp-code').value = salaParam.toUpperCase();
  $('inp-name').focus();
}

showScreen('screen-home');
