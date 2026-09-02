#!/usr/bin/env python3
"""Shiviti Menorah - Tehilim 67. Generador vectorial para grabado laser.

Todo el texto sale como contornos (paths): el archivo no depende de que la
fuente este instalada en la maquina del laser.

Uso:  python3 generate.py [ancho_mm] [alto_mm]
Var:  SHIVITI_NAME=pleno|kuf     (אלהים  /  אלקים)
"""
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hebrew import ArcPath, Font, fmt, text_on_path, text_straight  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
FONT_PATH = "/usr/share/fonts/truetype/culmus/FrankRuehlCLM-Medium.ttf"

# ---------------------------------------------------------------- texto ----
TITLE_1 = "שִׁוִּיתִי ה׳ לְנֶגְדִּי"
TITLE_2 = "תָּמִיד"
TITLE_3 = "לַמְנַצֵּחַ בִּנְגִינֹת מִזְמוֹר שִׁיר"   # v.1  (בִּנְגִינֹת, no בנגינת)

_NAMES = {"pleno": ("אלהים", "אלהינו"), "kuf": ("אלקים", "אלקינו")}
E, E2 = _NAMES[os.environ.get("SHIVITI_NAME", "pleno")]

# Tehilim 67:2-8 -- un versiculo completo por brazo, v.5 entero en el tronco.
V = {
    2: f"{E} יחננו ויברכנו יאר פניו אתנו סלה",
    3: "לדעת בארץ דרכך בכל גוים ישועתך",
    4: f"יודוך עמים {E} יודוך עמים כלם",
    5: "ישמחו וירננו לאמים כי תשפט עמים מישור ולאמים בארץ תנחם סלה",
    6: f"יודוך עמים {E} יודוך עמים כלם",
    7: f"ארץ נתנה יבולה יברכנו {E} {E2}",
    8: f"יברכנו {E} וייראו אותו כל אפסי ארץ",
}
# v.5 va en el tronco, en dos columnas partidas en el atnaj (la cesura del verso).
V5_COLS = ["ישמחו וירננו לאמים כי תשפט עמים מישור", "ולאמים בארץ תנחם סלה"]

# Orden de lectura del original: brazo externo derecho -> ... -> tronco -> ... -> izquierdo.
# (brazo, lado) con lado +1 = derecha, y None = tronco.
ORDER = [(3, 1), (2, 1), (1, 1), None, (1, -1), (2, -1), (3, -1)]

# "flujo"   = texto continuo repartido por los 7 recorridos (como el diseno original)
# "versos"  = un versiculo entero por brazo, v.5 en el tronco a dos columnas
LAYOUT = os.environ.get("SHIVITI_LAYOUT", "flujo")

# ------------------------------------------------------------ geometria ----
W, H = 800.0, 1000.0
if len(sys.argv) >= 3:
    W, H = float(sys.argv[1]), float(sys.argv[2])
K = min(W / 800.0, H / 1000.0)          # escala respecto al diseno base
CX = W / 2.0


def s(v):
    return v * K


Y_CUP_BOT = s(358.0)      # pie de la copa = arranque del brazo
Y_ARC = s(400.0)          # fin del tramo recto, arranque de la curva
JOIN = [s(690.0), s(712.0), s(734.0)]   # union de cada brazo con el tronco
SEMI_A = [s(72.0), s(144.0), s(216.0)]  # separacion horizontal de cada lampara
Y_BASE_TOP = s(816.0)
BASE_W = s(367.0)
CUP_W = s(61.0)
TRUNK_HW = s(23.0 if LAYOUT == "flujo" else 30.0)
ORN_W = s(178.0)
ORN_M = s(26.0)

TRACK_MIN = 1.06          # holgura minima sobre el ancho natural del texto
BASE_OFF = 0.20           # centrado optico del texto dentro de la cinta
STROKE = s(1.2)


def branch_path(i, side):
    """Cuarto de elipse + tramo recto. Ordenado tronco -> lampara."""
    a, j = SEMI_A[i], JOIN[i]
    b = j - Y_ARC
    th0 = math.asin(min(1.0, TRUNK_HW / a))
    pts = [(CX + side * a * math.sin(th0 + (math.pi / 2 - th0) * k / 400),
            j - b * (1 - math.cos(th0 + (math.pi / 2 - th0) * k / 400)))
           for k in range(401)]
    pts.append((CX + side * a, Y_CUP_BOT))
    return ArcPath(pts)


