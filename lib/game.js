'use strict';

// Lógica pura del juego Hitser (sin red ni E/S) para poder testearla.

const DEFAULTS = {
  mode: 'simul', // simul = todos colocan a la vez cada ronda; classic = por turnos
  targetCards: 10,
  allowSteal: true,
  placeSeconds: 60,
  stealSeconds: 15,
  revealSeconds: 20, // auto-avance tras la revelación para que nada se atasque
  yearMargin: 0, // 0 = precisión exacta; 2 = se admite un error de ±2 años
  era: 'all', // all | classic (≤1989) | middle (1990-2009) | modern (≥2010)
  lang: 'all', // all | es (solo canciones en español)
};

const ERAS = {
  all: [0, 9999],
  classic: [0, 1989],
  middle: [1990, 2009],
  modern: [2010, 9999],
};

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Normaliza texto para comparar respuestas: minúsculas, sin acentos,
// sin paréntesis ("(Remastered)"), sin signos.
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9ñ ]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

// Coincidencia flexible: igual, contenida, o distancia de edición pequeña.
function fuzzyMatch(guess, answer) {
  const g = normalize(guess);
  const a = normalize(answer);
  if (!g || !a) return false;
  if (g === a) return true;
  if (a.includes(g) && g.length >= Math.min(4, a.length)) return true;
  if (g.includes(a)) return true;
  const dist = levenshtein(g, a);
  return dist <= Math.max(1, Math.floor(a.length * 0.25));
}

// Una carta cabe en el hueco `gap` (0..timeline.length) si su año está entre
// los vecinos. Años iguales cuentan como válidos por cualquiera de los lados,
// y `margin` añade tolerancia de ± años (modo casual).
function isCorrectGap(timeline, gap, year, margin = 0) {
  const before = gap > 0 ? timeline[gap - 1].year : -Infinity;
  const after = gap < timeline.length ? timeline[gap].year : Infinity;
  return before - margin <= year && year <= after + margin;
}

// Todos los huecos válidos (por si hay años repetidos hay varios).
function correctGaps(timeline, year) {
  const gaps = [];
  for (let g = 0; g <= timeline.length; g++) {
    if (isCorrectGap(timeline, g, year)) gaps.push(g);
  }
  return gaps;
}

function insertCard(timeline, card) {
  const gaps = correctGaps(timeline, card.year);
  const g = gaps[gaps.length - 1];
  timeline.splice(g, 0, card);
}

class Game {
  constructor(songs, options = {}, rng = Math.random) {
    this.settings = { ...DEFAULTS, ...options };
    this.rng = rng;
    this.songs = songs;
    this.players = []; // { id, name, timeline: [], tokens, connected }
    this.phase = 'lobby'; // lobby | placing | steal | reveal | gameover
    this.deck = [];
    this.turn = 0; // índice del jugador activo
    this.round = 0;
    this.currentCard = null;
    this.placedGap = null;
    this.guess = null; // { artist, title }
    this.guessResult = null;
    this.stealBids = []; // [{ playerId, gap }]
    this.lastResult = null;
    this.winnerId = null;
    this.clueShown = false;
    // Modo simultáneo (también válidos en el lobby, antes de la primera ronda)
    this.placements = new Map();
    this.playerGuesses = new Map();
    this.placeSeq = 0;
  }

  addPlayer(id, name, avatar) {
    if (this.phase !== 'lobby') return null;
    if (this.players.length >= 10) return null;
    const p = {
      id,
      name,
      avatar: avatar || '🎧',
      timeline: [],
      tokens: 0,
      connected: true,
      stats: { correct: 0, wrong: 0, steals: 0, tokensEarned: 0 },
    };
    this.players.push(p);
    return p;
  }

  removePlayer(id) {
    const i = this.players.findIndex((p) => p.id === id);
    if (i === -1) return;
    if (this.phase === 'lobby') {
      this.players.splice(i, 1);
      return;
    }
    this.players[i].connected = false;
  }

