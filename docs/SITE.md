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

- **Text** pairs with the captured text box that carries the same text, so a
  paragraph Wix wrapped differently still finds its own box.
- **Media** (images, films, the trailer facade) pairs in document order against
  every media box on the page, with an exact media-id match first, because Wix
  lays a film's poster frame above its stills.
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
  still as `poster` and `preload="metadata"`; the Anna Wintour background film
  autoplays muted and loops, as it does on Wix.
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
OFL licences. No font request leaves the site.

## Checks

- `npm run build` — Astro build, then `lint:paths`, which fails on an absolute
  `href`/`src` that skips the base and on any request to a Wix domain.
- `npm run verify` — 44 behaviour checks on the built site: every route 200, no
  third-party requests, nine films with posters, the mailto and social links, the
  mobile menu opening and navigating, the trailer's facade, the Work dropdown.
- `npm run shots` — the 30-pair fidelity pass into `shots/`: every page at 1440
  and 390, with Wix blocked, beside the live Wix page.
- `npm run measure` — the same comparison as numbers: block positions against the
  live site, at both widths.
