'use strict';

// Integración opcional con Spotify (Web API, flujo client-credentials).
// Se activa definiendo SPOTIFY_CLIENT_ID y SPOTIFY_CLIENT_SECRET (una app
// gratuita creada en https://developer.spotify.com/dashboard). El servidor
// solo la usa para buscar el ID del track; la reproducción la hace el
// cliente con el embed oficial de Spotify.

class Spotify {
  constructor(fetchFn = globalThis.fetch, env = process.env) {
    this.fetch = fetchFn;
    this.clientId = env.SPOTIFY_CLIENT_ID || '';
    this.clientSecret = env.SPOTIFY_CLIENT_SECRET || '';
    this.token = null;
    this.tokenExpiresAt = 0;
    this.cache = new Map(); // "artista|título" -> { trackId, artworkUrl } | null
  }

  isConfigured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 30_000) return this.token;
    const res = await this.fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:
          'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64'),
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`token HTTP ${res.status}`);
    const data = await res.json();
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return this.token;
  }

  async findTrack(song) {
    const key = `${song.artist}|${song.title}`;
    if (this.cache.has(key)) return this.cache.get(key);
    try {
      const token = await this.getToken();
      const q = encodeURIComponent(`track:${song.title} artist:${song.artist}`);
      const res = await this.fetch(
        `https://api.spotify.com/v1/search?q=${q}&type=track&limit=5`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) throw new Error(`search HTTP ${res.status}`);
      const data = await res.json();
      const items = (data.tracks && data.tracks.items) || [];
      const norm = (x) => String(x || '').toLowerCase();
      // Prefiere resultados cuyo artista coincida con el buscado.
      const hit =
        items.find((t) =>
          (t.artists || []).some((a) => norm(a.name).includes(norm(song.artist).split(' ')[0]))
        ) || items[0];
      const images = (hit && hit.album && hit.album.images) || [];
      const out = hit
        ? { trackId: hit.id, artworkUrl: (images[1] || images[0] || {}).url || null }
        : null;
      this.cache.set(key, out);
      return out;
    } catch (err) {
      console.warn(`Spotify: sin track para "${song.title}" (${song.artist}): ${err.message}`);
      return null; // los errores no se cachean: se reintenta en el siguiente turno
    }
  }
}

module.exports = { Spotify };
