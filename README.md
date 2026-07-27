# 🎵 Hitser — El juego musical multijugador

Versión digital del juego de cartas musical tipo **Hitster**: escucha una canción,
adivina **en qué año salió** y colócala en tu línea de tiempo. Cada jugador juega
**desde su propio teléfono** conectándose a una sala con un código de 4 letras.

## Cómo se juega

1. Un jugador **crea la sala** y comparte el código de 4 letras.
2. Los demás entran desde su móvil en la misma dirección y **se unen con el código**.
3. En tu turno suena una canción (preview de 30 segundos). Debes colocar la carta
   en la posición cronológica correcta de **tu línea de tiempo**.
   - ✅ Aciertas → te quedas la carta.
   - ❌ Fallas → la carta se pierde… ¡o te la roban!
4. **Gana** quien primero complete su línea de tiempo (10 cartas por defecto, configurable de 3 a 15).

### Fichas 🪙 (como en el juego original)

- **Ganar fichas**: durante tu turno, adivina **artista y título** de la canción (+1 ficha).
- **Cambiar canción** (1 🪙): no conoces la canción, pide otra.
- **Robar** (1 🪙): cuando otro jugador coloca su carta, apuesta a que falló y elige
  dónde iría en **tu** línea. Si él falla y tú aciertas, la carta es tuya.
- **Comprarla** (3 🪙): la carta se coloca automáticamente en el lugar correcto.

Cada jugador empieza con 1 carta y 2 fichas. De 2 a 10 jugadores.

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

Las canciones suenan con **previews de 30 s de la API pública de iTunes** (sin
claves ni cuentas). Los resultados se cachean en memoria y se precargan al
arrancar. Si una canción no tiene preview disponible (o no hay salida a
internet), el juego pasa automáticamente a **modo pista**: muestra el título y
el artista, y solo hay que acertar el año (en ese modo no hay bonus de
adivinanza).

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

## Tests

```bash
npm test           # 19 tests de la lógica del juego
```
