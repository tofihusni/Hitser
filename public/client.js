'use strict';

/* Cliente de Hitser: una sola página, estados dirigidos por el servidor. */

const socket = io();
const $ = (id) => document.getElementById(id);

let S = null; // último estado recibido del servidor
let session = null; // { code, playerId, secret }
let timerInterval = null;

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

audio.addEventListener('play', () => {
  $('vinyl').classList.add('spinning');
  $('btn-play').textContent = '⏸ Pausar';
});
audio.addEventListener('pause', () => {
  $('vinyl').classList.remove('spinning');
  $('btn-play').textContent = '▶ Escuchar canción';
});
audio.addEventListener('ended', () => {
  $('vinyl').classList.remove('spinning');
  $('btn-play').textContent = '🔁 Volver a escuchar';
});

$('btn-play').addEventListener('click', () => {
  if (audio.paused) audio.play().catch(() => toast('No se pudo reproducir'));
  else audio.pause();
});

function syncAudio() {
  const url = S && S.audio ? S.audio.previewUrl : null;
  if (url !== currentPreview) {
    currentPreview = url;
    audio.pause();
    if (url) audio.src = url;
    else audio.removeAttribute('src');
    $('btn-play').textContent = '▶ Escuchar canción';
  }
}

// ── Temporizador visual ─────────────────────────────────────────────────────
function syncTimer() {
  clearInterval(timerInterval);
  const fill = $('timerfill');
  if (!S || !S.timerEndsAt) {
    fill.style.width = '0%';
    return;
  }
  const total =
    (S.phase === 'steal' ? S.settings.stealSeconds : S.settings.placeSeconds) * 1000;
  const tick = () => {
    const left = S.timerEndsAt - Date.now();
    fill.style.width = Math.max(0, Math.min(100, (left / total) * 100)) + '%';
    if (left <= 0) clearInterval(timerInterval);
  };
  tick();
  timerInterval = setInterval(tick, 500);
}