def trunk_col(k=0.5, gap=0.0):
    """Columna del tronco: pie -> arriba, para que el texto se lea hacia abajo."""
    dx = (k - 0.5) * gap
    return ArcPath([(CX + dx, Y_BASE_TOP - s(14.0)), (CX + dx, Y_CUP_BOT + s(6.0))])


def asset(name):
    raw = open(os.path.join(HERE, "assets", name), encoding="utf-8").read()
    vb = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', raw)
    inner = re.search(r'<g transform="([^"]+)"', raw).group(1)
    d = " ".join(re.findall(r'<path d="([^"]+)"', raw))
    return d, inner, float(vb.group(1)), float(vb.group(2))


def place(name, cx, top, width, flip=(1, 1)):
    d, inner, ow, oh = asset(name)
    sc = width / ow
    x = cx - width / 2.0 if flip[0] > 0 else cx + width / 2.0
    return (f'<g transform="translate({fmt(x)},{fmt(top)}) '
            f'scale({fmt(sc*flip[0])},{fmt(sc*flip[1])}) {inner}"><path d="{d}"/></g>'), oh * sc


# ------------------------------------------------------------------ svg ----
def fit_flow(font, paths, words, lo=4.0, hi=80.0):
    """Busca el cuerpo de letra mas grande con el que TODO el salmo entra,
    repartido por palabras completas a lo largo de los recorridos dados."""
    def assign(size):
        out, idx = [], 0
        for cap in paths:
            take, w = [], 0.0
            while idx < len(words):
                cand = " ".join(take + [words[idx]])
                w = font.shape(cand)[1] / font.upem * size
                if take and w > cap:
                    break
                take.append(words[idx])
                idx += 1
            out.append(" ".join(take))
        return out, idx >= len(words)
    for _ in range(40):
        mid = (lo + hi) / 2
        if assign(mid)[1]:
            lo = mid
        else:
            hi = mid
    return assign(lo)[0], lo


