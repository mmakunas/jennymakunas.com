#!/usr/bin/env python3
"""Extract jennymakunas.com from the live Wix site.

Reads the 15 public pages of https://jenny6926.wixsite.com/mysite and writes the
site's content tree into this repository:

    content/<slug>.md          one file per page: front matter plus the page's copy
                               blocks in document order, images as ![alt](/images/<file>)
    content/_site.md           the header and footer every page shares
    public/images/<file>       every image at the rendition the page serves to a
                               high-density screen, including the stills films play over
    images/manifest.json       Wix URL (verbatim) -> local file, size, bytes, pages
    public/videos/<file>       the films the pages play, at the rendition the Wix
                               player serves, with videos/manifest.json beside them
    public/fonts/<file>        the fonts whose licence allows self-hosting
    fonts/REPORT.md            every font family and weight, where it comes from,
                               licence verdict and Google Font substitute
    public/files/              the About page's C.V., which Wix served from its file host

The Wix free site renders most of each page client-side: the HTML the server sends
carries only ~30-pixel blur placeholders for images and no video blocks at all. The
extractor therefore renders every page in headless Chromium and reads the rendered
DOM, which is what a visitor's browser sees.

Rendition rule: each page is rendered twice, at a 1920-wide desktop and at a 390-wide
phone, both at a 2x device pixel ratio, and each image's `currentSrc` is taken. Wix
crops a `fill` rendition to the shape of the box it sits in, and the same box has a
different shape on a phone — and a wider one on a wider screen, since the desktop
canvas keeps stretching. The desktop rendition is therefore taken at the widest width
the design is read at, where a box crops its picture the least: a narrower box crops
the same picture on the sides only, which is exactly the crop Wix serves it. The phone
box is a different shape entirely, so it gets its own rendition. Images are
re-downloaded from the manifest URL itself, so the file on disk is the same rendition
the page referenced.

Usage:
    python3 -m playwright install chromium      # once per machine
    python3 scripts/extract.py                  # write the tree
    python3 scripts/extract.py --check          # re-extract and fail on any diff

`--check` re-runs the whole extraction into a temporary directory and compares the
result with the committed tree, so a clean exit proves the live Wix site still
matches the repository. Text is compared exactly. Pictures are not: Wix re-encodes a
rendition on every fetch, so the same URL comes back a few bytes different each time.
They are compared by what they show — dimensions and a 64-bit difference hash of their
luminance — and a re-encode is reported in words rather than failed.

Two decisions recorded in content rather than guessed at: a film the page plays is a
`<video>` element pointing at `public/videos/`, and the YouTube trailer on the
Animaniacs page is a click-to-play facade (a local poster linking to the embed), so no
third-party script loads before a visitor clicks. The Contact page keeps mailto, tel
and the social links; its form is dropped, because a static host cannot accept it.

Needs `ffprobe` on PATH (from ffmpeg) to measure the films.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tempfile
import io
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from lxml import html as lxml_html
from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright

SITE = "https://jenny6926.wixsite.com"
BASE = f"{SITE}/mysite"
SITE_NAME = "Jenny Makunas"
ROOT = Path(__file__).resolve().parent.parent

VIEWPORT = {"width": 1920, "height": 1080}
MOBILE_VIEWPORT = {"width": 390, "height": 844}
DPR = 2
USER_AGENT = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
MOBILE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
             "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")

TEXT_OUTPUT = ["content/*.md", "fonts/REPORT.md", "videos/manifest.json"]
BINARY_OUTPUT = ["public/fonts/*.woff2", "public/fonts/*.ttf", "public/files/*", "public/videos/*"]
MANIFEST = "images/manifest.json"
PICTURES = "public/images/*"

# Wix re-encodes a rendition on every fetch, so the bytes of the same picture differ from
# run to run. Pictures are compared by what they show: their size and a 64-bit difference
# hash of their luminance. A re-encode scores 0-8 bits apart, a different picture 20 or more.
STRUCTURE_SAME = 8

# The resizer also rounds a rendition's height by a pixel or two from one fetch to the
# next (1196x1180 became 1196x1182), so a size within this many pixels is the same
# rendition, and the requested w_/h_ values are not part of a rendition's identity.
SIZE_TOLERANCE = 2

# A difference hash cannot tell two flat pictures apart (a blank white frame and a blank
# black one hash alike), so a matching hash only counts with the pixels close too.
PIXEL_SAME = 24.0


def same_size(left: tuple[int, int], right: tuple[int, int]) -> bool:
    return (abs(left[0] - right[0]) <= SIZE_TOLERANCE
            and abs(left[1] - right[1]) <= SIZE_TOLERANCE)


def without_requested_size(url: str) -> str:
    return re.sub(r"[,]?[wWhH]_\d+", "", url)


@dataclass(frozen=True)
class Page:
    slug: str  # Wix slug, "" for the home page
    file: str  # content file stem
    path: str  # canonical path on jennymakunas.com
    kind: str  # home | case_study | page


PAGES = [
    Page("", "home", "/", "home"),
    Page("23andme-dna-day-2023", "23andme-dna-day-2023", "/23andme-dna-day-2023", "case_study"),
    Page("alicia-keys-words-create-worlds-1", "alicia-keys-words-create-worlds-1",
         "/alicia-keys-words-create-worlds-1", "case_study"),
    Page("animaniacs-x-masterclass", "animaniacs-x-masterclass", "/animaniacs-x-masterclass", "case_study"),
    Page("anna-wintour-how-to-be-a-boss-1", "anna-wintour-how-to-be-a-boss-1",
         "/anna-wintour-how-to-be-a-boss-1", "case_study"),
    Page("hot-mess-creative-collective", "hot-mess-creative-collective",
         "/hot-mess-creative-collective", "case_study"),
    Page("mariah-carey-pass-the-mic", "mariah-carey-pass-the-mic", "/mariah-carey-pass-the-mic", "case_study"),
    Page("now-you-brand-campaign", "now-you-brand-campaign", "/now-you-brand-campaign", "case_study"),
    Page("now-you-countdown-portfolio-campaign", "now-you-countdown-portfolio-campaign",
         "/now-you-countdown-portfolio-campaign", "case_study"),
    Page("so-much-new-to-know-portfolio-campaign", "so-much-new-to-know-portfolio-campaign",
         "/so-much-new-to-know-portfolio-campaign", "case_study"),
    Page("the-world-could-use-one-of-you", "the-world-could-use-one-of-you",
         "/the-world-could-use-one-of-you", "case_study"),
    Page("today-s-the-day-brand-campaign", "today-s-the-day-brand-campaign",
         "/today-s-the-day-brand-campaign", "case_study"),
    Page("thoughts", "thoughts", "/thoughts", "page"),
    Page("about", "about", "/about", "page"),
    Page("contact-8", "contact", "/contact-8", "page"),
]

HOME_LABEL = "Work"

# Files the pages link to that are not images: served URL -> (path in the repo, path on the site).
FILES = {
    "https://a10fc383-a875-4479-9fe7-aec9649c6135.filesusr.com/ugd/"
    "a8ae1a_6411c59e61744402bb98f21e4f1b8586.pdf": ("files/jenny-makunas-cv.pdf", "/files/jenny-makunas-cv.pdf"),
}

# What each font family is and what to do about it. The verdicts are the point of
# fonts/REPORT.md: only the open-licence families may be copied into this repo.
FONTS = {
    "cormorant garamond": {
        "name": "Cormorant Garamond",
        "licence": "SIL Open Font License 1.1",
        "verdict": "self-host",
        "note": "The OFL permits redistribution, so the files Wix serves are copied into public/fonts/.",
        "substitute": None,
    },
    "raleway": {
        "name": "Raleway",
        "licence": "SIL Open Font License 1.1",
        "verdict": "self-host",
        "note": "The OFL permits redistribution, so the files Wix serves are copied into public/fonts/.",
        "substitute": None,
    },
    "futura-lt": {
        "name": "Futura LT Book",
        "licence": "Monotype commercial licence, sublicensed to Wix and not transferable",
        "verdict": "substitute",
        "note": "Wix serves it from its own font CDN under its Monotype licence, so the files cannot be copied into this repository.",
        "substitute": "Jost",
    },
    "din-next": {
        "name": "DIN Next LT Light",
        "licence": "Monotype commercial licence, sublicensed to Wix and not transferable",
        "verdict": "substitute",
        "note": "Wix serves it from its own font CDN under its Monotype licence, so the files cannot be copied into this repository.",
        "substitute": "Barlow",
    },
    "avenir-lt": {
        "name": "Avenir LT Light",
        "licence": "Monotype commercial licence, sublicensed to Wix and not transferable",
        "verdict": "substitute",
        "note": "Wix serves it from its own font CDN under its Monotype licence, so the files cannot be copied into this repository.",
        "substitute": "Mulish",
    },
    "arial": {
        "name": "Arial",
        "licence": "System font",
        "verdict": "system",
        "note": "A stack that falls back to the visitor's own system font; nothing to ship.",
        "substitute": None,
    },
    "helvetica": {
        "name": "Helvetica",
        "licence": "System font",
        "verdict": "system",
        "note": "A stack that falls back to the visitor's own system font; nothing to ship.",
        "substitute": None,
    },
    "helveticaneuew01": {
        "name": "Helvetica Neue W01 (Wix player)",
        "licence": "Wix web font, served only inside Wix's video player",
        "verdict": "wix-chrome",
        "note": "It styles the controls of Wix's own video player, which the rebuild does not carry.",
        "substitute": None,
    },
    "madefor": {
        "name": "Wix Madefor Text",
        "licence": "Wix platform font",
        "verdict": "wix-chrome",
        "note": "Wix's own interface font; it belongs to the free-site banner the rebuild drops.",
        "substitute": None,
    },
}

# The two substituted families are not Wix's: Futura LT Book and Avenir LT Light are
# Monotype licences Wix sublicenses, so the build ships the nearest Google Fonts
# equivalents instead. The URLs pin the version, so a fresh run writes the same bytes
# and `--check` can prove the tree.
SUBSTITUTES = {
    "Jost": {
        "latin": "https://fonts.gstatic.com/s/jost/v20/92zatBhPNqw73oTd4g.woff2",
        "latin-ext": "https://fonts.gstatic.com/s/jost/v20/92zatBhPNqw73ord4iYl.woff2",
    },
    "Mulish": {
        "latin": "https://fonts.gstatic.com/s/mulish/v18/1Ptvg83HX_SGhgqk3wot.woff2",
        "latin-ext": "https://fonts.gstatic.com/s/mulish/v18/1Ptvg83HX_SGhgqk0QotcqA.woff2",
    },
}

COLLECT_JS = r"""
() => {
  const main = document.querySelector('#PAGES_CONTAINER') || document.querySelector('main');
  const header = document.querySelector('#SITE_HEADER');
  const footer = document.querySelector('#SITE_FOOTER');
  const box = (el) => { const r = el.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y + window.scrollY), Math.round(r.width), Math.round(r.height)]; };
  const textOf = (el) => { try { return el.innerText || '' } catch (e) { return '' } };
  const anchors = (root) => root ? [...root.querySelectorAll('a')].map((a) => ({
    label: textOf(a).replace(/\s+/g, ' ').trim(), href: a.getAttribute('href') || '',
    inText: !!a.closest('.wixui-rich-text')})) : [];

  // One walk of the page container, so blocks keep the document's own order.
  const blocks = [];
  for (const el of main.querySelectorAll('*')) {
    const tag = (el.tagName || '').toLowerCase();
    if (el.classList.contains('wixui-rich-text')) {
      const parts = [...el.children].map((c) => ({tag: (c.tagName || '').toLowerCase(),
                                                  size: parseFloat(getComputedStyle(c).fontSize) || 0}));
      blocks.push({kind: 'text', id: el.id, html: el.innerHTML, rect: box(el), parts,
                   inForm: !!el.closest('form')});
    } else if (tag === 'img') {
      const link = el.closest('a');
      blocks.push({kind: 'image', alt: el.alt || '', src: el.currentSrc || el.src || '',
                   href: link ? (link.getAttribute('href') || '') : '', rect: box(el)});
    } else if (tag === 'wix-bg-image') {
      // A picture drawn as a CSS background layer rather than an <img> — two on
      // the Today's the Day page. It is a box on the page like any other.
      const ground = /url\("?([^")]+)"?\)/.exec(getComputedStyle(el).backgroundImage);
      const r = el.getBoundingClientRect();
      if (!ground || !/wixstatic/.test(ground[1]) || r.width < 40 || r.height < 40) continue;
      const link = el.closest('a');
      blocks.push({kind: 'image', alt: '', src: ground[1],
                   href: link ? (link.getAttribute('href') || '') : '', rect: box(el)});
    } else if (tag === 'video') {
      const holder = el.closest('[aria-label]');
      blocks.push({kind: 'video', src: el.getAttribute('src') || '',
                   label: (holder ? holder.getAttribute('aria-label') : '') || '',
                   poster: el.getAttribute('poster') || '',
                   autoplay: el.hasAttribute('autoplay'), muted: el.hasAttribute('muted'),
                   loop: el.hasAttribute('loop'), rect: box(el)});
    } else if (tag === 'iframe') {
      blocks.push({kind: 'embed', src: el.getAttribute('src') || '',
                   title: el.getAttribute('title') || '', rect: box(el)});
    } else if (tag === 'form') {
      const fields = [...el.querySelectorAll('input, textarea, select')].map((f) => {
        const label = el.querySelector(`label[for="${f.id}"]`);
        return {label: label ? label.innerText.trim() : '', name: f.getAttribute('name') || '',
                type: (f.type || f.tagName).toLowerCase(), required: f.hasAttribute('required')};
      });
      const submit = el.querySelector('button, input[type=submit]');
      blocks.push({kind: 'form', fields, submit: submit ? textOf(submit).trim() : '', rect: box(el)});
    }
  }

  const styles = {};
  for (const [area, root] of [['content', main], ['header', header], ['footer', footer]]) {
    if (!root) continue;
    for (const el of root.querySelectorAll('*')) {
      const tag = (el.tagName || '').toLowerCase();
      if (['style', 'script', 'noscript', 'template'].includes(tag)) continue;
      if (el.closest('style, script, noscript, template')) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
      if (!own) continue;
      const cs = getComputedStyle(el);
      const key = [cs.fontFamily, cs.fontWeight, cs.fontStyle, cs.fontSize].join('||');
      styles[area] = styles[area] || {};
      const row = styles[area][key] || (styles[area][key] = {count: 0, sample: textOf(el).trim().slice(0, 40)});
      row.count += 1;
    }
  }

  const faces = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules } catch (e) { continue }
    for (const rule of rules) {
      if (rule.constructor.name !== 'CSSFontFaceRule') continue;
      faces.push({family: rule.style.fontFamily, weight: rule.style.fontWeight,
                  style: rule.style.fontStyle, src: rule.style.src});
    }
  }

  const tiles = [...main.querySelectorAll('[data-hook="item-container"]')].map((c) => {
    const image = c.querySelector('img');
    return {id: c.getAttribute('data-id') || '', index: Number(c.getAttribute('data-idx')),
            src: image ? (image.currentSrc || image.src) : ''};
  }).sort((a, b) => a.index - b.index);

  return {title: document.title, blocks, styles, faces, nav: anchors(header),
          footerLinks: anchors(footer),
          footerBlocks: footer ? [...footer.querySelectorAll('.wixui-rich-text')].map((el) => el.innerHTML) : [],
          tiles, html: document.documentElement.outerHTML};
}
"""


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def collapse(value: str) -> str:
    """Normalise whitespace and drop the zero-width characters Wix sprinkles in."""
    value = value.replace("\u200b", "").replace("\ufeff", "").replace("\xa0", " ")
    return re.sub(r"\s+", " ", value)


MD_SPECIALS = re.compile(r"([\\`*\[\]<>])")


def escape_md(value: str) -> str:
    return MD_SPECIALS.sub(r"\\\1", value)


def media_id(url: str) -> str:
    """The picture a rendition URL belongs to, ignoring how it was rendered."""
    match = re.search(r"/media/([^/]+?)(?:/v1/|$)", url)
    return match.group(1) if match else url


def picture_key(url: str) -> str:
    """The picture plus the crop it was rendered as: two boxes, two renditions."""
    transform = re.search(r"/v1/([a-z]+)/", url)
    alignment = re.search(r"al_[a-z]+", url)
    return (f"{media_id(url)}|{transform.group(1) if transform else ''}"
            f"|{alignment.group(0) if alignment else ''}|{rendition_aspect(url):.2f}")


def requested_size(url: str) -> tuple[int, int]:
    """The size Wix was asked for, which is the box's shape rather than the file's."""
    width = rendition_width(url)
    height = re.search(r"[hH]_(\d+)", url)
    return (width, int(height.group(1)) if height else 0)


def rendition_aspect(url: str) -> float:
    """The shape Wix cropped this rendition to: its requested w_ over h_."""
    width, height = requested_size(url)
    return width / height if width and height else 0.0


def same_crop(left: str, right: str) -> bool:
    """One crop, allowing for the resizer's jitter.

    The two renditions are compared at a common height, so a pixel or two of rounding
    on the requested size does not flip the decision — the same tolerance the picture
    comparison uses.
    """
    left_w, left_h = requested_size(left)
    right_w, right_h = requested_size(right)
    if not (left_w and left_h and right_w and right_h):
        return False
    height = max(left_h, right_h)
    return abs(left_w * height / left_h - right_w * height / right_h) <= SIZE_TOLERANCE


def rendition_width(url: str) -> int:
    match = re.search(r"[wW]_(\d+)", url)
    return int(match.group(1)) if match else 0


def slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def fetch(url: str, attempts: int = 3) -> bytes:
    failure = None
    for _ in range(attempts):
        try:
            request = Request(url, headers={"User-Agent": USER_AGENT})
            with urlopen(request, timeout=90) as response:
                return response.read()
        except Exception as error:  # network flake: retry, then fail loudly
            failure = error
    raise RuntimeError(f"cannot download {url}: {failure}")


EMAIL = re.compile(r"^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$")
PHONE = re.compile(r"^\+?[\d][\d ()-]{6,}$")


def overlapping(left: list[int], right: list[int], tolerance: int = 8) -> bool:
    return (abs(left[0] - right[0]) <= tolerance and abs(left[1] - right[1]) <= tolerance
            and abs(left[2] - right[2]) <= tolerance and abs(left[3] - right[3]) <= tolerance)


def link_contact(block: str) -> str:
    """The contact page's served email and phone become mailto: and tel: links."""
    text = block.strip()
    if EMAIL.match(text):
        return f"[{text}](mailto:{text})"
    if PHONE.match(text):
        digits = re.sub(r"[^\d+]", "", text)
        return f"[{text}](tel:{digits})"
    return block


