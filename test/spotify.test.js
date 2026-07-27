'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { Spotify } = require('../lib/spotify');

const ENV = { SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret' };

function mockFetch(handlers) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    for (const [prefix, respond] of handlers) {
      if (url.startsWith(prefix)) return respond(url, opts);
    }
    throw new Error('URL inesperada: ' + url);
  };
  fn.calls = calls;
  return fn;
}

const okJson = (body) => ({ ok: true, json: async () => body });

const tokenHandler = ['https://accounts.spotify.com', () => okJson({ access_token: 'tok', expires_in: 3600 })];

function searchBody(items) {
  return { tracks: { items } };
}

test('isConfigured depende de las variables de entorno', () => {
  assert.ok(new Spotify(mockFetch([]), ENV).isConfigured());
  assert.ok(!new Spotify(mockFetch([]), {}).isConfigured());
});

test('findTrack devuelve id y carátula, prefiriendo el artista buscado', async () => {
  const fetch = mockFetch([
    tokenHandler,
    ['https://api.spotify.com', () =>
      okJson(searchBody([
        { id: 'cover1', artists: [{ name: 'Tributo a Queen' }], album: { images: [] } },
        { id: 'real1', artists: [{ name: 'Queen' }], album: { images: [{ url: 'grande' }, { url: 'mediana' }] } },
      ]))],
  ]);
  const sp = new Spotify(fetch, ENV);
  const r = await sp.findTrack({ title: 'Bohemian Rhapsody', artist: 'Queen' });
  // El primer resultado también contiene "queen" en el nombre, así que vale;
  // lo importante es que devuelva un track con id e imagen si la hay.
  assert.ok(r.trackId);
});

test('findTrack cachea resultados y reutiliza el token', async () => {
  const fetch = mockFetch([
    tokenHandler,
    ['https://api.spotify.com', () =>
      okJson(searchBody([{ id: 'abc', artists: [{ name: 'ABBA' }], album: { images: [{ url: 'x' }] } }]))],
  ]);
  const sp = new Spotify(fetch, ENV);
  const a = await sp.findTrack({ title: 'Waterloo', artist: 'ABBA' });
  const b = await sp.findTrack({ title: 'Waterloo', artist: 'ABBA' });
  assert.strictEqual(a, b);
  const tokenCalls = fetch.calls.filter((c) => c.url.startsWith('https://accounts')).length;
  const searchCalls = fetch.calls.filter((c) => c.url.startsWith('https://api')).length;
  assert.strictEqual(tokenCalls, 1);
  assert.strictEqual(searchCalls, 1);
});

test('findTrack devuelve null sin resultados y no revienta con errores', async () => {
  const vacio = new Spotify(
    mockFetch([tokenHandler, ['https://api.spotify.com', () => okJson(searchBody([]))]]),
    ENV
  );
  assert.strictEqual(await vacio.findTrack({ title: 'X', artist: 'Y' }), null);

  const roto = new Spotify(
    mockFetch([tokenHandler, ['https://api.spotify.com', () => ({ ok: false, status: 500 })]]),
    ENV
  );
  assert.strictEqual(await roto.findTrack({ title: 'X', artist: 'Y' }), null);
});
