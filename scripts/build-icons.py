"""Build original vector artwork and antialiased Chrome PNG icons (Pillow, development only)."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
output = root / 'icons'
output.mkdir(exist_ok=True)
navy, mint = '#101a2b', '#a5f3d1'
(output / 'logo.svg').write_text('''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-labelledby="title">
  <title id="title">Burmese Subtitles — play and captions</title>
  <rect x="4" y="4" width="120" height="120" rx="28" fill="#101a2b"/>
  <path d="M32 82V106L58 88Z" fill="#a5f3d1"/>
  <rect x="22" y="24" width="84" height="68" rx="16" fill="#a5f3d1"/>
  <path d="M51 38V62L75 50Z" fill="#101a2b"/>
  <rect x="38" y="71" width="52" height="6" rx="3" fill="#101a2b"/>
  <rect x="38" y="82" width="36" height="5" rx="2.5" fill="#101a2b"/>
</svg>
''', encoding='utf-8')

scale = 8
art = Image.new('RGBA', (128 * scale, 128 * scale), (0, 0, 0, 0))
draw = ImageDraw.Draw(art)
def rectangle(box, radius, fill):
    draw.rounded_rectangle(tuple(round(v * scale) for v in box), radius=round(radius * scale), fill=fill)
def polygon(points, fill):
    draw.polygon([(round(x * scale), round(y * scale)) for x, y in points], fill=fill)
rectangle((4, 4, 124, 124), 28, navy)
polygon([(32, 82), (32, 106), (58, 88)], mint)
rectangle((22, 24, 106, 92), 16, mint)
polygon([(51, 38), (51, 62), (75, 50)], navy)
rectangle((38, 71, 90, 77), 3, navy)
rectangle((38, 82, 74, 87), 2.5, navy)
for size in (16, 32, 48, 128, 512):
    art.resize((size, size), Image.Resampling.LANCZOS).save(output / f'icon-{size}.png', optimize=True)
