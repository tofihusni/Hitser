"""Shaping de hebreo -> contornos SVG (sin fuentes vivas: todo se convierte a paths)."""
import math
import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen


class Font:
    def __init__(self, path):
        self.path = path
        with open(path, "rb") as fh:
            data = fh.read()
        face = hb.Face(data)
        self.hbfont = hb.Font(face)
        self.upem = face.upem
        self.tt = TTFont(path)
        self.glyphset = self.tt.getGlyphSet()
        self.order = self.tt.getGlyphOrder()
        self._cache = {}

    def glyph_path(self, gid):
        """Contorno del glifo en unidades de fuente (y hacia arriba)."""
        if gid not in self._cache:
            name = self.order[gid]
            pen = SVGPathPen(self.glyphset, ntos=lambda v: f"{v:.1f}")
            self.glyphset[name].draw(pen)
            self._cache[gid] = pen.getCommands()
        return self._cache[gid]

    def shape(self, text, rtl=True):
        """-> (glifos, ancho_total) en unidades de fuente."""
        buf = hb.Buffer()
        buf.add_str(text)
        buf.direction = "rtl" if rtl else "ltr"
        buf.script = "Hebr"
        buf.language = "he"
        hb.shape(self.hbfont, buf, {"kern": True, "liga": True, "ccmp": True, "mark": True, "mkmk": True})
        out, pen = [], 0.0
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            out.append({
                "gid": info.codepoint,
                "pen": pen,
                "xo": pos.x_offset,
                "yo": pos.y_offset,
                "adv": pos.x_advance,
                "is_mark": pos.x_advance == 0,
            })
            pen += pos.x_advance
        return out, pen


def fmt(v):
    return f"{v:.4f}".rstrip("0").rstrip(".") or "0"


def text_straight(font, text, size, x, y, anchor="middle"):
    """Texto recto convertido a paths. Devuelve (lista_de_path_d, ancho_mm)."""
    glyphs, total = font.shape(text)
    s = size / font.upem
    w = total * s
    ox = {"middle": x - w / 2, "start": x, "end": x - w}[anchor]
    paths = []
    for g in glyphs:
        d = font.glyph_path(g["gid"])
        if not d.strip():
            continue
        gx = ox + (g["pen"] + g["xo"]) * s
        gy = y - g["yo"] * s
        paths.append(f'<path d="{d}" transform="translate({fmt(gx)},{fmt(gy)}) scale({fmt(s)},{fmt(-s)})"/>')
    return paths, w


def text_on_path(font, text, size, path, s_start, s_end, baseline_off, extra_track=None):
    """Reparte el texto a lo largo de `path` (objeto ArcPath) entre s_start y s_end.

    El recorrido s_start->s_end debe ir en el sentido de lectura visual
    (izquierda->derecha del bloque de texto ya conformado en RTL).
    """
    glyphs, total = font.shape(text)
    s = size / font.upem
    natural = total * s
    span = s_end - s_start
    n_gaps = max(1, sum(1 for g in glyphs if not g["is_mark"]) - 1)
    track = (span - natural) / n_gaps if extra_track is None else extra_track
    paths = []
    cursor = 0.0
    seen = 0
    for g in glyphs:
        pos = cursor + g["pen"] * s + (track * seen)
        if not g["is_mark"]:
            seen += 1
        d = font.glyph_path(g["gid"])
        if not d.strip():
            continue
        px, py, ang = path.at(s_start + pos)
        lx = g["xo"] * s
        ly = baseline_off - g["yo"] * s
        paths.append(
            f'<path d="{d}" transform="translate({fmt(px)},{fmt(py)}) rotate({fmt(ang)}) '
            f'translate({fmt(lx)},{fmt(ly)}) scale({fmt(s)},{fmt(-s)})"/>'
        )
    return paths, natural, track


class ArcPath:
    """Polilínea densa con parametrización por longitud de arco."""

    def __init__(self, pts):
        self.pts = pts
        self.cum = [0.0]
        for i in range(1, len(pts)):
            dx = pts[i][0] - pts[i - 1][0]
            dy = pts[i][1] - pts[i - 1][1]
            self.cum.append(self.cum[-1] + math.hypot(dx, dy))
        self.length = self.cum[-1]

    def at(self, s):
        s = max(0.0, min(self.length, s))
        lo, hi = 0, len(self.cum) - 1
        while lo < hi - 1:
            mid = (lo + hi) // 2
            if self.cum[mid] <= s:
                lo = mid
            else:
                hi = mid
        seg = self.cum[hi] - self.cum[lo] or 1e-9
        t = (s - self.cum[lo]) / seg
        x0, y0 = self.pts[lo]
        x1, y1 = self.pts[hi]
        ang = math.degrees(math.atan2(y1 - y0, x1 - x0))
        return x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, ang

    def offset(self, d):
        """Curva paralela desplazada `d` (positivo = a la derecha del avance)."""
        out = []
        n = len(self.pts)
        for i, (x, y) in enumerate(self.pts):
            j0 = max(0, i - 1)
            j1 = min(n - 1, i + 1)
            dx = self.pts[j1][0] - self.pts[j0][0]
            dy = self.pts[j1][1] - self.pts[j0][1]
            L = math.hypot(dx, dy) or 1e-9
            out.append((x + d * dy / L, y - d * dx / L))
        return out

    def reversed(self):
        return ArcPath(list(reversed(self.pts)))
