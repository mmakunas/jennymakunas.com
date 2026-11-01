# The site: how the build turns the Wix page into these pages

`content/` says what each page says; `src/layout/*.json` says where the live Wix
page puts each block; the Astro templates put the two together. This file records
the measurements and the decisions behind that, so the next change knows which
half it is editing.

## What the live site actually is

Measured from the free Wix site on 2026-10-31 with Playwright, page by page.

- **Desktop is a 983px canvas that stretches sideways only.** Blocks sit at fixed
  vertical offsets and stretch horizontally with the viewport: a still at
  `x=205.8, w=205.8` at 983 is at `x=40, w=320` at 1440 while its height stays
  400. So every block was captured at 983 and again at 1440, and the build
  interpolates linearly between the two: `left: calc(a + b·100cqw)`. Above 983px
  the canvas is never narrower than the design; below it the phone layout takes
  over.
- **Phones get a different layout**, a 320px canvas that the browser scales to the
  device width: a header with a hamburger instead of the nav row, blocks stacked
  instead of side by side, and its own type sizes. The build reproduces it as a
  320px design with every length in `cqw`, which is the same thing the browser
  scaling does at any phone width.
- **The Work grid is a Wix gallery**, not page content: two columns, 4:3 cells,
  full width. Its boxes are captured with the rest of the page and paired with the
  Markdown's linked images in order.

`npm run extract-layout` re-measures all of it into `src/layout/` (about ten
minutes for 15 pages, three loads each). It needs the network; the build does not.

## How a page is composed

`src/lib/content.js` parses `content/<slug>.md`. `src/lib/site.js` decides where
each Markdown block goes:

- **Text** pairs with the captured box in the same order, so a paragraph Wix
  wrapped differently still finds its own box. An empty captured paragraph is the
  space Wix draws between two paragraphs, not a paragraph of its own: it keeps its
  place and takes none of the Markdown.
- **Media** (images, films, the trailer facade) pairs by identity — the same
  picture, the same film's poster, the one embedded player — never by lucky
  position. A picture in the Markdown with no box on the page, or a box with no
  picture, fails the build instead of falling back to the captured content.
- **The phone layout** pairs against the desktop one on the *captured* wording, so
  editing a word of copy cannot re-pair its boxes; a block with no phone twin fails
  the build the same way.
- **A bulleted list** is one Markdown block but several boxes: the first box
  carries the list and the rest are its continuation.
- A box with nothing in `content/` is an orphan and is reported by
  `node scripts/site/report.mjs`; a block in `content/` with no box would be a
  leftover. Today the only orphans are empty paragraphs Wix leaves behind.

Nothing is hot-linked: an image the manifest does not know is not rendered at
all, which is why `lint:paths` can assert that no request leaves the built site.

## Chrome

The header and footer words come from `content/_site.md`; their positions come
from the capture (`src/layout/site.json`). The active page is tinted the accent
the live site uses. Below 750px the header becomes the logo and a hamburger, and
the menu is the site's own: Work expands to the 11 case studies, Thoughts to its
two links, then About and Contact.

## Media decisions (Michael, 2026-10-31)

- **Films** play in a native `<video>` at the player's captured box, with the
  still as `poster` and `preload="metadata"`. No control bar shows until the visitor
  starts the film, which is what Wix does: the still carries the player's title and a
  play circle, and the click hands the film its controls. The Anna Wintour background
  film autoplays muted and loops, as it does on Wix, and Wix gives that loop no
  control either.
- **Pictures are cropped to their box, as Wix crops them.** Wix serves a `fill`
  rendition sized to the shape of each box. The desktop canvas keeps stretching past
  1440, so on the desktop the box only ever gets wider: the extractor reads each page
  at 1920, where a box crops its picture the least, and a narrower box then crops that
  picture on the sides only — the crop Wix serves it. The phone layout's box is a
  different shape altogether, so the extractor reads every page again at 390 with a
  phone user agent and downloads that rendition too; the manifest keeps it inside the
  same row, and the build swaps to it below the breakpoint with `<picture>`. A phone
  rendition is only stored when its crop differs from the desktop one.
- **The Animaniacs trailer** is a click-to-play facade: the local thumbnail and a
  play button, and the `youtube-nocookie.com` iframe is only inserted on click.
  Nothing is fetched from YouTube before that.
- **Contact** is mailto only: the email, the phone and the three social links as
  served. There is no form. A form would mean a third-party service, which the
  first release rules out.

## Fonts

Cormorant Garamond is self-hosted from the files Wix served (SIL OFL, see
`fonts/REPORT.md`). Futura LT Book and Avenir LT Light are Monotype licences Wix
sublicenses and cannot be copied, so the build uses the nearest Google Fonts
equivalents **Jost** and **Mulish**, self-hosted from `public/fonts/` with their
OFL licences. No font request leaves the site. `scripts/extract.py` fetches those
two families at a pinned version (`SUBSTITUTES`), so a fresh extraction reproduces
`public/fonts/` byte for byte and `--check` can prove it.

## Checks

- `npm run build` — Astro build, then `lint:paths`, which fails on an absolute
  `href`/`src` that skips the base and on any request to a Wix domain.
- `npm run lint:paths` also covers `srcset`, `poster` and CSS `url()`, so a
  protocol-relative or base-skipping URL fails wherever it hides.
- `npm run verify` — 50 behaviour checks on the built site: every route 200, no
  third-party requests, nine films with posters and no control bar before play, the
  mailto and social links, every page's canonical address, the mobile menu opening,
  holding the keyboard and navigating, the trailer's facade, the Work dropdown.
- `npm run shots` — the 30-pair fidelity pass into `shots/`: every page at 1440
  and 390, with Wix blocked, beside the live Wix page.
- `npm run measure` — the same comparison as numbers: block positions against the
  live site, at both widths.