def build():
    font = Font(FONT_PATH)
    eng, diag = [], []

    def units(t):
        return font.shape(t)[1] / font.upem

    # --- recorridos ---
    paths = []
    for item in ORDER:
        if item is None:
            paths.append(("tronco", None, [trunk_col(0)]))
        else:
            i, side = item
            paths.append((f"brazo {i} {'der' if side > 0 else 'izq'}", side,
                          [branch_path(i - 1, side)]))
    MARG = s(6.0)

    if LAYOUT == "flujo":
        words = " ".join(V[k] for k in range(2, 9)).split()
        caps = [p[2][0].length - 2 * MARG for p in paths]
        chunks, size = fit_flow(font, caps, words)
        size = math.floor(size * 10) / 10.0
        runs = [(paths[k], [chunks[k]]) for k in range(7)]
    else:
        size = min(
            [(branch_path(i - 1, sd).length - 2 * MARG) / (units(V[v]) * TRACK_MIN)
             for i, sd, v in [(3, 1, 2), (2, 1, 3), (1, 1, 4), (1, -1, 6), (2, -1, 7), (3, -1, 8)]]
            + [trunk_col(0).length / (units(t) * TRACK_MIN) for t in V5_COLS])
        size = math.floor(size * 10) / 10.0
        texts = [V[2], V[3], V[4], None, V[6], V[7], V[8]]
        runs = []
        for k, (info, txt) in enumerate(zip(paths, texts)):
            runs.append((info, V5_COLS if txt is None else [txt]))

    hw = size * 0.62
    diag.append(f"  reparto = {LAYOUT}")
    diag.append(f"  cuerpo de letra = {size:.1f} mm   (altura de letra ~{size * 0.55:.1f} mm)")

    # --- ornamentos de esquina (vectorizados del original) ---
    od, oin, ow, oh = asset("ornament_raw.svg")
    osc = ORN_W / ow
    for fx, fy in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
        ax = ORN_M if fx > 0 else W - ORN_M
        ay = ORN_M if fy > 0 else H - ORN_M
        eng.append(f'<g transform="translate({fmt(ax)},{fmt(ay)}) '
                   f'scale({fmt(osc * fx)},{fmt(osc * fy)}) {oin}"><path d="{od}"/></g>')

    # --- titulos ---
    for txt, ts, by in ((TITLE_1, s(56.0), s(126.0)),
                        (TITLE_2, s(56.0), s(196.0)),
                        (TITLE_3, s(46.0), s(248.0))):
        p_, wtxt = text_straight(font, txt, ts, CX, by)
        eng += p_
        diag.append(f"  titulo  cuerpo={ts:5.1f} mm   ancho={wtxt:6.1f} mm")

    # --- cintas de los brazos ---
    for name, side, ps in paths:
        if side is not None:
            eng.append(ribbon(ps[0], hw))
    eng.append(f'<path d="M {fmt(CX - TRUNK_HW)},{fmt(Y_CUP_BOT)} '
               f'L {fmt(CX - TRUNK_HW)},{fmt(Y_BASE_TOP + s(6))} '
               f'M {fmt(CX + TRUNK_HW)},{fmt(Y_CUP_BOT)} '
               f'L {fmt(CX + TRUNK_HW)},{fmt(Y_BASE_TOP + s(6))}" '
               f'fill="none" stroke="#000" stroke-width="{fmt(STROKE)}"/>')

    # --- texto ---
    for (name, side, ps), texts in runs:
        ncol = len(texts)
        for c, txt in enumerate(texts):
            if not txt:
                continue
            if side is None:
                path = trunk_col(c if ncol > 1 else 0.5, size * 1.22)
                a, b = 0.0, path.length
            else:
                path = ps[0]
                a, b = MARG, path.length - MARG
            fill = (b - a) if (side is not None or c == 0) else None
            paths_, nat, tr = text_on_path(font, txt, size, path, a, b,
                                           BASE_OFF * size,
                                           extra_track=None if fill else 0.0)
            eng += paths_
            tag = name if ncol == 1 else f"{name} col{c + 1}"
            diag.append(f"  {tag:14s} recorrido={b - a:6.1f}  texto={nat:6.1f}  "
                        f"interletra={tr:+.2f} mm   |  {txt}")

    # --- copas y base (arte vectorizado del original) ---
    cd, cin, cw, ch = asset("cup_raw.svg")
    csc = CUP_W / cw
    for x in [CX] + [CX + sd * a for a in SEMI_A for sd in (-1, 1)]:
        top = Y_CUP_BOT + s(4.0) - ch * csc
        eng.append(f'<g transform="translate({fmt(x - CUP_W / 2)},{fmt(top)}) '
                   f'scale({fmt(csc)},{fmt(csc)}) {cin}"><path d="{cd}"/></g>')
    bd, bin_, bw, bh = asset("base_raw.svg")
    bsc = BASE_W / bw
    eng.append(f'<g transform="translate({fmt(CX - BASE_W / 2)},{fmt(Y_BASE_TOP)}) '
               f'scale({fmt(bsc)},{fmt(bsc)}) {bin_}"><path d="{bd}"/></g>')

    svg = f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" version="1.1"
     width="{fmt(W)}mm" height="{fmt(H)}mm" viewBox="0 0 {fmt(W)} {fmt(H)}">
  <title>Shiviti Menorah - Tehilim 67</title>
  <g id="GRABADO" fill="#000" stroke="none">
{chr(10).join(eng)}
  </g>
  <g id="CORTE" fill="none" stroke="#FF0000" stroke-width="0.1">
    <rect x="0" y="0" width="{fmt(W)}" height="{fmt(H)}"/>
  </g>
</svg>
'''
    return svg, diag


def ribbon(path, hw):
    a = path.offset(hw)
    b = path.offset(-hw)
    da = "M " + " L ".join(f"{fmt(x)},{fmt(y)}" for x, y in a)
    db = "M " + " L ".join(f"{fmt(x)},{fmt(y)}" for x, y in b)
    return f'<path d="{da} {db}" fill="none" stroke="#000" stroke-width="{fmt(STROKE)}"/>'


if __name__ == "__main__":
    svg, diag = build()
    out = os.path.join(HERE, f"shiviti-menorah-{LAYOUT}.svg")
    open(out, "w", encoding="utf-8").write(svg)
    print(f"escrito: {out}   ({W:.0f} x {H:.0f} mm)")
    print("\n".join(diag))
