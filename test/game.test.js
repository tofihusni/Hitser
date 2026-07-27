'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { Game, fuzzyMatch, isCorrectGap, correctGaps, insertCard, normalize } = require('../lib/game');

// 60 canciones repartidas entre 1950 y 2009, la mitad marcadas en español.
const SONGS = Array.from({ length: 60 }, (_, i) => ({
  title: `Canción ${i}`,
  artist: `Artista ${i}`,
  year: 1950 + i,
  es: i % 2 === 0,
}));

// RNG determinista para tests reproducibles.
function seededRng(seed = 42) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function newGame(opts = {}) {
  const g = new Game(SONGS, { allowSteal: true, targetCards: 10, ...opts }, seededRng());
  g.addPlayer('p1', 'Ana');
  g.addPlayer('p2', 'Beto');
  return g;
}

test('normalize quita acentos y signos', () => {
  assert.strictEqual(normalize('Despácito! (Remix)'), 'despacito');
  assert.strictEqual(normalize('Y.M.C.A.'), 'y m c a');
});

test('fuzzyMatch acepta variantes razonables', () => {
  assert.ok(fuzzyMatch('shakira', 'Shakira'));
  assert.ok(fuzzyMatch('los del rio', 'Los del Río'));
  assert.ok(fuzzyMatch('bohemian rapsody', 'Bohemian Rhapsody'));
  assert.ok(fuzzyMatch('satisfaction', "(I Can't Get No) Satisfaction"));
  assert.ok(!fuzzyMatch('madonna', 'Michael Jackson'));
  assert.ok(!fuzzyMatch('', 'Queen'));
});

test('isCorrectGap: extremos y años iguales', () => {
  const tl = [{ year: 1970 }, { year: 1990 }];
  assert.ok(isCorrectGap(tl, 0, 1960));
  assert.ok(isCorrectGap(tl, 1, 1980));
  assert.ok(isCorrectGap(tl, 2, 2000));
  assert.ok(!isCorrectGap(tl, 0, 1980));
  assert.ok(!isCorrectGap(tl, 2, 1980));
  // Año igual a un vecino vale a ambos lados.
  assert.ok(isCorrectGap(tl, 0, 1970));
  assert.ok(isCorrectGap(tl, 1, 1970));
  assert.deepStrictEqual(correctGaps(tl, 1970), [0, 1]);
});

test('insertCard coloca ordenado', () => {
  const tl = [{ year: 1970 }, { year: 1990 }];
  insertCard(tl, { year: 1980 });
  assert.deepStrictEqual(tl.map((c) => c.year), [1970, 1980, 1990]);
});

test('no se puede empezar con menos de 2 jugadores', () => {
  const g = new Game(SONGS, {}, seededRng());
  g.addPlayer('p1', 'Ana');
  assert.ok(g.start().error);
});

test('start reparte carta inicial y fichas', () => {
  const g = newGame();
  assert.ok(g.start().ok);
  for (const p of g.players) {
    assert.strictEqual(p.timeline.length, 1);
    assert.strictEqual(p.tokens, 2);
  }
  assert.strictEqual(g.phase, 'placing');
  assert.ok(g.currentCard);
});

test('colocación correcta añade la carta; incorrecta no', () => {
  const g = newGame({ allowSteal: false });
  g.start();
  const p = g.activePlayer;
  const gaps = correctGaps(p.timeline, g.currentCard.year);
  const r = g.placeCard(p.id, gaps[0]);
  assert.ok(r.ok);
  assert.strictEqual(g.phase, 'reveal');
  assert.strictEqual(g.lastResult.correct, true);
  assert.strictEqual(p.timeline.length, 2);
});

test('solo el jugador activo puede colocar', () => {
  const g = newGame({ allowSteal: false });
  g.start();
  const otro = g.players.find((p) => p !== g.activePlayer);
  assert.ok(g.placeCard(otro.id, 0).error);
});