  player(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  get activePlayer() {
    return this.players[this.turn] || null;
  }

  // Índices de canciones permitidos por los filtros de época e idioma.
  allowedIndices() {
    const [min, max] = ERAS[this.settings.era] || ERAS.all;
    return this.songs
      .map((_, i) => i)
      .filter((i) => {
        const s = this.songs[i];
        if (s.year < min || s.year > max) return false;
        if (this.settings.lang === 'es' && !s.es) return false;
        return true;
      });
  }

  start() {
    if (this.players.length < 2) return { error: 'Se necesitan al menos 2 jugadores' };
    const allowed = this.allowedIndices();
    if (allowed.length < 25) return { error: 'Ese filtro deja muy pocas canciones' };
    this.deck = shuffle(allowed, this.rng);
    // Cada jugador empieza con una carta inicial en su línea de tiempo.
    for (const p of this.players) {
      p.timeline = [this.drawCard()];
      p.tokens = 2; // arranque con 2 fichas para que las mecánicas entren en juego pronto
      p.stats = { correct: 0, wrong: 0, steals: 0, tokensEarned: 0 };
    }
    this.turn = Math.floor(this.rng() * this.players.length);
    this.round = 1;
    this.beginTurn();
    return { ok: true };
  }

  drawCard() {
    if (this.deck.length === 0) {
      // Rebaraja: reutiliza canciones no presentes en ninguna línea de tiempo actual.
      const used = new Set();
      for (const p of this.players) for (const c of p.timeline) used.add(c.songIndex);
      const allowed = this.allowedIndices();
      const rest = allowed.filter((i) => !used.has(i));
      this.deck = shuffle(rest.length ? rest : allowed, this.rng);
    }
    const songIndex = this.deck.pop();
    const s = this.songs[songIndex];
    return { songIndex, title: s.title, artist: s.artist, year: s.year };
  }

  beginTurn() {
    this.currentCard = this.drawCard();
    this.placedGap = null;
    this.guess = null;
    this.guessResult = null;
    this.stealBids = [];
    this.lastResult = null;
    this.clueShown = false; // sin audio: se enseña título/artista y no hay bonus
    // Modo simultáneo: colocaciones y respuestas de bonus de TODOS los jugadores.
    this.placements = new Map(); // playerId -> { gap, bought, seq }
    this.playerGuesses = new Map(); // playerId -> { artist, title }
    this.placeSeq = 0;
    this.phase = 'placing';
  }

  // ── Modo simultáneo: todos colocan a la vez en su propia línea ────────────

  placeSimul(playerId, gap) {
    if (this.phase !== 'placing') return { error: 'Ahora no se puede' };
    const p = this.player(playerId);
    if (!p) return { error: 'Jugador desconocido' };
    if (this.placements.has(playerId)) return { error: 'Ya colocaste tu carta' };
    gap = Number(gap);
    if (!Number.isInteger(gap) || gap < 0 || gap > p.timeline.length) {
      return { error: 'Posición no válida' };
    }
    this.placements.set(playerId, { gap, bought: false, seq: this.placeSeq++ });
    return { ok: true };
  }

  // Pagar 3 fichas para colocar sobre seguro (cuenta como colocación).
  buySimul(playerId) {
    if (this.phase !== 'placing') return { error: 'Ahora no se puede' };
    const p = this.player(playerId);
    if (!p) return { error: 'Jugador desconocido' };
    if (this.placements.has(playerId)) return { error: 'Ya colocaste tu carta' };
    if (p.tokens < 3) return { error: 'Necesitas 3 fichas' };
    p.tokens -= 3;
    this.placements.set(playerId, { gap: null, bought: true, seq: this.placeSeq++ });
    return { ok: true };
  }

  guessSimul(playerId, artist, title) {
    if (this.phase !== 'placing') return { error: 'Ahora no se puede' };
    if (!this.player(playerId)) return { error: 'Jugador desconocido' };
    this.playerGuesses.set(playerId, {
      artist: String(artist || ''),
      title: String(title || ''),
    });
    return { ok: true };
  }

  allPlaced() {
    return this.players.every((p) => !p.connected || this.placements.has(p.id));
  }

  revealSimul() {
    if (this.phase !== 'placing') return { error: 'Ahora no se puede' };
    const card = this.currentCard;
    const margin = this.settings.yearMargin || 0;
    const results = [];

    // El más rápido en colocar bien (sin comprar) gana una ficha extra.
    let firstCorrect = null;
    for (const [playerId, pl] of this.placements) {
      const p = this.player(playerId);
      if (!p) continue;
      const correct = pl.bought || isCorrectGap(p.timeline, pl.gap, card.year, margin);
      if (correct && !pl.bought && (firstCorrect === null || pl.seq < firstCorrect.seq)) {
        firstCorrect = { playerId, seq: pl.seq };
      }
      results.push({ playerId, gap: pl.gap, bought: pl.bought, correct });
    }

    for (const r of results) {
      const p = this.player(r.playerId);
      if (r.correct) {
        insertCard(p.timeline, { ...card });
        p.stats.correct += 1;
      } else {
        p.stats.wrong += 1;
      }
      r.firstBonus = firstCorrect !== null && firstCorrect.playerId === r.playerId;
      if (r.firstBonus) {
        p.tokens += 1;
        p.stats.tokensEarned += 1;
      }
      // Bonus por adivinar artista y título (sin audio no hay bonus).
      r.guessTokenWon = false;
      const g = this.playerGuesses.get(r.playerId);
      if (g && !this.clueShown) {
        const artistOk = fuzzyMatch(g.artist, card.artist);
        const titleOk = fuzzyMatch(g.title, card.title);
        if (artistOk && titleOk) {
          r.guessTokenWon = true;
          p.tokens += 1;
          p.stats.tokensEarned += 1;
        }
      }
    }

    this.lastResult = { type: 'simul', card, results };
    this.phase = 'reveal';
    // Victoria: más cartas; empate → más fichas; último empate → orden de mesa.
    const reached = this.players.filter((p) => p.timeline.length >= this.settings.targetCards);
    if (reached.length) {
      reached.sort(
        (a, b) => b.timeline.length - a.timeline.length || b.tokens - a.tokens
      );
      this.winnerId = reached[0].id;
      this.phase = 'gameover';
    }
    return { ok: true, result: this.lastResult };
  }

  // El jugador activo paga 1 ficha para cambiar de canción.
  skipSong(playerId) {
    if (this.phase !== 'placing') return { error: 'Ahora no se puede' };
    const p = this.activePlayer;
    if (!p || p.id !== playerId) return { error: 'No es tu turno' };
    if (p.tokens < 1) return { error: 'No tienes fichas' };
    p.tokens -= 1;
    this.currentCard = this.drawCard();
    this.guess = null;
    return { ok: true };
  }

  // El jugador activo paga 3 fichas y la carta se coloca sola (garantizada).
  buyCard(playerId) {
    if (this.phase !== 'placing') return { error: 'Ahora no se puede' };
    const p = this.activePlayer;
    if (!p || p.id !== playerId) return { error: 'No es tu turno' };
    if (p.tokens < 3) return { error: 'Necesitas 3 fichas' };
    p.tokens -= 3;
    insertCard(p.timeline, this.currentCard);
    p.stats.correct += 1;
    this.lastResult = {
      type: 'buy',
      playerId: p.id,
      card: this.currentCard,
      correct: true,
      guessResult: null,
      stealWinnerId: null,
    };
    this.phase = 'reveal';
    this.checkWin();
    return { ok: true };
  }

  setGuess(playerId, artist, title) {
    if (this.phase !== 'placing' && this.phase !== 'steal') return { error: 'Ahora no se puede' };
    const p = this.activePlayer;
    if (!p || p.id !== playerId) return { error: 'No es tu turno' };
    this.guess = { artist: String(artist || ''), title: String(title || '') };
    return { ok: true };
  }

  placeCard(playerId, gap) {
    if (this.phase !== 'placing') return { error: 'Ahora no se puede' };
    const p = this.activePlayer;
    if (!p || p.id !== playerId) return { error: 'No es tu turno' };
    gap = Number(gap);
    if (!Number.isInteger(gap) || gap < 0 || gap > p.timeline.length) {
      return { error: 'Posición no válida' };
    }
    this.placedGap = gap;
    // ¿Hay alguien que pueda robar? Si no, se revela directamente.
    const canSteal =
      this.settings.allowSteal &&
      this.players.some((q) => q.id !== p.id && q.connected && q.tokens >= 1);
    if (canSteal) {
      this.phase = 'steal';
      return { ok: true, phase: 'steal' };
    }
    return this.reveal();
  }

  // Otro jugador paga 1 ficha y apuesta a que el activo falló,
  // eligiendo el hueco en SU propia línea de tiempo.
  stealBid(playerId, gap) {
    if (this.phase !== 'steal') return { error: 'Ahora no se puede' };
    const p = this.player(playerId);
    if (!p) return { error: 'Jugador desconocido' };
    if (p.id === this.activePlayer.id) return { error: 'No puedes robarte a ti mismo' };
    if (this.stealBids.some((b) => b.playerId === playerId)) return { error: 'Ya has apostado' };
    if (p.tokens < 1) return { error: 'No tienes fichas' };
    gap = Number(gap);
    if (!Number.isInteger(gap) || gap < 0 || gap > p.timeline.length) {
      return { error: 'Posición no válida' };
    }
    p.tokens -= 1;
    this.stealBids.push({ playerId, gap });
    return { ok: true };
  }

  reveal() {
    if (this.phase !== 'placing' && this.phase !== 'steal') return { error: 'Ahora no se puede' };
    const p = this.activePlayer;
    const card = this.currentCard;
    const margin = this.settings.yearMargin || 0;
    const correct = isCorrectGap(p.timeline, this.placedGap, card.year, margin);

    // Bonus por adivinar artista y título (se gana aunque falles la colocación).
    // Sin audio la pista ya muestra la respuesta, así que no hay bonus.
    let guessResult = null;
    if (this.guess && !this.clueShown) {
      const artistOk = fuzzyMatch(this.guess.artist, card.artist);
      const titleOk = fuzzyMatch(this.guess.title, card.title);
      guessResult = { artistOk, titleOk, tokenWon: artistOk && titleOk };
      if (guessResult.tokenWon) {
        p.tokens += 1;
        p.stats.tokensEarned += 1;
      }
    }

    let stealWinnerId = null;
    if (correct) {
      // Se inserta en su posición ordenada (con margen, el hueco elegido
      // podría desordenar la línea de tiempo).
      insertCard(p.timeline, card);
      p.stats.correct += 1;
    } else {
      p.stats.wrong += 1;
      // El primero que apostó con un hueco correcto en SU línea se lleva la carta.
      for (const bid of this.stealBids) {
        const q = this.player(bid.playerId);
        if (q && isCorrectGap(q.timeline, bid.gap, card.year, margin)) {
          insertCard(q.timeline, card);
          stealWinnerId = q.id;
          q.stats.steals += 1;
          break;
        }
      }
    }

    this.lastResult = {
      type: 'place',
      playerId: p.id,
      card,
      gap: this.placedGap,
      correct,
      guessResult,
      stealBids: this.stealBids.map((b) => ({ ...b })),
      stealWinnerId,
    };
    this.phase = 'reveal';
    this.checkWin();
    return { ok: true, result: this.lastResult };
  }

  checkWin() {
    // El jugador activo tiene prioridad si varios llegan a la meta a la vez.
    const t = this.settings.targetCards;
    const inOrder = [this.activePlayer, ...this.players.filter((p) => p !== this.activePlayer)];
    for (const p of inOrder) {
      if (p.timeline.length >= t) {
        this.winnerId = p.id;
        this.phase = 'gameover';
        return true;
      }
    }
    return false;
  }

  nextTurn() {
    if (this.phase !== 'reveal') return { error: 'Ahora no se puede' };
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const idx = (this.turn + i) % n;
      if (this.players[idx].connected) {
        this.turn = idx;
        break;
      }
    }
    this.round += 1;
    this.beginTurn();
    return { ok: true };
  }

