# jennymakunas.com
jennymakunas.com — Jenny Makunas, brand strategist. Static site (Astro) on GitHub Pages; ported from Wix 2026-11.

## Content tree

Everything the site says comes from `content/`, everything it shows comes from `public/`.
Both are generated from the live Wix site by `scripts/extract.py`; edit the script or the
Wix site, not the output, when the source of truth changes.

- `content/<slug>.md` — one file per page. Front matter: `title`, `nav_label`, `order` (the
  Work menu order, null for pages that are not case studies), `path` (the path the site
  serves, unchanged from Wix), `kind` (`home`, `case_study`, `page`). The body is the page's
  copy in document order, each image as `![alt](/images/<file>)`.
- `public/images/<file>` — every image at the rendition a high-density screen is served, with
  `images/manifest.json` mapping the Wix URL to the file, its size and its byte count. Nothing
  in `content/` links to Wix.
- `public/videos/` — the films the pages play, at the rendition the Wix player serves,
  with `videos/manifest.json` giving each one's Wix URL, size, duration, still and pages.
- `public/fonts/` — the fonts whose licence allows self-hosting, with `fonts/REPORT.md`
  recording every family, weight, source and licence verdict.
- `public/files/` — the About page's C.V. PDF, which Wix served from its own file host.
- `content/_site.md` — the header nav in its served order and the footer as served (the
  social links, the email, the phone, the © line), so the shared chrome is generated too.

Three conventions the generator uses, because Markdown has no other way to say them:

- A Work grid tile is `[![<tile title>](/images/<file>)](<page path> "<tile caption>")`: the
  served title is the alt text, the served caption is the link title.
- A film is a `<video>` element with the still frame as its `poster`; the Anna Wintour loop
  autoplays muted and loops, as it does on Wix. The Animaniacs trailer is a click-to-play
  facade — a local poster linking to the YouTube embed — so nothing from YouTube loads
  until a visitor clicks.
- The Contact page keeps the email as `mailto:`, the phone as `tel:` and the three social
  links. Its form is dropped by Michael's decision; a static host cannot accept it.

## Regenerating

Needs Python 3.12 or newer, `ffprobe` on `PATH` (from ffmpeg) to measure the films, and the
pinned packages:

```
pip install -r requirements.txt
python3 -m playwright install chromium
python3 scripts/extract.py          # writes content/, public/images/, public/fonts/, fonts/REPORT.md
python3 scripts/extract.py --check  # re-extracts to a temporary directory and fails on any difference
```

`--check` is how the tree proves it still matches the live site: it exits non-zero when any
generated file would change. Text is compared exactly; pictures are compared by dimensions
and a perceptual hash, because Wix re-encodes the same URL a few bytes differently on every
fetch and a byte comparison would flap forever.

## Building the site

```
npm ci
BASE=/jennymakunas.com/ npm run build    # preview build (project site under www.makunas.com)
BASE=/ npm run build                     # production build (www.jennymakunas.com)
npm run preview
```

`npm run build` fails if any absolute `href`/`src` skips the base or anything asks
a Wix domain. `npm run verify` runs 44 behaviour checks against the built output,
`npm run measure` diffs block positions against the live site, and `npm run shots`
writes the 30 side-by-side fidelity comparisons into `shots/`. How the layout is
measured and applied is in `docs/SITE.md`.