test('bonus de adivinanza da ficha con acierto flexible', () => {
  const g = newGame({ allowSteal: false });
  g.start();
  const p = g.activePlayer;
  const card = g.currentCard;
  g.setGuess(p.id, card.artist.toLowerCase(), card.title.toLowerCase());
  const tokensAntes = p.tokens;
  g.placeCard(p.id, correctGaps(p.timeline, card.year)[0]);
  assert.strictEqual(g.lastResult.guessResult.tokenWon, true);
  assert.strictEqual(p.tokens, tokensAntes + 1);
});

test('skip cuesta 1 ficha y cambia la canción', () => {
  const g = newGame({ allowSteal: false });
  g.start();
  const p = g.activePlayer;
  const before = g.currentCard;
  assert.ok(g.skipSong(p.id).ok);
  assert.strictEqual(p.tokens, 1);
  assert.notStrictEqual(g.currentCard, before);
  // Sin fichas suficientes falla.
  g.skipSong(p.id);
  assert.ok(g.skipSong(p.id).error);
});

test('buyCard cuesta 3 fichas y coloca garantizado', () => {
  const g = newGame({ allowSteal: false });
  g.start();
  const p = g.activePlayer;
  p.tokens = 3;
  assert.ok(g.buyCard(p.id).ok);
  assert.strictEqual(p.tokens, 0);
  assert.strictEqual(p.timeline.length, 2);
  assert.strictEqual(g.phase, 'reveal');
  // La línea queda ordenada.
  const years = p.timeline.map((c) => c.year);
  assert.deepStrictEqual(years, [...years].sort((a, b) => a - b));
});

test('robo: si el activo falla y el ladrón acierta, se lleva la carta', () => {
  const g = newGame();
  g.start();
  const p = g.activePlayer;
  const q = g.players.find((x) => x !== p);
  const wrong = correctGaps(p.timeline, g.currentCard.year).includes(0) ? null : 0;
  const wrongGap =
    wrong !== null ? 0 : p.timeline.length; // elige un hueco incorrecto seguro
  // fuerza un fallo: busca hueco no válido
  let bad = -1;
  for (let i = 0; i <= p.timeline.length; i++) {
    if (!isCorrectGap(p.timeline, i, g.currentCard.year)) { bad = i; break; }
  }
  if (bad === -1) {
    // La carta cabe en todos los huecos (línea de 1 carta con año igual): skip test
    return;
  }
  const r = g.placeCard(p.id, bad);
  assert.strictEqual(r.phase, 'steal');
  const goodGap = correctGaps(q.timeline, g.currentCard.year)[0];
  assert.ok(g.stealBid(q.id, goodGap).ok);
  assert.strictEqual(q.tokens, 1); // pagó 1
  g.reveal();
  assert.strictEqual(g.lastResult.correct, false);
  assert.strictEqual(g.lastResult.stealWinnerId, q.id);
  assert.strictEqual(q.timeline.length, 2);
  assert.strictEqual(p.timeline.length, 1);
});

test('robo: si el activo acierta, el ladrón pierde su ficha', () => {
  const g = newGame();
  g.start();
  const p = g.activePlayer;
  const q = g.players.find((x) => x !== p);
  const good = correctGaps(p.timeline, g.currentCard.year)[0];
  g.placeCard(p.id, good);
  if (g.phase === 'steal') {
    g.stealBid(q.id, 0);
    const tokens = q.tokens;
    g.reveal();
    assert.strictEqual(g.lastResult.correct, true);
    assert.strictEqual(g.lastResult.stealWinnerId, null);
    assert.strictEqual(q.tokens, tokens); // la ficha ya se descontó al apostar y no vuelve
    assert.strictEqual(q.timeline.length, 1);
  }
});

test('no se puede apostar dos veces ni robarse a sí mismo', () => {
  const g = newGame();
  g.start();
  const p = g.activePlayer;
  const q = g.players.find((x) => x !== p);
  let bad = -1;
  for (let i = 0; i <= p.timeline.length; i++) {
    if (!isCorrectGap(p.timeline, i, g.currentCard.year)) { bad = i; break; }
  }
  if (bad === -1) return;
  g.placeCard(p.id, bad);
  assert.ok(g.stealBid(p.id, 0).error);
  assert.ok(g.stealBid(q.id, 0).ok);
  assert.ok(g.stealBid(q.id, 0).error);
});

