from PIL import Image, ImageDraw, ImageFont
import os

base = r"C:\Users\Robert\Documents\deepseek-harness\default-workspace\webcode-bridge\extension"
os.makedirs(base, exist_ok=True)

BG = (47, 111, 237)
FG = (255, 255, 255)


def make(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(size * 0.22)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=BG)
    f = ImageFont.truetype(os.path.join(r"C:\Windows\Fonts", "arialbd.ttf"), int(size * 0.46))
    text = "db"
    bbox = d.textbbox((0, 0), text, font=f)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    d.text(((size - w) / 2 - bbox[0], (size - h) / 2 - bbox[1]), text, font=f, fill=FG)
    return img


for s in (16, 48, 128):
    p = os.path.join(base, f"icon{s}.png")
    make(s).save(p, "PNG")
    print(p, os.path.getsize(p))