def probe_film(path: Path) -> tuple[int, int, float]:
    """Width, height and duration of a film, from ffprobe."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height,duration", "-of", "json", str(path)],
            capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"ffprobe could not read {path}: {error}. Install ffmpeg and retry.") from error
    stream = json.loads(result.stdout)["streams"][0]
    return int(stream.get("width", 0)), int(stream.get("height", 0)), float(stream.get("duration", 0) or 0)


def strip_site(text: str) -> str:
    return re.sub(r"\s*\|\s*" + re.escape(SITE_NAME) + r"\s*$", "", text).strip()


# --------------------------------------------------------------------------- #
# HTML -> Markdown
# --------------------------------------------------------------------------- #

BREAK = "\x00"


def inline_markdown(node) -> str:
    """Flatten one element into inline Markdown, keeping bold and links."""
    parts = [escape_md(node.text) if node.text else ""]
    for child in node:
        tag = child.tag.lower() if isinstance(child.tag, str) else ""
        if tag == "br":
            parts.append(BREAK)
        elif tag == "a":
            label = collapse("".join(child.itertext())).replace(BREAK, " ").strip()
            href = (child.get("href") or "").strip()
            parts.append(f"[{escape_md(label)}]({markdown_destination(rewrite_href(href))})" if href and label
                         else escape_md(label))
        elif tag in ("strong", "b"):
            parts.append(wrap_bold(inline_markdown(child)))
        elif tag in ("em", "i"):
            inner = finish_inline(inline_markdown(child))
            parts.append(f"*{inner}*" if inner else "")
        elif tag == "span":
            inner = inline_markdown(child)
            style = (child.get("style") or "").replace(" ", "").lower()
            if "font-weight:bold" in style and inner.strip():
                parts.append(wrap_bold(inner))
            else:
                parts.append(inner)
        else:
            parts.append(inline_markdown(child))
        if child.tail:
            parts.append(escape_md(child.tail))
    return "".join(parts)


def wrap_bold(value: str) -> str:
    """Bold a run while keeping the spaces that sat outside its words."""
    inner = finish_inline(value)
    if not inner:
        return value if value.strip() == "" else ""
    lead = " " if value[:1].isspace() else ""
    trail = " " if value[-1:].isspace() else ""
    return f"{lead}**{inner}**{trail}"


def finish_inline(value: str) -> str:
    """Clean an inline fragment: one line, no stray break markers, no double bold."""
    value = collapse(value.replace(BREAK, " ")).strip()
    return "" if value in ("**", "****") else value


def served_paragraphs(block_html: str) -> int:
    """How many paragraphs and headings the box serves, ignoring Wix's empty spacers."""
    fragment = lxml_html.fragment_fromstring(block_html, create_parent="div")
    counted = 0
    for element in fragment:
        tag = element.tag.lower() if isinstance(element.tag, str) else ""
        if tag in ("ul", "ol"):  # one Markdown block, whatever its item count
            counted += 1 if collapse(element.text_content()).strip() else 0
        elif collapse(element.text_content()).strip():
            counted += 1 + paragraph_breaks(element)
    return counted