test('gana quien llega al objetivo', () => {
  const g = newGame({ allowSteal: false, targetCards: 2 });
  g.start();
  const p = g.activePlayer;
  const good = correctGaps(p.timeline, g.currentCard.year)[0];
  g.placeCard(p.id, good);
  assert.strictEqual(g.phase, 'gameover');
  assert.strictEqual(g.winnerId, p.id);
});

test('nextTurn rota entre jugadores conectados', () => {
  const g = newGame({ allowSteal: false });
  g.start();
  const first = g.activePlayer;
  g.placeCard(first.id, correctGaps(first.timeline, g.currentCard.year)[0]);
  g.nextTurn();
  assert.notStrictEqual(g.activePlayer, first);
  assert.strictEqual(g.phase, 'placing');
});

test('la baraja no repite canciones en juego y rebaraja al agotarse', () => {
  const g = newGame({ allowSteal: false, targetCards: 15 });
  g.start();
  // Vacía la baraja robando muchas cartas.
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const c = g.drawCard();
    assert.ok(c && typeof c.year === 'number');
    seen.add(c.songIndex);
  }
  assert.ok(seen.size > 1);
});

test('viewFor oculta el año de la carta actual hasta revelar', () => {
  const g = newGame({ allowSteal: false });
  g.start();
  const v = g.viewFor('p1');
  assert.deepStrictEqual(v.currentCard, { hidden: true });
  const p = g.activePlayer;
  g.placeCard(p.id, correctGaps(p.timeline, g.currentCard.year)[0]);
  const v2 = g.viewFor('p1');
  assert.ok(v2.currentCard.year);
});

test('margen de ±2 años admite fallos pequeños y mantiene la línea ordenada', () => {
  const g = newGame({ allowSteal: false, yearMargin: 2 });
  g.start();
  const p = g.activePlayer;
  // Construye una línea conocida y una carta que falla por 2 años.
  p.timeline = [{ songIndex: 0, title: 'x', artist: 'x', year: 1980 }];
  g.currentCard = { songIndex: 1, title: 'y', artist: 'y', year: 1982 };
  // Hueco 0 = "antes de 1980": incorrecto en exacto, correcto con margen 2.
  g.placeCard(p.id, 0);
  assert.strictEqual(g.lastResult.correct, true);
  const years = p.timeline.map((c) => c.year);
  assert.deepStrictEqual(years, [...years].sort((a, b) => a - b), 'la línea queda ordenada');
});

test('el filtro de idioma solo baraja canciones en español', () => {
  const g = newGame({ lang: 'es', allowSteal: false });
  assert.ok(g.start().ok);
  for (const i of g.deck) assert.ok(g.songs[i].es, 'canción no española en la baraja');
});

test('el filtro de época restringe los años', () => {
  const g = newGame({ era: 'classic', allowSteal: false });
  assert.ok(g.start().ok);
  for (const i of g.deck) assert.ok(g.songs[i].year <= 1989);
});

test('un filtro demasiado estrecho devuelve error', () => {
  const g = newGame({ era: 'modern' }); // el set de prueba llega solo a 2010
  assert.ok(g.start().error);
});

test('las estadísticas registran aciertos, fallos y robos', () => {
  const g = newGame();
  g.start();
  const p = g.activePlayer;
  const q = g.players.find((x) => x !== p);
  let bad = -1;
  for (let i = 0; i <= p.timeline.length; i++) {
    if (!isCorrectGap(p.timeline, i, g.currentCard.year)) { bad = i; break; }
  }
  if (bad === -1) return;
  g.placeCard(p.id, bad);
  const goodGap = correctGaps(q.timeline, g.currentCard.year)[0];
  g.stealBid(q.id, goodGap);
  g.reveal();
  assert.strictEqual(p.stats.wrong, 1);
  assert.strictEqual(q.stats.steals, 1);
});

test('las canciones reales tienen datos válidos', () => {
  const songs = require('../data/songs');
  assert.ok(songs.length >= 100);
  for (const s of songs) {
    assert.ok(s.title && s.artist, `${s.title}`);
    assert.ok(s.year >= 1950 && s.year <= 2026, `${s.title}: ${s.year}`);
  }
});