// ── Render de líneas de tiempo ──────────────────────────────────────────────
function renderTimeline(el, player, { gaps = false, onGap = null, highlight = null } = {}) {
  el.innerHTML = '';
  const tl = player.timeline;
  const addGap = (i) => {
    const b = document.createElement('button');
    b.className = 'gap-btn';
    b.textContent = '+';
    b.setAttribute('aria-label', `Colocar en posición ${i + 1}`);
    b.addEventListener('click', () => onGap(i));
    el.appendChild(b);
  };
  const addCard = (c) => {
    const d = document.createElement('div');
    d.className = 'tcard';
    if (highlight && c.songIndex === highlight) d.classList.add('new-card');
    d.innerHTML = `
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
  $('lobby-code').textContent = S.code;
  const ul = $('lobby-players');
  ul.innerHTML = '';
  for (const p of S.players) {
    const li = document.createElement('li');
    if (p.id === S.you) li.classList.add('me');
    li.innerHTML = `<span>🎧</span><span class="pname"></span>
      ${p.id === S.hostId ? '<span class="host-tag">★ anfitrión</span>' : ''}
      <span class="right">${p.id === S.you ? 'tú' : ''}</span>`;
    li.querySelector('.pname').textContent = p.name;
    ul.appendChild(li);
  }
  const isHost = S.you === S.hostId;
  $('lobby-settings').classList.toggle('hidden', !isHost);
  $('lobby-wait').classList.toggle('hidden', isHost);
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
    d.innerHTML = `<div class="pname"></div>
      <div class="pstats">🎴 ${p.cards}/${S.settings.targetCards} · 🪙 ${p.tokens}</div>`;
    d.querySelector('.pname').textContent = p.name + (p.id === S.you ? ' (tú)' : '');
    strip.appendChild(d);
  }

  const my = me();
  const isMyTurn = S.turnPlayerId === S.you;
  const active = S.players.find((p) => p.id === S.turnPlayerId);

  // Banner de turno
  $('turn-banner').innerHTML = isMyTurn
    ? '<span class="you">🎯 ¡Es tu turno!</span>'
    : `Turno de <b></b>`;
  if (!isMyTurn) $('turn-banner').querySelector('b').textContent = active ? active.name : '?';

  // Cajas visibles según fase y rol
  const boxes = ['audio-box', 'place-box', 'watch-box', 'stealwait-box', 'reveal-box'];
  boxes.forEach((b) => $(b).classList.add('hidden'));

  const clueMode = !S.audio && S.currentCard && S.currentCard.hidden && S.currentCard.title;
  if (S.phase === 'placing' || S.phase === 'steal') {
    $('audio-box').classList.remove('hidden');
    const noAudio = !S.audio;
    $('btn-play').classList.toggle('hidden', noAudio);
    $('no-audio').classList.toggle('hidden', !noAudio);
    if (clueMode) {
      $('no-audio').innerHTML = '🔇 Sin audio — la canción es:<br>«<b></b>» de <b class="clue-artist"></b><br>¿En qué año salió?';
      $('no-audio').querySelector('b').textContent = S.currentCard.title;
      $('no-audio').querySelector('.clue-artist').textContent = S.currentCard.artist;
    } else if (noAudio) {
      $('no-audio').textContent = '🔇 Sin audio para esta canción';
    }
  }

  if (S.phase === 'placing') {
    if (isMyTurn) {
      $('place-box').classList.remove('hidden');
      renderTimeline($('my-timeline'), my, { gaps: true, onGap: (g) => socket.emit('placeCard', { gap: g }) });
      $('guess-box').classList.toggle('hidden', !!clueMode); // sin audio no hay bonus
      $('guess-sent').classList.toggle('hidden', !S.guessSubmitted);
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
  $('audio-box').classList.toggle('hidden', !S.audio);
  $('btn-play').classList.toggle('hidden', !S.audio);
  $('no-audio').classList.add('hidden');

  const art = S.audio && S.audio.artworkUrl;
  $('reveal-art').classList.toggle('hidden', !art);
  if (art) $('reveal-art').src = art;

  $('reveal-year').textContent = r.card.year;
  $('reveal-title').textContent = r.card.title;
  $('reveal-artist').textContent = r.card.artist;

  const who = playerName(r.playerId);
  const isMe = r.playerId === S.you;
  const out = $('reveal-outcome');
  out.classList.remove('good', 'bad');

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
  const ul = $('ranking');
  ul.innerHTML = '';
  const sorted = [...S.players].sort(
    (a, b) => b.cards - a.cards || b.tokens - a.tokens
  );
  sorted.forEach((p, i) => {
    const li = document.createElement('li');
    if (p.id === S.you) li.classList.add('me');
    const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}º`;
    li.innerHTML = `<span>${medal}</span><span class="pname"></span>
      <span class="right">🎴 ${p.cards} · 🪙 ${p.tokens}</span>`;
    li.querySelector('.pname').textContent = p.name;
    ul.appendChild(li);
  });
  $('btn-again').classList.toggle('hidden', S.you !== S.hostId);
  audio.pause();
}

// ── Eventos de socket ───────────────────────────────────────────────────────
socket.on('state', (state) => {
  S = state;
  render();
});

socket.on('errorMsg', (msg) => toast(msg));

socket.on('connect', () => {
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
$('btn-create').addEventListener('click', () => {
  const name = $('inp-name').value.trim();
  if (!name) return toast('Pon tu nombre');
  socket.emit('createRoom', { name }, (res) => {
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
  socket.emit('joinRoom', { code, name }, (res) => {
    if (res.error) return toast(res.error);
    session = { code: res.code, playerId: res.playerId, secret: res.secret };
    saveSession();
  });
});

$('inp-target').addEventListener('input', (e) => {
  $('lbl-target').textContent = e.target.value;
});

$('btn-start').addEventListener('click', () => {
  socket.emit('startGame', {
    targetCards: +$('inp-target').value,
    allowSteal: $('inp-steal').checked,
  });
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

showScreen('screen-home');
