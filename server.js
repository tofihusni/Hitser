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

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;

// ─── Previews de audio (API pública de iTunes, sin claves) ──────────────────
const previewCache = new Map(); // songIndex -> { previewUrl, artworkUrl } | null

async function fetchPreview(songIndex) {
  if (previewCache.has(songIndex)) return previewCache.get(songIndex);
  const s = SONGS[songIndex];
  const term = encodeURIComponent(`${s.artist} ${s.title}`);
  const url = `https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=5`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const norm = (x) => String(x || '').toLowerCase();
    // Prefiere resultados cuyo artista coincida con el buscado.
    const hit =
      (data.results || []).find(
        (r) => r.previewUrl && norm(r.artistName).includes(norm(s.artist).split(' ')[0])
      ) || (data.results || []).find((r) => r.previewUrl);
    const out = hit
      ? {
          previewUrl: hit.previewUrl,
          artworkUrl: hit.artworkUrl100 ? hit.artworkUrl100.replace('100x100', '300x300') : null,
        }
      : null;
    previewCache.set(songIndex, out);
    return out;
  } catch (err) {
    console.warn(`Sin preview para "${s.title}" (${s.artist}): ${err.message}`);
    return null; // no cacheamos el fallo: se reintenta la próxima vez
  }
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
    for (const [playerId, socket] of this.sockets) {
      socket.emit('state', {
        code: this.code,
        hostId: this.hostId,
        timerEndsAt: this.timerEndsAt,
        audio: this.audio,
        ...this.game.viewFor(playerId),
      });
    }
    for (const socket of this.screens) {
      socket.emit('state', {
        code: this.code,
        hostId: this.hostId,
        timerEndsAt: this.timerEndsAt,
        audio: this.audio,
        isScreen: true,
        ...this.game.viewFor(null),
      });
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
  room.audio = null;
  const card = room.game.currentCard;
  if (card) {
    room.audio = await fetchAudio(card.songIndex);
    // Si la partida avanzó mientras buscábamos el audio, no pisar nada.
    if (room.game.currentCard !== card) return;
    // Sin audio: modo pista — se enseña título/artista y se juega solo el año.
    room.game.clueShown = !room.audio;
  }
  armPlaceTimer(room);
  room.broadcast();
}

function armPlaceTimer(room) {
  const secs = room.game.settings.placeSeconds;
  if (!secs) return;
  room.setTimer(secs, () => {
    // Tiempo agotado: colocación automática en un hueco aleatorio.
    const g = room.game;
    if (g.phase !== 'placing') return;
    const p = g.activePlayer;
    const gap = Math.floor(Math.random() * (p.timeline.length + 1));
    g.placeCard(p.id, gap);
    if (g.phase === 'steal') armStealTimer(room);
    room.broadcast();
  });
}

function armStealTimer(room) {
  room.setTimer(room.game.settings.stealSeconds, () => {
    if (room.game.phase === 'steal') {
      room.game.reveal();
      room.broadcast();
    }
  });
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

  socket.on('createRoom', ({ name } = {}, cb) => {
    name = String(name || '').trim().slice(0, 16);
    if (!name) return cb && cb({ error: 'Pon tu nombre' });
    const room = new Room(makeCode());
    rooms.set(room.code, room);
    const playerId = crypto.randomUUID();
    const secret = crypto.randomUUID();
    room.game.addPlayer(playerId, name);
    room.hostId = playerId;
    room.tokens.set(playerId, secret);
    bind(room, playerId);
    room.touch();
    room.broadcast();
    cb && cb({ ok: true, code: room.code, playerId, secret });
  });

  socket.on('joinRoom', ({ code, name } = {}, cb) => {
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
    const p = room.game.addPlayer(playerId, name);
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
    const r = room.game.start();
    if (r.error) return fail(r.error);
    room.touch();
    startTurn(room);
  });

  socket.on('placeCard', ({ gap } = {}) => {
    if (!joined) return;
    const { room, playerId } = joined;
    const r = room.game.placeCard(playerId, gap);
    if (r.error) return fail(r.error);
    room.touch();
    room.clearTimer();
    if (room.game.phase === 'steal') armStealTimer(room);
    room.broadcast();
  });

  socket.on('guessSong', ({ artist, title } = {}) => {
    if (!joined) return;
    const { room, playerId } = joined;
    const r = room.game.setGuess(playerId, artist, title);
    if (r.error) return fail(r.error);
    room.touch();
    room.broadcast();
  });

  socket.on('skipSong', () => {
    if (!joined) return;
    const { room, playerId } = joined;
    const r = room.game.skipSong(playerId);
    if (r.error) return fail(r.error);
    room.touch();
    room.clearTimer();
    startTurn(room); // nueva canción → nuevo preview y nuevo temporizador
  });

  socket.on('buyCard', () => {
    if (!joined) return;
    const { room, playerId } = joined;
    const r = room.game.buyCard(playerId);
    if (r.error) return fail(r.error);
    room.touch();
    room.clearTimer();
    room.broadcast();
  });

  socket.on('stealBid', ({ gap } = {}) => {
    if (!joined) return;
    const { room, playerId } = joined;
    const r = room.game.stealBid(playerId, gap);
    if (r.error) return fail(r.error);
    room.touch();
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
    room.touch();
    room.broadcast();
  });

  socket.on('nextTurn', () => {
    if (!joined) return;
    const { room, playerId } = joined;
    const g = room.game;
    // Puede avanzar el anfitrión o el jugador que acaba de jugar.
    const lastPlayerId = g.lastResult ? g.lastResult.playerId : null;
    if (playerId !== room.hostId && playerId !== lastPlayerId) {
      return fail('Espera al anfitrión');
    }
    const r = g.nextTurn();
    if (r.error) return fail(r.error);
    room.touch();
    startTurn(room);
  });

  socket.on('playAgain', () => {
    if (!joined) return;
    const { room, playerId } = joined;
    if (playerId !== room.hostId) return fail('Solo el anfitrión puede reiniciar');
    if (room.game.phase !== 'gameover') return;
    const old = room.game;
    room.game = new Game(SONGS, old.settings);
    for (const p of old.players) {
      if (p.connected) room.game.addPlayer(p.id, p.name);
    }
    room.clearTimer();
    room.audio = null;
    room.touch();
    room.broadcast();
  });

  socket.on('disconnect', () => {
    if (joinedScreen) joinedScreen.screens.delete(socket);
    if (!joined) return;
    const { room, playerId } = joined;
    if (room.sockets.get(playerId) === socket) room.sockets.delete(playerId);
    const p = room.game.player(playerId);
    if (p) p.connected = false;
    if (room.game.phase === 'lobby') {
      // Periodo de gracia: si no vuelve en 60 s, se le saca del lobby.
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
    } else if (room.hostId === playerId) {
      const next = room.game.players.find((q) => q.connected);
      if (next) room.hostId = next.id;
    }
    room.broadcast();
  });
});

server.listen(PORT, () => {
  console.log(`🎵 Hitser escuchando en http://localhost:${PORT}`);
  console.log(
    spotify.isConfigured()
      ? '🟢 Spotify activado: canciones vía embed oficial (completas con sesión iniciada)'
      : '⚪ Spotify no configurado (define SPOTIFY_CLIENT_ID y SPOTIFY_CLIENT_SECRET); se usan previews de iTunes'
  );
  warmupPreviews().catch(() => {});
});