def plain_text(block_html: str) -> str:
    fragment = lxml_html.fragment_fromstring(block_html, create_parent="div")
    return collapse(fragment.text_content()).strip()


def attribute(value: str) -> str:
    """Escape a value that goes into a double-quoted HTML attribute in Markdown."""
    for character, entity in (("&", "&amp;"), ('"', "&quot;"), ("<", "&lt;"), (">", "&gt;")):
        value = value.replace(character, entity)
    return value


def markdown_destination(href: str) -> str:
    """Encode what CommonMark refuses inside a bare link destination."""
    for character, encoded in ((" ", "%20"), ("(", "%28"), (")", "%29"), ("<", "%3C"), (">", "%3E")):
        href = href.replace(character, encoded)
    return href


def rewrite_href(href: str) -> str:
    """Point internal Wix links at the paths the new site serves."""
    if href in FILES:
        return FILES[href][1]
    parsed = urlparse(href)
    if "wixsite.com" not in (parsed.netloc or ""):
        return href
    slug = (parsed.path or "").split("/mysite", 1)[-1].strip("/")
    page = next((page for page in PAGES if page.slug == slug), None)
    return page.path if page else "/"


BODY_SIZE = 20.0


DOUBLE_BREAK = re.compile(r"(?:\x00\s*){2,}")