  // Estado visible para un jugador concreto (oculta el año de la carta actual).
  viewFor(playerId) {
    const revealCard = this.phase === 'reveal' || this.phase === 'gameover';
    const simul = this.settings.mode === 'simul';
    const myPlacement = simul && playerId ? this.placements.get(playerId) || null : null;
    return {
      phase: this.phase,
      round: this.round,
      settings: this.settings,
      turnPlayerId: !simul && this.activePlayer ? this.activePlayer.id : null,
      placedIds: simul ? [...this.placements.keys()] : [],
      myPlacement: myPlacement ? { gap: myPlacement.gap, bought: myPlacement.bought } : null,
      myGuessSubmitted: simul && playerId ? this.playerGuesses.has(playerId) : false,
      placedGap: this.placedGap,
      currentCard: this.currentCard
        ? revealCard
          ? { ...this.currentCard }
          : this.clueShown
            ? { hidden: true, title: this.currentCard.title, artist: this.currentCard.artist }
            : { hidden: true }
        : null,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        tokens: p.tokens,
        connected: p.connected,
        cards: p.timeline.length,
        timeline: p.timeline.map((c) => ({ ...c })),
        stats: { ...p.stats },
      })),
      you: playerId,
      guessSubmitted: !!this.guess,
      stealBids: this.stealBids.map((b) => ({ playerId: b.playerId })),
      lastResult: this.lastResult,
      winnerId: this.winnerId,
    };
  }
}

module.exports = { Game, DEFAULTS, ERAS, shuffle, normalize, fuzzyMatch, isCorrectGap, correctGaps, insertCard, levenshtein };
