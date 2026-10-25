"""Draws the Web Roamer icon (assets/icon.png, icon.ico, icon-64.rgba): Board Roamer's chamfered frame and needle, over a globe."""
import math, os
from PIL import Image, ImageDraw

S = 1024  # drawn large, scaled down for smooth edges
LIME, INK, PALE, TEAL = (200, 255, 61, 255), (10, 17, 19, 255), (232, 240, 226, 255), (92, 150, 140, 255)
im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
m, c = 56, 110
frame = [(m + c, m), (S - m, m), (S - m, S - m - c), (S - m - c, S - m), (m, S - m), (m, m + c)]
d.polygon(frame, fill=LIME)
w = 40
inner = [(m + w + c - 16, m + w), (S - m - w, m + w), (S - m - w, S - m - w - c + 16), (S - m - w - c + 16, S - m - w), (m + w, S - m - w), (m + w, m + w + c - 16)]
d.polygon(inner, fill=INK)

cx = cy = S // 2
r = 300
lw = 26
# globe: outline, equator, two meridians, two parallels
d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=TEAL, width=lw)
d.line([cx - r, cy, cx + r, cy], fill=TEAL, width=lw)
for k in (0.45,):
    d.ellipse([cx - r * k, cy - r, cx + r * k, cy + r], outline=TEAL, width=lw)
for yy in (-0.55, 0.55):
    hw = r * math.sqrt(1 - yy * yy)
    d.line([cx - hw, cy + r * yy, cx + hw, cy + r * yy], fill=TEAL, width=lw)

# the compass needle, tilted like it is roaming
ang = math.radians(35)
def rot(x, y):
    return (cx + x * math.cos(ang) - y * math.sin(ang), cy + x * math.sin(ang) + y * math.cos(ang))
L, Wd = 345, 92
d.polygon([rot(0, -L), rot(Wd, 0), rot(-Wd, 0)], fill=LIME, outline=INK, width=14)
d.polygon([rot(0, L), rot(Wd, 0), rot(-Wd, 0)], fill=PALE, outline=INK, width=14)
d.ellipse([cx - 40, cy - 40, cx + 40, cy + 40], fill=INK)

out = os.path.join(os.path.dirname(__file__), '..', 'assets')
big = im.resize((256, 256), Image.LANCZOS)
big.save(os.path.join(out, 'icon.png'))
im.resize((512, 512), Image.LANCZOS).save(os.path.join(out, 'icon-512.png'))
big.save(os.path.join(out, 'icon.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
with open(os.path.join(out, 'icon-64.rgba'), 'wb') as f:
    f.write(im.resize((64, 64), Image.LANCZOS).tobytes())
