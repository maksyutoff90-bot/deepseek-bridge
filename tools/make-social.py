from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

W, H = 1280, 640
BG = (11, 13, 18)
ACCENT = (47, 111, 237)
TEXT = (232, 235, 241)
MUTED = (154, 162, 174)

base = r"C:\Users\Robert\Documents\deepseek-harness\default-workspace\webcode-bridge"
shot_path = os.path.join(base, "screenshot.png")
out_path = os.path.join(base, "social-preview.png")

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

for i in range(6):
    d.line([(i, 0), (i, H)], fill=(30 + i * 3, 60 + i * 6, 120 + i * 12))


def font(name, size):
    return ImageFont.truetype(os.path.join(r"C:\Windows\Fonts", name), size)


f_label = font("arialbd.ttf", 18)
f_title = font("arialbd.ttf", 70)
f_tag = font("arial.ttf", 28)
f_bullet = font("arial.ttf", 21)
f_foot = font("arial.ttf", 18)

x = 64
d.text((x, 74), "CHROME EXTENSION  |  LOCAL GATEWAY", font=f_label, fill=MUTED)
d.text((x, 108), "deepseek-bridge", font=f_title, fill=TEXT)

d.text((x, 214), "Chat with DeepSeek.", font=f_tag, fill=(200, 208, 220))
d.text((x, 250), "Apply to your repo, safely.", font=f_tag, fill=(200, 208, 220))

bullets = [
    "Sandboxed edits in _fixes/ (originals untouched)",
    "Review and confirm before writing, with backups",
    "VS Code diffs, drag & drop, context menu",
]
y = 330
for b in bullets:
    d.ellipse([(x, y + 9), (x + 7, y + 16)], fill=ACCENT)
    d.text((x + 20, y), b, font=f_bullet, fill=(190, 198, 210))
    y += 42

d.text((x, 540), "No API key  |  127.0.0.1 only  |  MIT", font=f_foot, fill=MUTED)

shot = Image.open(shot_path).convert("RGB")
tw = 512
th = int(shot.height * tw / shot.width)
shot = shot.resize((tw, th), Image.LANCZOS)
mask = Image.new("L", (tw, th), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, tw - 1, th - 1], radius=16, fill=255)
px, py = 700, 132

glow = Image.new("RGBA", (tw + 40, th + 40), (0, 0, 0, 0))
ImageDraw.Draw(glow).rounded_rectangle([20, 20, tw + 19, th + 19], radius=18, fill=(47, 111, 237, 45))
glow = glow.filter(ImageFilter.GaussianBlur(12))
img.paste(glow.convert("RGB"), (px - 20, py - 20), glow.split()[3])
img.paste(shot, (px, py), mask)
d.rounded_rectangle([px - 1, py - 1, px + tw, py + th], radius=16, outline=(52, 56, 66), width=2)

img.save(out_path, "PNG")
print(out_path, os.path.getsize(out_path))
