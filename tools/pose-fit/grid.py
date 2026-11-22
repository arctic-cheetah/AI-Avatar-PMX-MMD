# grid.py OUTDIR ROWSPEC... : builds labelled grids per framing. Rows = prefixes, cols = views.
import sys, os
from PIL import Image, ImageDraw, ImageFont
tiles, out = sys.argv[1], sys.argv[2]
rows = sys.argv[3].split(',')          # prefix:label pairs e.g. pmx:PMX default
rows = [r.split(':', 1) for r in rows]
views = [('front', 'front'), ('threequarter', 'three-quarter'), ('side', 'side')]
F = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 20)
T = 360; LW = 200; HH = 36
for framing in ['face', 'bust', 'full']:
    g = Image.new('RGB', (LW + T * 3, HH + T * len(rows)), 'white'); d = ImageDraw.Draw(g)
    d.text((8, 8), framing, fill='black', font=F)
    for j, (_, vl) in enumerate(views):
        d.text((LW + j * T + 8, 8), vl, fill='black', font=F)
    for i, (pre, label) in enumerate(rows):
        d.multiline_text((8, HH + i * T + T // 2 - 20), label.replace('|', '\n'), fill='black', font=F)
        for j, (v, _) in enumerate(views):
            p = os.path.join(tiles, f'{pre}_{framing}_{v}.png')
            if os.path.exists(p):
                g.paste(Image.open(p).convert('RGB').resize((T, T)), (LW + j * T, HH + i * T))
            else:
                d.text((LW + j * T + 20, HH + i * T + T // 2), 'missing', fill='red', font=F)
    g.save(os.path.join(out, f'grid_{framing}.png')); print('saved', framing)