def paragraph_breaks(element) -> int:
    """How many blank lines a box draws with two or more <br> in a row."""
    markup = lxml_html.tostring(element, encoding="unicode")
    return len(re.findall(r"(?:<br[^>]*>\s*){2,}", markup))


def block_markdown(block_html: str, parts: list[dict] | None = None) -> list[str]:
    """Convert one rich-text component into Markdown blocks.

    Heading level comes from the tag Wix served. Wix also tags ordinary paragraphs
    as headings — the Thoughts essay is an <h1> at 18px — so a heading the page
    renders at body size is written as a paragraph, which is what a visitor sees.
    """
    fragment = lxml_html.fragment_fromstring(block_html, create_parent="div")
    out: list[str] = []
    for index, element in enumerate(fragment):
        tag = element.tag.lower() if isinstance(element.tag, str) else ""
        size = parts[index]["size"] if parts and index < len(parts) else None
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6") and (size is None or size > BODY_SIZE):
            for heading in finish_groups(inline_markdown(element)):
                out.append(f"{'#' * int(tag[1])} {heading}")
        elif tag in ("ul", "ol"):
            items = []
            for index, item in enumerate(element.iter("li"), start=1):
                body = finish(inline_markdown(item))
                if body:
                    items.append(("- " if tag == "ul" else f"{index}. ") + body)
            if items:
                out.append("\n".join(items))
        else:
            out.extend(finish_groups(inline_markdown(element), escape_leading=True))
    return out


def finish_groups(value: str, escape_leading: bool = False) -> list[str]:
    """Split one element's text into Markdown blocks.

    A single <br> is a line break inside a paragraph. Two or more in a row are the gap
    Wix draws between paragraphs, so they become a blank line: a new Markdown block.
    """
    value = collapse(value)
    blocks = []
    for paragraph in DOUBLE_BREAK.split(value):
        lines = [line.strip(" \t") for line in paragraph.split(BREAK)]
        lines = [line for line in lines if line.strip()]
        if not lines:
            continue
        joined = "  \n".join(lines)
        if escape_leading and joined[:1] in ("#", "-", ">"):
            joined = "\\" + joined
        blocks.append(joined)
    return blocks


def finish(value: str) -> str:
    """One Markdown block from an element, its paragraphs joined."""
    return "\n\n".join(finish_groups(value, escape_leading=True))


# --------------------------------------------------------------------------- #
# extraction
# --------------------------------------------------------------------------- #

@dataclass
class Picture:
    """One picture, at the rendition each breakpoint's box actually serves.

    Wix crops a `fill` rendition to the shape of the box it sits in, and the box has a
    different shape on a phone than on the desktop, so a picture keeps two renditions:
    the desktop one (taken at the widest desktop width) and the phone one.
    """

    media: str
    url: str
    width: int
    height: int = 0
    size: int = 0
    file: str = ""
    format: str = ""
    alt: str = ""
    caption: str = ""
    hint: str = ""
    payload: bytes | None = None
    mobile_url: str = ""
    mobile_width: int = 0
    mobile_height: int = 0
    mobile_size: int = 0
    mobile_file: str = ""
    mobile_format: str = ""
    mobile_payload: bytes | None = None
    pages: list[str] = field(default_factory=list)


@dataclass
class Film:
    """A film the page plays, carried at the rendition the Wix player serves."""

    url: str
    page: str
    label: str
    title: str = ""
    file: str = ""
    width: int = 0
    height: int = 0
    duration: float = 0.0
    size: int = 0
    poster: str = ""
    autoplay: bool = False
    muted: bool = False
    loop: bool = False


@dataclass
class Tile:
    """One square of the home page's Work grid."""

    media: str
    title: str
    caption: str
    href: str


