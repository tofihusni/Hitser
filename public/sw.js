'use strict';

// Service worker de Hitser — deliberadamente MÍNIMO.
//
// El juego es multijugador en tiempo real: sin servidor no hay partida, así
// que una caché offline no aporta nada… y sí puede romper cosas. Cachear el
// HTML y el JS provocaba que un index.html antiguo se sirviera junto a un
// client.js nuevo (o al revés), y con los elementos desparejados la interfaz
// dejaba de responder. Por eso aquí NO se cachea nada del juego: solo se
// mantiene el registro para que la app sea instalable.
const CACHE = 'hitser-v2';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  // Borra cualquier caché de versiones anteriores (incluida hitser-v1).
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Sin manejador de 'fetch': todas las peticiones van directas a la red, como
// si no hubiera service worker. Así HTML y JS nunca se desincronizan.
