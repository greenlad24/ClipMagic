"""Renders the privacy fixture frames with PIL (run once; the PNGs are committed).

    docker run --rm --user root -v $PWD/tests/fixtures/privacy:/f aieditor-screencast:0.2 sh -c \
      'apt-get update -qq && apt-get install -y -qq python3-pil >/dev/null && python3 /f/make_fixtures.py /f'

All values are fake: example.com, a made-up key, a Thai test number, the Stripe test card.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
FONT = "/usr/share/fonts/opentype/inter/Inter-Medium.otf"
KEY = "sk-ant-api03-" + "Xq7v2Lm9Pz4Rt8Kw1Bn6Hy3Jd5Fs0Gc2Va7Ue9Qo"[:40]
LINES = [("Signed in as", "Jake Dawson"), ("Email", "jake@example.com"), ("API key", KEY),
         ("Phone", "+66 81 234 5678"), ("Card", "4242 4242 4242 4242")]


def page(dark, lines, size=(1920, 1080), fs=30):
    bg, panel, ink, mute = ((24, 24, 27), (39, 39, 42), (236, 236, 240), (150, 150, 160)) if dark else \
        ((246, 246, 248), (255, 255, 255), (20, 20, 24), (110, 110, 120))
    im = Image.new("RGB", size, bg)
    d = ImageDraw.Draw(im)
    f, fb = ImageFont.truetype(FONT, fs), ImageFont.truetype(FONT, fs + 8)
    d.rectangle([0, 0, 300, size[1]], fill=panel)                       # sidebar
    d.text((40, 60), "Projects", font=fb, fill=ink)
    d.text((40, 130), "Create a new project", font=f, fill=mute)
    d.rounded_rectangle([420, 120, 1800, 160 + 90 * len(lines)], 18, fill=panel)
    d.text((460, 60), "Account settings", font=fb, fill=ink)
    for i, (k, v) in enumerate(lines):
        y = 170 + 90 * i
        d.text((470, y), k, font=f, fill=mute)
        d.text((780, y), v, font=f, fill=ink)
    return im


def main():
    page(False, LINES).save(OUT / "secrets_light.png")
    page(True, LINES).save(OUT / "secrets_dark.png")
    page(False, [("Signed in as", "Jake Dawson"), ("Plan", "Plus"), ("Theme", "Dark")]).save(OUT / "name_only.png")
    # the synthetic recording's page (2560x1440 capture): a card at x 700..1834, y 560..860 holds the email
    im = Image.new("RGB", (2560, 1440), (246, 246, 248))
    d = ImageDraw.Draw(im)
    f, fb = ImageFont.truetype(FONT, 40), ImageFont.truetype(FONT, 52)
    d.text((120, 90), "Jake Dawson — Settings", font=fb, fill=(20, 20, 24))
    d.text((120, 300), "Profile", font=f, fill=(110, 110, 120))
    d.rounded_rectangle([700, 560, 1834, 860], 24, fill=(255, 255, 255), outline=(220, 220, 226), width=2)
    d.text((760, 610), "Email address", font=f, fill=(110, 110, 120))
    d.text((760, 700), "jake@example.com", font=fb, fill=(20, 20, 24))
    im.save(OUT / "email_card.png")


if __name__ == "__main__":
    main()
