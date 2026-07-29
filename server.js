'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const { Game } = require('./lib/game');
const { Spotify } = require('./lib/spotify');
const SONGS = require('./data/songs');

const spotify = new Spotify();

// Un fallo aislado no debe tumbar el proceso: si lo hiciera, todas las salas
// en memoria se perderían y nadie podría unirse a su partida.
process.on('unhandledRejection', (err) => {
  console.error('Promesa sin capturar (la partida continúa):', err);
});
process.on('uncaughtException', (err) => {
  console.error('Excepción sin capturar (la partida continúa):', err);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;

// ─── Previews de audio (iTunes con respaldo de Deezer, sin claves) ──────────
// Ojo: iTunes suele devolver 403 a IPs de centros de datos (Render, AWS…).
// Por eso hay doble respaldo: Deezer desde el servidor y, si ambos fallan,
// los propios navegadores de los jugadores buscan el preview (ver lookupTerm).
const previewCache = new Map(); // songIndex -> { previewUrl, artworkUrl }

async function fetchJson(url, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const norm = (x) => String(x || '').toLowerCase();

async function searchItunes(s) {
  const term = encodeURIComponent(`${s.artist} ${s.title}`);
  const data = await fetchJson(
    `https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=5`
  );
  const hit =
    (data.results || []).find(
      (r) => r.previewUrl && norm(r.artistName).includes(norm(s.artist).split(' ')[0])
    ) || (data.results || []).find((r) => r.previewUrl);
  return hit
    ? {
        previewUrl: hit.previewUrl,
        artworkUrl: hit.artworkUrl100 ? hit.artworkUrl100.replace('100x100', '300x300') : null,
      }
    : null;
}

async function searchDeezer(s) {
  const q = encodeURIComponent(`${s.artist} ${s.title}`);
  const data = await fetchJson(`https://api.deezer.com/search?q=${q}&limit=5`);
  const hit =
    (data.data || []).find(
      (r) => r.preview && norm(r.artist && r.artist.name).includes(norm(s.artist).split(' ')[0])
    ) || (data.data || []).find((r) => r.preview);
  return hit
    ? { previewUrl: hit.preview, artworkUrl: (hit.album && hit.album.cover_medium) || null }
    : null;
}

async function fetchPreview(songIndex) {
  if (previewCache.has(songIndex)) return previewCache.get(songIndex);
  const s = SONGS[songIndex];
  let out = null;
  try {
    out = await searchItunes(s);
  } catch (err) {
    console.warn(`iTunes falló para "${s.title}": ${err.message}`);
  }
  if (!out) {
    try {
      out = await searchDeezer(s);
    } catch (err) {
      console.warn(`Deezer falló para "${s.title}": ${err.message}`);
    }
  }
  if (out) previewCache.set(songIndex, out); // los fallos no se cachean
  return out;
}

// Precalienta la caché de previews en segundo plano para que los turnos
// empiecen al instante. Si la red los bloquea (p. ej. sin internet), se aborta.
async function warmupPreviews() {
  const probe = await fetchPreview(0);
  if (!probe && !previewCache.has(0)) return; // red bloqueada: no insistir
  for (let i = 1; i < SONGS.length; i += 3) {
    await Promise.all(
      [i, i + 1, i + 2].filter((j) => j < SONGS.length).map((j) => fetchPreview(j))
    );
  }
  const ok = [...previewCache.values()].filter(Boolean).length;
  console.log(`Previews precargados: ${ok}/${SONGS.length}`);
}

// ─── Salas ──────────────────────────────────────────────────────────────────
const rooms = new Map(); // code -> Room

function makeCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sin I/O para evitar confusiones
  let code = '';
  do {
    code = Array.from({ length: 4 }, () => abc[Math.floor(Math.random() * abc.length)]).join('');
  } while (rooms.has(code));
  return code;
}

class Room {
  constructor(code) {
    this.code = code;
    this.game = new Game(SONGS);
    this.hostId = null;
    this.tokens = new Map(); // playerId -> secreto de reconexión
    this.sockets = new Map(); // playerId -> socket
    this.timer = null;
    this.timerEndsAt = null;
    this.audio = null; // { previewUrl, artworkUrl } de la carta actual
    this.lastActivity = Date.now();
    this.kickTimers = new Map(); // playerId -> timeout de gracia en el lobby
    this.screens = new Set(); // sockets en modo pantalla (TV), sin jugador
    this.lookupTerm = null; // término de búsqueda para que los navegadores resuelvan el audio
    this.lookupTimer = null; // plazo para caer al modo pista si nadie encuentra audio
    this.readyNext = new Set(); // quién ya pulsó «siguiente» en la revelación
  }

  clearLookup() {
    if (this.lookupTimer) clearTimeout(this.lookupTimer);
    this.lookupTimer = null;
    this.lookupTerm = null;
    this.lookupFails = new Set();
  }

  cancelKick(playerId) {
    const t = this.kickTimers.get(playerId);
    if (t) clearTimeout(t);
    this.kickTimers.delete(playerId);
  }

  touch() {
    this.lastActivity = Date.now();
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerEndsAt = null;
  }

  setTimer(seconds, fn) {
    this.clearTimer();
    this.timerEndsAt = Date.now() + seconds * 1000;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerEndsAt = null;
      fn();
    }, seconds * 1000);
  }

  broadcast() {
    const common = {
      code: this.code,
      hostId: this.hostId,
      timerEndsAt: this.timerEndsAt,
      audio: this.audio,
      audioLoading: !!this.audioLoading,
      lookup: this.audio ? null : this.lookupTerm,
      readyIds: [...this.readyNext],
      now: Date.now(), // para corregir el desfase de reloj en los clientes
    };
    for (const [playerId, socket] of this.sockets) {
      socket.emit('state', { ...common, ...this.game.viewFor(playerId) });
    }
    for (const socket of this.screens) {
      socket.emit('state', { ...common, isScreen: true, ...this.game.viewFor(null) });
    }
  }
}