class Extractor:
    def __init__(self, out: Path):
        self.out = out
        self.phone: dict[str, dict] = {}
        self.pictures: dict[str, Picture] = {}
        self.tiles: list[Tile] = []
        self.films: dict[str, Film] = {}
        self.pages: dict[str, dict] = {}
        self.notes: list[str] = []
        self.usage: dict[tuple[str, str, str], dict] = {}
        self.faces: dict[str, set[str]] = {}
        self.font_urls: dict[str, set[str]] = {}
        self.labels: dict[str, str] = {}
        self.nav_sequence: list[tuple[str, str]] = []
        self.order: dict[str, int] = {}

    # -- rendering ---------------------------------------------------------- #

    def render(self, browser, spec: Page, mobile: bool = False) -> dict:
        if mobile:
            context = browser.new_context(viewport=MOBILE_VIEWPORT, device_scale_factor=DPR,
                                          user_agent=MOBILE_UA, is_mobile=True, has_touch=True)
        else:
            context = browser.new_context(viewport=VIEWPORT, device_scale_factor=DPR,
                                          user_agent=USER_AGENT)
        page = context.new_page()
        fonts: set[str] = set()
        page.on("response", lambda r: fonts.add(r.url)
                if any(token in r.url for token in (".woff2", ".woff", ".ttf", ".otf")) else None)
        url = f"{BASE}/{spec.slug}" if spec.slug else BASE
        page.goto(url, wait_until="domcontentloaded", timeout=120000)
        try:
            page.wait_for_selector(".wixui-rich-text, main img", timeout=45000)
        except Exception:
            self.notes.append(f"{spec.file}: content did not appear in the render")
        page.wait_for_timeout(2500)
        height = page.evaluate("document.body.scrollHeight")
        offset = 0
        while offset < height:
            page.evaluate(f"window.scrollTo(0, {offset})")
            page.wait_for_timeout(250)
            offset += 600
            height = page.evaluate("document.body.scrollHeight")
        page.evaluate("window.scrollTo(0, 0)")
        page.wait_for_timeout(1500)
        data = page.evaluate(COLLECT_JS)
        data["font_files"] = sorted(fonts)
        context.close()
        return data

    # -- order -------------------------------------------------------------- #

    @staticmethod
    def in_document_order(blocks: list[dict]) -> list[dict]:
        """Rows top to bottom; inside a row, the order the document put them in.

        Blocks arrive in document order from one walk of the page, so this only lifts a
        block the document listed below its drawn position. Wix lays pages out as
        absolutely positioned columns, which is why the drawn position decides the row:
        on the Hot Mess page the document lists a heading before the picture above it.
        """
        rows: list[dict] = []
        for index, block in enumerate(blocks):  # already in document order
            top = block["rect"][1]
            row = next((row for row in rows if abs(row["top"] - top) <= 24), None)
            if row is None:
                rows.append({"top": top, "items": [(index, block)]})
            else:
                row["items"].append((index, block))
        rows.sort(key=lambda row: row["top"])
        return [block for row in rows for _, block in sorted(row["items"], key=lambda item: item[0])]

    # -- images ------------------------------------------------------------- #

    def register(self, url: str, alt: str, page: str, caption: str = "", hint: str = "",
                 mobile_url: str = "") -> str:
        """One picture, carrying the rendition its box serves at each breakpoint."""
        media = picture_key(url)
        picture = self.pictures.get(media)
        if picture is None:
            picture = self.pictures[media] = Picture(media=media, url=url, width=rendition_width(url),
                                                     hint=hint)
        elif rendition_width(url) > picture.width:
            picture.url = url
            picture.width = rendition_width(url)
        if mobile_url and rendition_width(mobile_url) > picture.mobile_width:
            picture.mobile_url = mobile_url
            picture.mobile_width = rendition_width(mobile_url)
        if not picture.alt and alt:
            picture.alt = collapse(alt).strip()
        if not picture.caption and caption:
            picture.caption = collapse(caption).strip()
        if page not in picture.pages:
            picture.pages.append(page)
        return media

    def phone_sources(self, page: str) -> dict[str, list[str]]:
        """The renditions a page's pictures are served in on a phone, per picture.

        A picture drawn in two places appears twice, so the list is in document order
        and the desktop walk takes the same occurrence.
        """
        sources: dict[str, list[str]] = {}
        for block in self.phone.get(page, {}).get("blocks", []):
            if block["kind"] == "image" and block.get("src"):
                sources.setdefault(media_id(block["src"]), []).append(block["src"])
        return sources

    @staticmethod
    def nth_rendition(sources: dict[str, list[str]], url: str, seen: dict[str, int]) -> str:
        """The phone rendition of this occurrence of the picture, if the phone has one."""
        media = media_id(url)
        sources_for = sources.get(media, [])
        index = seen.get(media, 0)
        seen[media] = index + 1
        return sources_for[index] if index < len(sources_for) else ""

    def download(self) -> None:
        directory = self.out / "public" / "images"
        directory.mkdir(parents=True, exist_ok=True)
        written: set[str] = set()
        names: dict[str, str] = {}

        def read(payload: bytes) -> tuple[int, int, str]:
            with tempfile.NamedTemporaryFile() as handle:
                handle.write(payload)
                handle.flush()
                with Image.open(handle.name) as probe:
                    return (*probe.size,
                            {"JPEG": "jpg", "PNG": "png", "WEBP": "webp", "GIF": "gif",
                             "AVIF": "avif"}.get((probe.format or "").upper(),
                                                 (probe.format or "jpg").lower()))

        for picture in sorted(self.pictures.values(), key=lambda p: p.media):
            payload = picture.payload if picture.payload is not None else fetch(picture.url)
            picture.width, picture.height, picture.format = read(payload)
            picture.size = len(payload)
            hint = picture.alt or picture.hint
            stem = (slugify(hint.rsplit(".", 1)[0]) if hint else slugify(picture.media.split("~")[0]))
            stem = (stem or "image")[:60].strip("-")
            name = f"{stem}.{picture.format}"
            if name in names:
                name = f"{stem}-{hashlib.sha1(picture.media.encode()).hexdigest()[:6]}.{picture.format}"
            names[name] = picture.media
            picture.file = name
            (directory / name).write_bytes(payload)
            written.add(name)
            # A phone box has its own shape, and Wix crops the picture to it; only
            # carry that rendition when it is a different crop from the desktop one.
            if picture.mobile_url and not same_crop(picture.url, picture.mobile_url):
                mobile = (picture.mobile_payload if picture.mobile_payload is not None
                          else fetch(picture.mobile_url))
                picture.mobile_width, picture.mobile_height, picture.mobile_format = read(mobile)
                picture.mobile_size = len(mobile)
                mobile_name = f"{stem}-mobile.{picture.mobile_format}"
                if mobile_name in names:
                    mobile_name = (f"{stem}-mobile-"
                                   f"{hashlib.sha1(picture.media.encode()).hexdigest()[:6]}"
                                   f".{picture.mobile_format}")
                names[mobile_name] = f"{picture.media}|mobile"
                picture.mobile_file = mobile_name
                (directory / mobile_name).write_bytes(mobile)
                written.add(mobile_name)
        for stale in directory.iterdir():
            if stale.suffix.lower() in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"):
                if stale.name not in written:
                    stale.unlink()

    def register_film(self, block: dict, page: str, poster: str) -> Film:
        film = self.films.get(block["src"])
        if film is None:
            label = collapse(block["label"]).strip()
            title = re.sub(r"\s*(?:Video Player|Play video)\s*$", "", label).strip()
            film = self.films[block["src"]] = Film(
                url=block["src"], page=page, label=label, title=title,
                poster=poster, autoplay=bool(block.get("autoplay")),
                muted=bool(block.get("muted")), loop=bool(block.get("loop")))
        return film

    def download_films(self) -> None:
        directory = self.out / "public" / "videos"
        directory.mkdir(parents=True, exist_ok=True)
        written: set[str] = set()
        counted: dict[str, int] = {}
        for film in sorted(self.films.values(), key=lambda f: (f.page, f.url)):
            counted[film.page] = counted.get(film.page, 0) + 1
            suffix = "" if counted[film.page] == 1 else f"-{counted[film.page]}"
            film.file = f"{film.page}{suffix}.mp4"
            target = directory / film.file
            target.write_bytes(fetch(film.url))
            written.add(film.file)
            film.size = target.stat().st_size
            film.width, film.height, film.duration = probe_film(target)
        for stale in directory.glob("*.mp4"):
            if stale.name not in written:
                stale.unlink()

    def film_manifest(self) -> dict:
        return {
            "source": BASE,
            "videos": [
                {"url": film.url, "file": f"videos/{film.file}", "width": film.width,
                 "height": film.height, "duration": round(film.duration, 3), "bytes": film.size,
                 "poster": f"images/{film.poster}" if film.poster else None,
                 "title": film.title, "autoplay": film.autoplay, "muted": film.muted,
                 "loop": film.loop, "pages": [film.page]}
                for film in sorted(self.films.values(), key=lambda f: f.file)
            ],
        }

    def prepare_facade(self, block: dict, page: str) -> None:
        """A YouTube trailer becomes a poster and a link; the player loads on click."""
        match = re.search(r"(?:youtube-nocookie|youtube)\.com/embed/([A-Za-z0-9_-]+)", block["src"])
        if not match:
            return
        identifier = match.group(1)
        for name in ("maxresdefault", "hqdefault"):
            url = f"https://i.ytimg.com/vi/{identifier}/{name}.jpg"
            try:
                payload = fetch(url, attempts=1)
            except RuntimeError:
                continue
            key = self.register(url, "", page, hint=f"{page}-trailer")
            self.pictures[key].payload = payload
            block["facade"] = key
            block["target"] = f"https://www.youtube-nocookie.com/embed/{identifier}"
            self.notes.append(f"{page}: YouTube trailer carried as a click-to-play facade "
                              f"({collapse(block['title']).strip()}); the player loads on click")
            return
        self.notes.append(f"{page}: YouTube trailer has no reachable thumbnail ({block['src']})")

    def manifest(self) -> dict:
        return {
            "source": BASE,
            "images": [
                {"url": picture.url, "file": f"images/{picture.file}",
                 "width": picture.width, "height": picture.height, "bytes": picture.size,
                 "format": picture.format, "alt": picture.alt, "caption": picture.caption,
                 "pages": picture.pages,
                 "mobile": ({"url": picture.mobile_url, "file": f"images/{picture.mobile_file}",
                             "width": picture.mobile_width, "height": picture.mobile_height,
                             "bytes": picture.mobile_size} if picture.mobile_file else None)}
                for picture in sorted(self.pictures.values(), key=lambda p: (p.pages[0], p.file))
            ],
        }

    # -- gallery ------------------------------------------------------------ #

    def read_gallery(self, data: dict) -> list[dict]:
        match = re.search(r'<script type="application/json" id="wix-warmup-data">(.*?)</script>',
                          data["html"], re.S)
        if not match:
            return []
        warmup = json.loads(match.group(1))
        items: list[dict] = []
        for app in warmup.get("appsWarmupData", {}).values():
            for key, value in app.items():
                if key.endswith("_galleryData"):
                    items.extend(value.get("items", []))
        return sorted(items, key=lambda item: item.get("orderIndex", 0))

    def read_tiles(self, spec: Page, data: dict) -> list[Tile]:
        by_label = {label.lower(): slug for slug, label in self.labels.items()}
        rendered = {tile["id"]: tile for tile in data["tiles"]}
        tiles: list[Tile] = []
        for position, item in enumerate(self.read_gallery(data)):
            meta = item.get("metaData", {})
            target = collapse((meta.get("link") or {}).get("text", ""))
            target = re.sub(r"^Go to Page\s*", "", target).strip()
            slug = by_label.get(target.lower())
            page: Page | None = next((page for page in PAGES if page.slug == slug), None) if slug else None
            title = collapse(meta.get("title", "")).strip()
            source = (rendered.get(item.get("itemId", "")) or {}).get("src", "")
            if not source:
                self.notes.append(f"{spec.file}: grid tile {title!r} has no rendered image")
                continue
            phone = self.phone_sources(spec.file).get(media_id(source), [])
            key = self.register(source, "", spec.file, caption=meta.get("description", ""), hint=title,
                                mobile_url=phone[0] if phone else "")
            if page is None:
                self.notes.append(f"{spec.file}: grid tile {meta.get('title')!r} links to {target!r}, "
                                  "which is not one of the 15 pages")
                continue
            tiles.append(Tile(media=key, title=title,
                              caption=collapse(meta.get("description", "")).strip(), href=page.path))
        return tiles

    # -- fonts -------------------------------------------------------------- #

    def font_key(self, family: str) -> str:
        primary = family.split(",")[0].strip().strip("'\"").lower()
        for key in sorted(FONTS, key=len, reverse=True):  # longest match wins
            if primary.startswith(key):
                return key
        if primary.startswith("cormorant"):
            return "cormorant garamond"
        return primary

    def collect_fonts(self, spec: Page, data: dict) -> None:
        for area, rows in data["styles"].items():
            for key, row in rows.items():
                family, weight, style, size = key.split("||")
                variant = family.split(",")[0].strip().strip("'\"").lower()
                bucket = self.usage.setdefault((self.font_key(family), variant, weight),
                                               {"count": 0, "pages": set(), "areas": set(),
                                                "sizes": set(), "sample": ""})
                bucket["count"] += row["count"]
                if not bucket["sample"] and row.get("sample"):
                    bucket["sample"] = row["sample"]
                bucket["pages"].add(spec.file)
                bucket["areas"].add(area)
                bucket["sizes"].add(size)
        for face in data["faces"]:
            family = collapse(face.get("family") or "").strip("'\"")
            if not family:
                continue
            self.faces.setdefault(self.font_key(family), set()).add(face.get("weight") or "400")
        for url in data["font_files"]:
            flat = re.sub(r"[^a-z0-9]", "", url.lower())
            for key in FONTS:
                if re.sub(r"[^a-z0-9]", "", key) in flat:
                    self.font_urls.setdefault(key, set()).add(url)

    def font_family(self, key: str) -> str:
        if key in self.usage_keys():
            pass
        return FONTS[key]["name"] if key in FONTS else key

    def usage_keys(self) -> set[str]:
        return {key for key, _, _ in self.usage}

    def ship_fonts(self) -> list[dict]:
        directory = self.out / "public" / "fonts"
        directory.mkdir(parents=True, exist_ok=True)
        for stale in directory.glob("*.woff*"):
            stale.unlink()
        shipped: list[dict] = []
        for key, info in FONTS.items():
            if info["verdict"] != "self-host" or key not in self.usage_keys():
                continue
            urls = sorted(self.font_urls.get(key, set()))
            woff2 = [url for url in urls if url.endswith(".woff2")]
            for index, url in enumerate(woff2 or urls, start=1):
                payload = fetch(url)
                name = f"{slugify(key)}-{index}.woff2"
                (directory / name).write_bytes(payload)
                shipped.append({"family": key, "file": name, "url": url, "size": len(payload)})
        for family, subsets in SUBSTITUTES.items():
            for subset, url in subsets.items():
                (directory / f"{slugify(family)}-{subset}.woff2").write_bytes(fetch(url))
        return shipped

    def font_report(self, shipped: list[dict]) -> str:
        lines = [
            "# Fonts",
            "",
            "Every font family and weight the live Wix site loads, where it comes from, and",
            "what this repository does about it. Generated by `scripts/extract.py`; do not edit",
            "by hand, and `--check` fails if it stops matching the live site.",
            "",
            "## Summary",
            "",
            "| Family | Wix face | Weight | Licence | Decision |",
            "| --- | --- | --- | --- | --- |",
        ]
        rows = []
        for (key, variant, weight) in sorted(self.usage, key=lambda k: (k[0], k[1], k[2])):
            info = FONTS.get(key)
            decision = {
                "self-host": "self-hosted in `public/fonts/`",
                "substitute": f"not self-hostable, nearest Google Font **{info['substitute'] if info else '?'}**",
                "system": "system stack, nothing to ship",
                "wix-chrome": "Wix platform chrome, not part of the site's own type",
            }.get(info["verdict"] if info else "", "unclassified, check by hand")
            rows.append(f"| {info['name'] if info else key} | `{variant}` | {weight} | "
                        f"{info['licence'] if info else 'unknown'} | {decision} |")
        lines.extend(rows)

        lines += ["", "## Families", ""]
        for key in sorted(self.usage_keys()):
            info = FONTS.get(key)
            lines += [f"### {info['name'] if info else key}", ""]
            if info:
                lines.append(f"- licence: {info['licence']}. {info['note']}")
            for (family_key, variant, weight) in sorted(k for k in self.usage if k[0] == key):
                entry = self.usage[(family_key, variant, weight)]
                sizes = ", ".join(sorted(entry["sizes"],
                                          key=lambda s: float(re.sub(r"[^0-9.]", "", s) or 0)))
                sample = f", e.g. \"{entry['sample']}\"" if entry["sample"] else ""
                elements = "element" if entry["count"] == 1 else "elements"
                lines.append(f"- `{variant}` weight {weight}, {sizes}: {entry['count']} text {elements} "
                             f"in {', '.join(sorted(entry['areas']))} on {', '.join(sorted(entry['pages']))}"
                             f"{sample}")
            if self.faces.get(key):
                lines.append(f"- declared weights: {', '.join(sorted(self.faces[key]))}")
            for url in sorted(self.font_urls.get(key, set())):
                lines.append(f"- file: `{url}`")
            if info and info["substitute"]:
                lines.append(f"- substitute: {info['substitute']} (Google Fonts, SIL Open Font License 1.1)")
            lines.append("")
        if shipped:
            families = sorted({FONTS[entry["family"]]["name"] for entry in shipped})
            lines += ["## Self-hosted files", "",
                      f"{' and '.join(families)} {'are' if len(families) > 1 else 'is'} under the SIL Open "
                      "Font License 1.1, which permits redistribution. Keep `public/fonts/OFL.txt` beside "
                      "the files.", ""]
            for entry in sorted(shipped, key=lambda s: s["file"]):
                lines.append(f"- `public/fonts/{entry['file']}` ({entry['size']} bytes) from `{entry['url']}`")
            lines.append("")
        return "\n".join(lines)

    # -- pages -------------------------------------------------------------- #

    @staticmethod
    def slug_for(href: str) -> str:
        parsed = urlparse(href)
        if href.rstrip("/") == BASE.rstrip("/"):
            return ""
        return (parsed.path or "").split("/mysite", 1)[-1].strip("/")

    def read_nav(self, home: dict) -> None:
        for anchor in home["nav"]:
            if anchor["label"] and anchor["label"] != SITE_NAME:
                page = next((page for page in PAGES if page.slug == self.slug_for(anchor["href"])), None)
                if page is not None:
                    self.nav_sequence.append((anchor["label"], page.path))
            parsed = urlparse(anchor["href"])
            slug = (parsed.path or "").split("/mysite", 1)[-1].strip("/")
            if anchor["href"].rstrip("/") == BASE.rstrip("/"):
                slug = ""
            page = next((page for page in PAGES if page.slug == slug), None)
            if page is None or slug in self.labels or not anchor["label"]:
                continue
            if anchor["label"] == SITE_NAME:  # the logo links home too
                continue
            self.labels[slug] = anchor["label"]
            if page.kind == "case_study":
                self.order[slug] = len(self.order) + 1
        missing = [page.slug for page in PAGES if page.slug not in self.labels]
        if missing:
            raise SystemExit(f"nav does not link these pages: {missing}")
        if self.labels.get("") != HOME_LABEL:
            raise SystemExit(f"home nav label is {self.labels.get('')!r}, expected {HOME_LABEL!r}")


    def page_markdown(self, spec: Page) -> str:
        data = self.pages[spec.file]
        body: list[str] = []
        tiles_written = False
        blocks = self.in_document_order(data["blocks"])
        posters = {id(block) for block in self.poster_blocks(blocks)}
        for block in blocks:
            kind = block["kind"]
            if kind == "text":
                if block.get("inForm"):  # shown only after the form is submitted
                    continue
                pieces = block_markdown(block["html"], block.get("parts"))
                served = served_paragraphs(block["html"])
                if len(pieces) != served:
                    self.notes.append(f"{spec.file}: box {block['id']} wrote {len(pieces)} "
                                      f"Markdown blocks for {served} served paragraphs")
                body.extend(pieces)
            elif kind == "image":
                if id(block) in posters:
                    continue
                if spec.kind == "home":
                    if not tiles_written:
                        body.extend(self.tile_markdown())
                        tiles_written = True
                    continue
                key = picture_key(block["src"])
                alt = escape_md(collapse(block["alt"]).strip())
                image = f"![{alt}](/images/{self.pictures[key].file})"
                href = rewrite_href(block.get("href") or "")
                body.append(f"[{image}]({markdown_destination(href)})" if href else image)
            elif kind == "video":
                body.append(self.video_markdown(block))
            elif kind == "embed":
                if block.get("facade"):
                    picture = self.pictures[block["facade"]]
                    title = escape_md(collapse(block["title"]).strip())
                    body.append(f"[![{title}](/images/{picture.file})]({block['target']})")
                else:
                    self.notes.append(f"{spec.file}: embedded player not carried: "
                                      f"{block['title']} ({block['src']})")
            elif kind == "form":
                # Michael's decision: the contact page keeps mailto, tel and the social
                # links and drops the form, which a static host cannot accept.
                fields = ", ".join(field["label"] or field["name"] for field in block["fields"])
                self.notes.append(f"{spec.file}: form dropped by decision "
                                  f"(fields {fields}, button {block['submit']!r})")
        if spec.kind == "home" and not tiles_written:
            body.extend(self.tile_markdown())

        front = [
            "---",
            f"title: {json.dumps(strip_site(collapse(data['title'])), ensure_ascii=False)}",
            f"nav_label: {json.dumps(self.labels[spec.slug], ensure_ascii=False)}",
            f"order: {self.order[spec.slug] if spec.kind == 'case_study' else 'null'}",
            f"path: {json.dumps(spec.path)}",
            f"kind: {spec.kind}",
            "---",
            "",
        ]
        if spec.file == "contact":
            body = [link_contact(block) for block in body]
        return "\n".join(front) + "\n\n".join(body).strip() + "\n"

    @staticmethod
    def poster_blocks(blocks: list[dict]) -> list[dict]:
        """The image a film plays over: the still drawn at the same place."""
        stills = []
        videos = [block for block in blocks if block["kind"] == "video"]
        for block in blocks:
            if block["kind"] != "image":
                continue
            for video in videos:
                if overlapping(block["rect"], video["rect"]):
                    stills.append(block)
                    break
        return stills

    def video_markdown(self, block: dict) -> str:
        film = self.films[block["src"]]
        attributes = []
        if film.autoplay:
            attributes += ["autoplay", "muted", "loop", "playsinline"]
        else:
            attributes += ['controls', 'preload="metadata"']
        if film.title:
            attributes.append(f'title="{attribute(film.title)}"')
        if film.poster:
            attributes.append(f'poster="/images/{film.poster}"')
        return f'<video {" ".join(attributes)} src="/videos/{film.file}"></video>'

    def site_markdown(self) -> str:
        """The header and footer every page shares, exactly as served."""
        nav = [f"- [{escape_md(label)}]({markdown_destination(path)})"
               for label, path in self.nav_sequence]
        footer = [" · ".join(
            f"[{escape_md(link['label'])}]({markdown_destination(rewrite_href(link['href']))})"
            for link in self.pages["home"]["footerLinks"]
            if link["label"] and not link.get("inText"))]
        for block_html in self.pages["home"]["footerBlocks"]:
            footer.extend(block_markdown(block_html, None))
        lines = ["## Header", "\n".join(nav), "## Footer", "\n\n".join(filter(None, footer))]
        front = ["---", 'title: "Site"', "nav_label: null", "order: null", "path: null",
                 'kind: "site"', "---", ""]
        return "\n".join(front) + "\n\n".join(lines).strip() + "\n"

    def tile_markdown(self) -> list[str]:
        """One Work tile: served title as alt text, served caption as the link title."""
        lines = []
        for tile in self.tiles:
            file = self.pictures[tile.media].file
            title = f' "{escape_md(tile.caption).replace(chr(34), "")}"' if tile.caption else ""
            lines.append(f"[![{escape_md(tile.title)}](/images/{file})]({markdown_destination(tile.href)}{title})")
        return lines

    # -- driver ------------------------------------------------------------- #

    def run(self) -> None:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for spec in PAGES:
                data = self.render(browser, spec)
                self.pages[spec.file] = data
                # Every page is read a second time on a phone: Wix crops a picture to
                # the shape of the box it sits in, and the phone layout's boxes have
                # their own shape.
                self.phone[spec.file] = self.render(browser, spec, mobile=True)
                self.collect_fonts(spec, data)
            browser.close()

        self.read_nav(self.pages["home"])
        self.tiles = self.read_tiles(PAGES[0], self.pages["home"])
        for spec in PAGES:
            position = 0
            phone = self.phone_sources(spec.file)
            seen: dict[str, int] = {}
            for block in self.in_document_order(self.pages[spec.file]["blocks"]):
                if block["kind"] == "image":
                    position += 1
                    self.register(block["src"], block["alt"], spec.file,
                                  hint=f"{spec.file}-{position}",
                                  mobile_url=self.nth_rendition(phone, block["src"], seen))

        for spec in PAGES:
            for block in self.pages[spec.file]["blocks"]:
                if block["kind"] == "video":
                    self.register_film(block, spec.file, "")
                elif block["kind"] == "embed":
                    self.prepare_facade(block, spec.file)

        self.download()

        for spec in PAGES:
            blocks = self.in_document_order(self.pages[spec.file]["blocks"])
            for block in self.poster_blocks(blocks):
                for video in (item for item in blocks if item["kind"] == "video"):
                    if overlapping(block["rect"], video["rect"]):
                        film = self.films.get(video["src"])
                        if film is not None and not film.poster:
                            film.poster = self.pictures[picture_key(block["src"])].file
        self.download_films()

        content = self.out / "content"
        content.mkdir(parents=True, exist_ok=True)
        for spec in PAGES:
            (content / f"{spec.file}.md").write_text(self.page_markdown(spec), encoding="utf-8")
        (content / "_site.md").write_text(self.site_markdown(), encoding="utf-8")

        film_path = self.out / "videos" / "manifest.json"
        film_path.parent.mkdir(parents=True, exist_ok=True)
        film_path.write_text(json.dumps(self.film_manifest(), indent=2, ensure_ascii=False) + "\n",
                             encoding="utf-8")

        manifest = self.out / "images" / "manifest.json"
        manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text(json.dumps(self.manifest(), indent=2, ensure_ascii=False) + "\n",
                            encoding="utf-8")

        for url, (path, _) in FILES.items():
            target = self.out / "public" / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(fetch(url))

        shipped = self.ship_fonts()
        (self.out / "fonts").mkdir(parents=True, exist_ok=True)
        (self.out / "fonts" / "REPORT.md").write_text(self.font_report(shipped), encoding="utf-8")

        print(f"content files: {len(PAGES)} pages + _site.md")
        print(f"images: {len(self.pictures)}")
        print(f"manifest rows: {len(self.pictures)}")
        print(f"videos: {len(self.films)}")
        print(f"fonts self-hosted: {len(shipped)}")
        if self.notes:
            print("not captured:")
            for note in self.notes:
                print(f"  - {note}")


