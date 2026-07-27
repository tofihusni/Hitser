# 🎵 Hitser — El juego musical multijugador

Versión digital del juego de cartas musical tipo **Hitster**: escucha una canción,
adivina **en qué año salió** y colócala en tu línea de tiempo. Cada jugador juega
**desde su propio teléfono** conectándose a una sala con un código de 4 letras.

## Cómo se juega

1. Un jugador **crea la sala** y comparte el código de 4 letras.
2. Los demás entran desde su móvil en la misma dirección y **se unen con el código**.
3. Suena una canción y hay que colocarla en la posición cronológica correcta de
   **tu línea de tiempo**: ✅ aciertas → te quedas la carta.
4. **Gana** quien primero complete su línea de tiempo (10 cartas por defecto, configurable de 3 a 15).

### Dos modos de juego

- **🎉 Todos a la vez** (por defecto): cada ronda suena UNA canción y **todos los
  jugadores la colocan a la vez** en su propia línea. Nadie espera turnos, la
  revelación llega en cuanto el último coloca, y **el más rápido en acertar gana
  +1 ficha**. Todos pueden intentar el bonus de artista+título cada ronda.
- **🎙 Por turnos** (clásico, como el juego de mesa): en tu turno colocas tú;
  los demás pueden **robarte la carta** (1 🪙) si creen que fallaste, y puedes
  cambiar de canción (1 🪙) o comprarla (3 🪙).

### Fichas 🪙 (como en el juego original)

- **Ganar fichas**: durante tu turno, adivina **artista y título** de la canción (+1 ficha).
- **Cambiar canción** (1 🪙): no conoces la canción, pide otra.
- **Robar** (1 🪙): cuando otro jugador coloca su carta, apuesta a que falló y elige
  dónde iría en **tu** línea. Si él falla y tú aciertas, la carta es tuya.
- **Comprarla** (3 🪙): la carta se coloca automáticamente en el lugar correcto.

Cada jugador empieza con 1 carta y 2 fichas. De 2 a 10 jugadores.

### Opciones de partida (las elige el anfitrión)

- **Cartas para ganar**: de 3 a 15.
- **Tiempo por turno**: 90 s / 60 s / 30 s.
- **Precisión del año**: exacta o ±2 años (modo casual).
- **Canciones**: todas, clásicos (≤1989), 90s·2000s, o 2010 en adelante — y
  filtro de **solo canciones en español**.
- **Robos** activables o no.

### Ambiente de fiesta

Avatares emoji, anuncio animado de turno, cartas coloreadas por década con
huecos que muestran el rango de años, **reacciones en vivo** que flotan en
todas las pantallas, confeti en aciertos/robos/victoria, efectos de sonido
sintetizados (silenciables), vibración en tu turno, **QR en el lobby** para
unirse escaneando, y estadísticas por jugador al final (aciertos, robos y
fichas ganadas).

### 📺 Modo pantalla (TV)

Abre el juego en una tele, proyector o portátil, pulsa **«Modo pantalla (TV)»**
e introduce el código de la sala: verás el código en grande, las líneas de
tiempo de **todos** los jugadores, el turno en curso y las revelaciones, y
podrás reproducir la música para toda la habitación. La pantalla no juega,
puede unirse en cualquier momento y se reengancha sola si se recarga.

## Ejecutar

```bash
npm install
npm start          # http://localhost:3000
```

Para jugar con teléfonos en la misma red local, abre `http://IP-DE-TU-PC:3000`
desde cada móvil. Para jugar por internet, despliega en cualquier servicio Node
(Railway, Render, Fly.io, un VPS…) — no necesita base de datos ni claves de API.

## Audio

Hay tres niveles, y el juego elige automáticamente el mejor disponible:

1. **Spotify** (opcional, recomendado) — canciones vía el **embed oficial de
   Spotify**, oculto durante el turno para no desvelar la canción y controlado
   por el botón de play del juego. Si el navegador que reproduce (la TV o un
   móvil) tiene la sesión de Spotify iniciada, suena la **canción completa**;
   si no, un preview de 30 s. Los jugadores no necesitan iniciar sesión ni
   tener Premium. En la revelación el reproductor se muestra con su carátula.
2. **iTunes** (por defecto, sin configurar nada) — previews de 30 s de la API
   pública de iTunes, con caché y precarga al arrancar.
3. **Modo pista** (respaldo automático) — si no hay audio disponible, se
   muestra el título y el artista y solo hay que acertar el año (sin bonus de
   adivinanza, porque la respuesta está a la vista).

### Activar Spotify

1. Entra en <https://developer.spotify.com/dashboard> (cuenta gratuita) y crea
   una app; copia su **Client ID** y **Client Secret**.
2. Arranca el servidor con esas credenciales:

```bash
SPOTIFY_CLIENT_ID=tu_client_id SPOTIFY_CLIENT_SECRET=tu_client_secret npm start
```

El servidor solo usa las credenciales para buscar el ID de cada canción
(flujo *client credentials*, sin datos de usuarios); la reproducción ocurre en
el navegador con el embed oficial. Si Spotify no responde, se cae a iTunes o
al modo pista sin cortar la partida.

## Tecnología

- **Servidor**: Node.js + Express + Socket.IO (salas, turnos, temporizadores, reconexión).
- **Cliente**: HTML/CSS/JS vanilla, mobile-first, una sola página.
- **Lógica de juego**: módulo puro (`lib/game.js`) con tests (`npm test`).
- **Canciones**: ~120 éxitos de los años 50 a los 2020 (internacionales y en español)
  en `data/songs.js` — añade los tuyos con `{ title, artist, year }`.

## Detalles anti-trampas y robustez

- El año de la carta en juego **nunca** se envía a los clientes hasta la revelación.
- Sesiones con secreto por jugador: si se te apaga la pantalla o pierdes cobertura,
  **te reconectas automáticamente** y sigues donde estabas.
- Temporizadores de turno (60 s) y de robo (15 s) para que nadie bloquee la partida.
- Las salas inactivas se limpian solas a las 2 horas.

## Despliegue en internet

El servidor necesita un hosting con **Node.js y WebSockets persistentes**
(Render, Railway, Fly.io, un VPS…). No sirve un hosting «serverless» puro
(Vercel/Netlify functions) porque las salas viven en memoria con Socket.IO.

### Render (gratis, ~5 minutos)

1. Entra en <https://render.com> y crea una cuenta (vale con GitHub).
2. **New +** → **Blueprint** → conecta este repositorio (`tofihusni/Hitser`).
3. Render lee `render.yaml` y crea el servicio solo. Pulsa **Apply**.
4. Al terminar tendrás una URL `https://hitser-XXXX.onrender.com` — compártela
   y a jugar. (En el plan gratuito, el primer arranque tras un rato inactivo
   tarda ~30 s.)
5. Opcional: en **Environment** añade `SPOTIFY_CLIENT_ID` y
   `SPOTIFY_CLIENT_SECRET` para activar la música vía Spotify.

### Railway / Fly.io / VPS

También incluye un `Dockerfile`, así que cualquier plataforma que ejecute
contenedores funciona: `docker build -t hitser . && docker run -p 3000:3000 hitser`.

## Tests

```bash
npm test           # 19 tests de la lógica del juego
```