// Limpieza de salas inactivas (2 h sin actividad).
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > 2 * 60 * 60 * 1000) {
      room.clearTimer();
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

// Reúne las fuentes de audio de una canción: track de Spotify (si está
// configurado) y preview de iTunes como respaldo, en paralelo.
async function fetchAudio(songIndex) {
  const [preview, sp] = await Promise.all([
    fetchPreview(songIndex),
    spotify.isConfigured() ? spotify.findTrack(SONGS[songIndex]) : null,
  ]);
  if (!preview && !sp) return null;
  return {
    previewUrl: preview ? preview.previewUrl : null,
    spotifyTrackId: sp ? sp.trackId : null,
    artworkUrl: (sp && sp.artworkUrl) || (preview && preview.artworkUrl) || null,
  };
}

async function startTurn(room) {
  // Se avisa de inmediato (estado "buscando canción…") y el audio llega en
  // una segunda emisión, para que nadie escuche la canción del turno anterior.
  room.audio = null;
  room.audioLoading = true;
  room.readyNext.clear();
  room.clearLookup();
  armPlaceTimer(room);
  room.broadcast();
  const card = room.game.currentCard;
  const audio = card ? await fetchAudio(card.songIndex) : null;
  // Si la partida avanzó mientras buscábamos el audio, no pisar nada.
  if (room.game.currentCard !== card) return;
  room.audioLoading = false;
  if (room.game.phase === 'placing' || room.game.phase === 'steal') {
    room.audio = audio;
    if (audio) {
      room.game.clueShown = false;
    } else {
      // El servidor no consiguió preview (p. ej. iTunes bloquea IPs de nube):
      // se pide a los navegadores que lo busquen ellos. Si el jugador activo
      // tampoco lo encuentra en 10 s, se cae al modo pista.
      room.lookupTerm = `${card.artist} ${card.title}`;
      room.game.clueShown = false;
      room.lookupTimer = setTimeout(() => {
        room.lookupTimer = null;
        if (
          room.game.currentCard === card &&
          !room.audio &&
          (room.game.phase === 'placing' || room.game.phase === 'steal')
        ) {
          room.game.clueShown = true;
          room.lookupTerm = null;
          room.broadcast();
        }
      }, 10 * 1000);
    }
  }
  room.broadcast();
}

// Tras colocar/comprar/revelar, arma el temporizador que toque según la fase.
function armPhaseTimer(room) {
  const ph = room.game.phase;
  if (ph === 'steal') armStealTimer(room);
  else if (ph === 'reveal') armRevealTimer(room);
  else if (ph === 'gameover') room.clearTimer();
}

function anyoneConnected(room) {
  return room.game.players.some((q) => q.connected);
}

function armPlaceTimer(room) {
  const secs = room.game.settings.placeSeconds;
  if (!secs) return;
  room.setTimer(secs, () => {
    const g = room.game;
    if (g.phase !== 'placing') return;
    if (!anyoneConnected(room)) return; // sala vacía: la partida queda en pausa
    if (g.settings.mode === 'simul') {
      // Tiempo agotado: se revela con lo que haya; quien no colocó, no puntúa.
      g.revealSimul();
    } else {
      // Clásico: colocación automática en un hueco aleatorio.
      const p = g.activePlayer;
      const gap = Math.floor(Math.random() * (p.timeline.length + 1));
      g.placeCard(p.id, gap);
    }
    armPhaseTimer(room);
    room.broadcast();
  });
}

function armStealTimer(room) {
  room.setTimer(room.game.settings.stealSeconds, () => {
    if (room.game.phase === 'steal') {
      room.game.reveal();
      armPhaseTimer(room);
      room.broadcast();
    }
  });
}

// Auto-avance tras la revelación: la partida nunca depende de que alguien
// concreto pulse "siguiente".
function armRevealTimer(room) {
  const secs = room.game.settings.revealSeconds;
  if (!secs) return;
  room.setTimer(secs, () => {
    if (room.game.phase !== 'reveal') return;
    if (!anyoneConnected(room)) return; // sala vacía: pausa
    room.game.nextTurn();
    startTurn(room);
  });
}

// En el lobby, un desconectado tiene 60 s de gracia antes de ser expulsado.
function scheduleLobbyKick(room, playerId) {
  room.cancelKick(playerId);
  room.kickTimers.set(
    playerId,
    setTimeout(() => {
      room.kickTimers.delete(playerId);
      const q = room.game.player(playerId);
      if (!q || q.connected || room.game.phase !== 'lobby') return;
      room.game.removePlayer(playerId);
      room.tokens.delete(playerId);
      if (room.hostId === playerId) {
        const next = room.game.players[0];
        room.hostId = next ? next.id : null;
      }
      if (room.game.players.length === 0) {
        room.clearTimer();
        rooms.delete(room.code);
        return;
      }
      room.broadcast();
    }, 60 * 1000)
  );
}

// Rearma el temporizador si la partida quedó en pausa por sala vacía.
function resumeTimers(room) {
  if (room.timer) return;
  const ph = room.game.phase;
  if (ph === 'placing') armPlaceTimer(room);
  else if (ph === 'steal') armStealTimer(room);
  else if (ph === 'reveal') armRevealTimer(room);
}

io.on('connection', (socket) => {
  let joined = null; // { room, playerId }
  let joinedScreen = null; // sala a la que este socket está unido como pantalla

  const fail = (msg) => socket.emit('errorMsg', msg);

  function bind(room, playerId) {
    joined = { room, playerId };
    room.cancelKick(playerId);
    const prev = room.sockets.get(playerId);
    if (prev && prev !== socket) prev.disconnect(true);
    room.sockets.set(playerId, socket);
    socket.join(room.code);
  }

  const cleanAvatar = (a) => {
    a = String(a || '').trim();
    return a && a.length <= 8 ? a : null;
  };

  socket.on('createRoom', ({ name, avatar } = {}, cb) => {
    name = String(name || '').trim().slice(0, 16);
    if (!name) return cb && cb({ error: 'Pon tu nombre' });
    if (rooms.size >= 500) return cb && cb({ error: 'El servidor está lleno, prueba más tarde' });
    const room = new Room(makeCode());
    rooms.set(room.code, room);
    const playerId = crypto.randomUUID();
    const secret = crypto.randomUUID();
    room.game.addPlayer(playerId, name, cleanAvatar(avatar));
    room.hostId = playerId;
    room.tokens.set(playerId, secret);
    bind(room, playerId);
    room.touch();
    room.broadcast();
    cb && cb({ ok: true, code: room.code, playerId, secret });
  });

  socket.on('joinRoom', ({ code, name, avatar } = {}, cb) => {
    code = String(code || '').trim().toUpperCase();
    name = String(name || '').trim().slice(0, 16);
    const room = rooms.get(code);
    if (!room) return cb && cb({ error: 'Sala no encontrada' });
    if (!name) return cb && cb({ error: 'Pon tu nombre' });
    if (room.game.phase !== 'lobby') return cb && cb({ error: 'La partida ya empezó' });
    if (room.game.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return cb && cb({ error: 'Ese nombre ya está en uso' });
    }
    const playerId = crypto.randomUUID();
    const secret = crypto.randomUUID();
    const p = room.game.addPlayer(playerId, name, cleanAvatar(avatar));
    if (!p) return cb && cb({ error: 'La sala está llena (máx. 10)' });
    room.tokens.set(playerId, secret);
    bind(room, playerId);
    room.touch();
    room.broadcast();
    cb && cb({ ok: true, code: room.code, playerId, secret });
  });

  // Modo pantalla (TV): espectador sin jugador, puede unirse en cualquier fase.
  socket.on('joinScreen', ({ code } = {}, cb) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) return cb && cb({ error: 'Sala no encontrada' });
    if (joinedScreen) joinedScreen.screens.delete(socket);
    joinedScreen = room;
    room.screens.add(socket);
    room.touch();
    room.broadcast();
    cb && cb({ ok: true, code: room.code });
  });

  socket.on('rejoin', ({ code, playerId, secret } = {}, cb) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return cb && cb({ error: 'Sala no encontrada' });
    if (room.tokens.get(playerId) !== secret) return cb && cb({ error: 'Sesión no válida' });
    const p = room.game.player(playerId);
    if (!p) return cb && cb({ error: 'Jugador no encontrado' });
    p.connected = true;
    bind(room, playerId);
    resumeTimers(room); // por si la partida quedó en pausa con la sala vacía
    room.touch();
    room.broadcast();
    cb && cb({ ok: true, code: room.code, playerId, secret });
  });

  socket.on('startGame', (opts = {}) => {
    if (!joined) return fail('No estás en una sala');
    const { room, playerId } = joined;
    if (playerId !== room.hostId) return fail('Solo el anfitrión puede empezar');
    if (room.game.phase !== 'lobby') return fail('La partida ya empezó');
    const s = room.game.settings;
    if (Number.isInteger(+opts.targetCards) && +opts.targetCards >= 3 && +opts.targetCards <= 15) {
      s.targetCards = +opts.targetCards;
    }
    if (typeof opts.allowSteal === 'boolean') s.allowSteal = opts.allowSteal;
    if (['simul', 'classic'].includes(opts.mode)) s.mode = opts.mode;
    if ([30, 60, 90].includes(+opts.placeSeconds)) s.placeSeconds = +opts.placeSeconds;
    if ([0, 2].includes(+opts.yearMargin)) s.yearMargin = +opts.yearMargin;
    if (['all', 'classic', 'middle', 'modern'].includes(opts.era)) s.era = opts.era;
    if (['all', 'es'].includes(opts.lang)) s.lang = opts.lang;
    const r = room.game.start();
    if (r.error) return fail(r.error);
    room.touch();
    startTurn(room);
  });

  // En modo simultáneo, cuando todos han colocado se revela sin esperar.
  function maybeRevealSimul(room) {
    if (room.game.settings.mode !== 'simul') return;
    if (room.game.phase === 'placing' && room.game.allPlaced()) {
      room.clearTimer();
      room.game.revealSimul();
      armPhaseTimer(room);
    }
  }

  socket.on('placeCard', ({ gap } = {}) => {
    if (!joined) return;
    const { room, playerId } = joined;
    const g = room.game;
    if (g.settings.mode === 'simul') {
      const r = g.placeSimul(playerId, gap);
      if (r.error) return fail(r.error);
      room.touch();
      maybeRevealSimul(room);
      room.broadcast();
      return;
    }
    const r = g.placeCard(playerId, gap);
    if (r.error) return fail(r.error);
    room.touch();
    room.clearTimer();
    armPhaseTimer(room);
    room.broadcast();
  });

  socket.on('guessSong', ({ artist, title } = {}) => {
    if (!joined) return;
    const { room, playerId } = joined;
    const g = room.game;
    const r =
      g.settings.mode === 'simul'
        ? g.guessSimul(playerId, artist, title)
        : g.setGuess(playerId, artist, title);
    if (r.error) return fail(r.error);
    room.touch();
    room.broadcast();
  });

  socket.on('skipSong', () => {
    if (!joined) return;
    const { room, playerId } = joined;
    if (room.game.settings.mode === 'simul') return fail('En este modo no se cambia de canción');
    const r = room.game.skipSong(playerId);
    if (r.error) return fail(r.error);
    room.touch();
    room.clearTimer();
    startTurn(room); // nueva canción → nuevo preview y nuevo temporizador
  });

  socket.on('buyCard', () => {
    if (!joined) return;
    const { room, playerId } = joined;
    const g = room.game;
    if (g.settings.mode === 'simul') {
      const r = g.buySimul(playerId);
      if (r.error) return fail(r.error);
      room.touch();
      maybeRevealSimul(room);
      room.broadcast();
      return;
    }
    const r = g.buyCard(playerId);
    if (r.error) return fail(r.error);
    room.touch();
    room.clearTimer();
    armPhaseTimer(room);
    room.broadcast();
  });

  socket.on('stealBid', ({ gap } = {}) => {
    if (!joined) return;
    const { room, playerId } = joined;
    const g = room.game;
    const r = g.stealBid(playerId, gap);
    if (r.error) return fail(r.error);
    room.touch();
    // Si ya no queda nadie que pueda apostar, se revela sin esperar.
    const pending = g.players.some(
      (q) =>
        q.id !== g.activePlayer.id &&
        q.connected &&
        q.tokens >= 1 &&
        !g.stealBids.some((b) => b.playerId === q.id)
    );
    if (!pending) {
      room.clearTimer();
      g.reveal();
      armPhaseTimer(room);
    }
    room.broadcast();
  });

  socket.on('resolveSteal', () => {
    // El jugador activo puede cerrar la ventana de robo sin esperar.
    if (!joined) return;
    const { room, playerId } = joined;
    if (room.game.phase !== 'steal') return;
    if (room.game.activePlayer.id !== playerId && playerId !== room.hostId) return;
    room.clearTimer();
    room.game.reveal();
    armPhaseTimer(room);
    room.touch();
    room.broadcast();
  });

  // Avanzar de ronda es cosa de todos: cada jugador marca «listo» y en cuanto
  // todos los conectados lo están, se pasa a la siguiente ronda. El anfitrión
  // puede forzarlo con `forceNext` si alguien se despista.
  function advanceRound(room) {
    const r = room.game.nextTurn();
    if (r.error) return r;
    room.readyNext.clear();
    room.clearTimer();
    startTurn(room);
    return { ok: true };
  }

  socket.on('nextTurn', () => {
    if (!joined) return;
    const { room, playerId } = joined;
    const g = room.game;
    if (g.phase !== 'reveal') return;
    if (!g.player(playerId)) return;
    room.readyNext.add(playerId);
    room.touch();
    const connected = g.players.filter((q) => q.connected);
    const allReady = connected.length > 0 && connected.every((q) => room.readyNext.has(q.id));
    if (allReady) advanceRound(room);
    else room.broadcast();
  });

  socket.on('forceNext', () => {
    if (!joined) return;
    const { room, playerId } = joined;
    const g = room.game;
    if (g.phase !== 'reveal') return;
    // El anfitrión fuerza; si no está conectado, cualquiera puede desatascar.
    const host = g.player(room.hostId);
    const hostDown = !host || !host.connected;
    if (playerId !== room.hostId && !hostDown) return fail('Solo el anfitrión puede saltar');
    room.touch();
    advanceRound(room);
  });

  socket.on('playAgain', () => {
    if (!joined) return;
    const { room, playerId } = joined;
    if (playerId !== room.hostId) return fail('Solo el anfitrión puede reiniciar');
    if (room.game.phase !== 'gameover') return;
    const old = room.game;
    room.game = new Game(SONGS, old.settings);
    // Se conservan también los desconectados: pueden volver con su sesión, y
    // si no vuelven en 60 s el lobby los expulsa solo.
    for (const p of old.players) {
      const np = room.game.addPlayer(p.id, p.name, p.avatar);
      if (np) {
        np.connected = p.connected;
        if (!p.connected) scheduleLobbyKick(room, p.id);
      }
    }
    room.clearTimer();
    room.clearLookup();
    room.readyNext.clear();
    room.audio = null;
    room.audioLoading = false;
    room.touch();
    room.broadcast();
  });

  // Los navegadores informan de si encontraron el preview por su cuenta.
  socket.on('lookupResult', ({ found } = {}) => {
    if (!joined) return;
    const { room, playerId } = joined;
    const g = room.game;
    if (!room.lookupTerm) return;
    if (g.phase !== 'placing' && g.phase !== 'steal') return;
    const simul = g.settings.mode === 'simul';
    if (!simul) {
      // Clásico: manda el jugador activo, que es quien necesita oírla.
      const active = g.activePlayer;
      if (!active || active.id !== playerId) return;
      if (found) {
        if (room.lookupTimer) clearTimeout(room.lookupTimer);
        room.lookupTimer = null;
      } else {
        g.clueShown = true;
        room.clearLookup();
        room.broadcast();
      }
      return;
    }
    // Simultáneo: un éxito cualquiera cancela el plazo; si TODOS los
    // conectados fallan, se pasa al modo pista.
    if (found) {
      if (room.lookupTimer) clearTimeout(room.lookupTimer);
      room.lookupTimer = null;
      return;
    }
    room.lookupFails = room.lookupFails || new Set();
    room.lookupFails.add(playerId);
    const connected = g.players.filter((p) => p.connected);
    if (connected.length && connected.every((p) => room.lookupFails.has(p.id))) {
      g.clueShown = true;
      room.clearLookup();
      room.broadcast();
    }
  });

  // Reacciones en vivo: un emoji que flota en las pantallas de todos.
  let lastReact = 0;
  socket.on('react', ({ emoji } = {}) => {
    if (!joined) return;
    const now = Date.now();
    if (now - lastReact < 700) return; // antirrebote
    lastReact = now;
    emoji = String(emoji || '').slice(0, 8);
    if (!emoji) return;
    const { room, playerId } = joined;
    const p = room.game.player(playerId);
    if (!p) return;
    const payload = { name: p.name, avatar: p.avatar, emoji };
    for (const [, s] of room.sockets) s.emit('reaction', payload);
    for (const s of room.screens) s.emit('reaction', payload);
  });

  socket.on('disconnect', () => {
    if (joinedScreen) joinedScreen.screens.delete(socket);
    if (!joined) return;
    const { room, playerId } = joined;
    if (room.sockets.get(playerId) === socket) room.sockets.delete(playerId);
    const p = room.game.player(playerId);
    if (p) p.connected = false;
    if (room.game.phase === 'lobby') {
      scheduleLobbyKick(room, playerId);
    }
    // El rol de anfitrión pasa de inmediato a alguien conectado para que la
    // sala nunca quede sin control (empezar, avanzar, reiniciar…).
    if (room.hostId === playerId) {
      const next = room.game.players.find((q) => q.connected);
      if (next) room.hostId = next.id;
    }
    // Simultáneo: si el que se fue era el único que faltaba por colocar, revela.
    maybeRevealSimul(room);
    // Si se fue el único que faltaba por pulsar «siguiente», avanza la ronda.
    if (room.game.phase === 'reveal') {
      const conn = room.game.players.filter((q) => q.connected);
      if (conn.length && conn.every((q) => room.readyNext.has(q.id))) {
        advanceRound(room);
        return;
      }
    }
    room.broadcast();
  });
});

// En alojamientos gratuitos el servicio se duerme tras unos minutos sin
// tráfico y luego tarda ~30 s en despertar (justo cuando alguien intenta
// unirse). Si la plataforma nos da la URL pública, nos hacemos ping cada 10
// minutos para seguir despiertos. Se desactiva con KEEP_AWAKE=0.
function keepAwake() {
  const url = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
  if (!url || process.env.KEEP_AWAKE === '0') return;
  const ping = () => {
    fetch(`${url.replace(/\/$/, '')}/health`).catch(() => {});
  };
  setInterval(ping, 10 * 60 * 1000).unref();
  console.log(`⏰ Auto-ping activado para no dormirse: ${url}/health`);
}

server.listen(PORT, () => {
  console.log(`🎵 Hitser escuchando en http://localhost:${PORT}`);
  keepAwake();
  console.log(
    spotify.isConfigured()
      ? '🟢 Spotify activado: canciones vía embed oficial (completas con sesión iniciada)'
      : '⚪ Spotify no configurado (define SPOTIFY_CLIENT_ID y SPOTIFY_CLIENT_SECRET); se usan previews de iTunes'
  );
  warmupPreviews().catch(() => {});
});