# --------------------------------------------------------------------------- #

def picture_hash(image: Image.Image, size: int = 8) -> int:
    """Which side of its neighbour each of 64 grey cells falls on."""
    grey = image.convert("L").resize((size + 1, size), Image.LANCZOS)
    pixels = list(grey.getdata())
    bits = 0
    for row in range(size):
        for column in range(size):
            offset = row * (size + 1) + column
            bits = (bits << 1) | int(pixels[offset] > pixels[offset + 1])
    return bits


def read_picture(payload: bytes) -> tuple[tuple[int, int], int, Image.Image]:
    image = Image.open(io.BytesIO(payload)).convert("RGB")
    return image.size, picture_hash(image), image


def mean_difference(left: Image.Image, right: Image.Image) -> float:
    histogram = ImageChops.difference(left, right).convert("L").histogram()
    return sum(value * count for value, count in enumerate(histogram)) / (sum(histogram) or 1)


def files_under(root: Path, patterns: list[str]) -> dict[str, bytes]:
    found: dict[str, bytes] = {}
    for pattern in patterns:
        for path in sorted(root.glob(pattern)):
            if path.is_file():
                found[str(path.relative_to(root))] = path.read_bytes()
    return found


def normalized_manifest(payload: bytes) -> dict:
    """The manifest without the byte counts, which a re-encode changes."""
    manifest = json.loads(payload)
    for row in manifest.get("images", []):
        row.pop("bytes", None)
        if row.get("mobile"):
            row["mobile"].pop("bytes", None)
    return manifest


