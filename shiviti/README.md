# Shiviti Menorá — Tehilim 67

Archivo vectorial para **grabado láser, 80 × 100 cm** (800 × 1000 mm, vertical).
Rehecho sobre el diseño original, con el texto hebreo corregido.

## Qué estaba mal en el original

| # | Dónde | Original | Corregido |
|---|-------|----------|-----------|
| 1 | Encabezado (Teh. 67:1) | `בִּנְגִינַת` (patáj) | `בִּנְגִינֹת` (jolam) — la forma masorética |
| 2 | Último brazo (Teh. 67:8) | `ויראו` | `וייראו` — faltaba una yod |
| 3 | Nombre divino | `אלקים` / `אלקינו` | `אלהים` / `אלהינו` (texto pleno del salmo) |
| 4 | Reparto del texto | versos partidos a la mitad entre brazos | ver abajo |

El punto 3 es una decisión, no un error: `אלקים` es una sustitución para no
escribir el Nombre. Un shiviti normalmente lleva el texto pleno, así que ese es
el default. Si el cliente lo quiere con kuf: `SHIVITI_NAME=kuf`.

## Dos repartos del texto

* **`flujo`** (default, `shiviti-menorah-flujo.svg`) — el salmo corre continuo por
  los 7 recorridos, igual que el diseño original, pero los cortes caen siempre en
  palabra completa. Letra de 13.8 mm, interletrado parejo.
* **`versos`** (`shiviti-menorah-versos.svg`) — un versículo entero por brazo
  (v.2–v.8) y el v.5 completo en el tronco a dos columnas. Es el reparto que pide
  la tradición; obliga a un tronco más ancho y letra de 13.0 mm.

## Especificaciones del archivo

* 800 × 1000 mm, unidades en milímetros, `viewBox` 1:1 con la medida real.
* **Todo el texto está convertido a contornos** — no hace falta instalar
  ninguna fuente en la máquina.
* Capas: `GRABADO` (negro) y `CORTE` (rojo, rectángulo exterior).
* Grosor de línea del dibujo: 1.2 mm.
* Altura de letra en los brazos: 13.8 mm (`flujo`) / 13.0 mm (`versos`).
* Copa, base y ornamentos de esquina: vectorizados del diseño original.
* Tipografía: Frank Ruehl CLM (libre, proyecto Culmus) — la serif clásica de sidur.

## Regenerar

```sh
python3 generate.py                 # 800 x 1000 mm, reparto "flujo"
python3 generate.py 600 750         # otra medida, misma proporción
SHIVITI_LAYOUT=versos python3 generate.py
SHIVITI_NAME=kuf python3 generate.py
```

Requiere `uharfbuzz`, `fonttools` y la fuente Frank Ruehl CLM
(`apt install culmus`). Para exportar PDF/PNG: `cairosvg`.