def compare(root: Path, scratch: Path) -> tuple[list[str], dict[str, int]]:
    """Everything that differs between the committed tree and a fresh extraction."""
    problems: list[str] = []
    for description, patterns in (("text", TEXT_OUTPUT), ("binary", BINARY_OUTPUT)):
        committed = files_under(root, patterns)
        fresh = files_under(scratch, patterns)
        for name in sorted(set(committed) | set(fresh)):
            if name not in fresh:
                problems.append(f"{name}: in the repository, no longer on the site")
            elif name not in committed:
                problems.append(f"{name}: on the site, missing from the repository")
            elif committed[name] != fresh[name]:
                problems.append(f"{name}: {description} changed")

    committed_manifest = root / MANIFEST
    fresh_manifest = scratch / MANIFEST
    if not fresh_manifest.exists():
        problems.append(f"{MANIFEST}: missing from the fresh extraction")
    else:
        old = {row["file"]: row for row in
               normalized_manifest(committed_manifest.read_bytes()).get("images", [])}
        new = {row["file"]: row for row in
               normalized_manifest(fresh_manifest.read_bytes()).get("images", [])}
        for name in sorted(set(old) | set(new)):
            if name not in new:
                problems.append(f"{MANIFEST}: {name} is no longer referenced")
                continue
            if name not in old:
                problems.append(f"{MANIFEST}: {name} is newly referenced")
                continue
            changed = [field for field in ("pages", "alt", "caption", "format")
                       if old[name].get(field) != new[name].get(field)]
            if (not same_size((old[name]["width"], old[name]["height"]),
                              (new[name]["width"], new[name]["height"]))):
                changed.append("size")
            if without_requested_size(old[name]["url"]) != without_requested_size(new[name]["url"]):
                changed.append("url")
            old_phone, new_phone = old[name].get("mobile") or {}, new[name].get("mobile") or {}
            if (old_phone.get("file") != new_phone.get("file")
                    or without_requested_size(old_phone.get("url") or "")
                    != without_requested_size(new_phone.get("url") or "")
                    or not same_size((old_phone.get("width") or 0, old_phone.get("height") or 0),
                                     (new_phone.get("width") or 0, new_phone.get("height") or 0))):
                changed.append("phone rendition")
            if changed:
                problems.append(f"{MANIFEST}: {name} changed ({', '.join(sorted(changed))})")

    committed_pictures = files_under(root, [PICTURES])
    fresh_pictures = files_under(scratch, [PICTURES])
    counts = {"same": 0, "re-encoded": 0}
    for name in sorted(set(committed_pictures) | set(fresh_pictures)):
        if name not in fresh_pictures:
            problems.append(f"{name}: in the repository, no longer on the site")
        elif name not in committed_pictures:
            problems.append(f"{name}: on the site, missing from the repository")
        elif committed_pictures[name] == fresh_pictures[name]:
            counts["same"] += 1
        else:
            old_size, old_hash, old_image = read_picture(committed_pictures[name])
            new_size, new_hash, new_image = read_picture(fresh_pictures[name])
            if not same_size(old_size, new_size):
                problems.append(f"{name}: {new_size[0]}x{new_size[1]} on the site, "
                                f"{old_size[0]}x{old_size[1]} in the repository")
            else:
                # Compare on one shape: a rendition that jitters by a pixel or two still
                # has to match pixel for pixel, or the hash alone would call a newly
                # swapped flat picture the same.
                comparable = (new_image if old_size == new_size
                              else new_image.resize(old_size, Image.LANCZOS))
                difference = mean_difference(old_image, comparable)
                if (bin(old_hash ^ new_hash).count("1") > STRUCTURE_SAME
                        or difference > PIXEL_SAME):
                    problems.append(f"{name}: a different picture at that URL "
                                    f"(mean pixel difference {difference:.1f} of 255)")
                else:
                    counts["re-encoded"] += 1
    return problems, counts


def check(root: Path) -> int:
    with tempfile.TemporaryDirectory() as scratch:
        build(Path(scratch))
        problems, counts = compare(root, Path(scratch))
    if problems:
        print("the live site no longer matches this checkout:")
        for problem in problems:
            print(f"  {problem}")
        return 1
    phone = sum(1 for name in files_under(root, [PICTURES]) if "-mobile." in name)
    print(f"ok: the live site matches content/, images/, fonts/ and public/ — "
          f"{counts['same']} pictures byte-identical "
          f"({counts['same'] - phone} at the desktop crop, {phone} at the phone's), "
          f"{counts['re-encoded']} re-encoded by Wix but the same picture")
    return 0


def build(root: Path) -> None:
    Extractor(root).run()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    if sys.version_info < (3, 12):
        raise SystemExit(f"scripts/extract.py needs Python 3.12 or newer, this is "
                         f"{sys.version_info.major}.{sys.version_info.minor}")
    parser.add_argument("--check", action="store_true",
                        help="re-extract into a temporary directory and fail on any difference")
    arguments = parser.parse_args()
    if arguments.check:
        return check(ROOT)
    build(ROOT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
