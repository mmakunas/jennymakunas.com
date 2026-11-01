// Text metrics for the build: how many lines a block's copy takes at its
// captured width, and therefore how tall the box really is. The page positions
// come from the capture, so a box that grows (Jost is wider than Futura) has to
// push what follows down rather than overlap it.
import * as fontkit from 'fontkit';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
// One entry per rendered family, keyed by the name src/lib/site.js gives the
// font stack it actually emits: Jost stands in for Futura, Mulish for Avenir and
// for the Helvetica fallback. Cormorant ships a real bold face, the others are
// variable files whose default instance is the regular weight.
const files = {
  futura: 'public/fonts/jost-latin.woff2',
  avenir: 'public/fonts/mulish-latin.woff2',
  system: 'public/fonts/mulish-latin.woff2',
  cormorant: 'public/fonts/cormorant-garamond-1.woff2',
};
const boldFiles = { cormorant: 'public/fonts/cormorant-garamond-2.woff2' };

// A variable file opened at its default instance is the regular weight, so a
// bold run is wider by the ratio measured off the font's own advance widths.
const BOLD = 1.067;
// A box whose capture records no line height uses the font's own: measured in
// Chromium on the built page, per family and weight.
const NORMAL_LINE = { futura: 1.45, avenir: 1.15, system: 1.15, cormorant: 1.21 };
const normalLine = (family, weight) => (family === 'cormorant' && weight >= 600 ? 1.15 : NORMAL_LINE[family] || 1.2);
// The shaper and the browser disagree slightly on the same glyph run; the scale
// is calibrated against widths measured on the built page in Chromium.
const SCALE = 1.05;
const cache = new Map();
const fontFor = (family, weight) => {
  const bold = weight >= 600;
  const key = `${family}:${bold ? 700 : 400}`;
  if (cache.has(key)) return cache.get(key);
  const file = (bold && boldFiles[family]) || files[family] || files.futura;
  const font = fontkit.openSync(path.join(root, file));
  cache.set(key, { font, synthetic: bold && !boldFiles[family] });
  return cache.get(key);
};

export function widthOf(text, { family = 'futura', size = 16, weight = 400, spacing = 0 } = {}) {
  const { font, synthetic } = fontFor(family, weight);
  const base = font.layout(text).advanceWidth / font.unitsPerEm;
  return (base * SCALE * (synthetic ? BOLD : 1) * size) + Math.max(0, text.length - 1) * spacing;
}

// Greedy word wrap, which is what a browser does inside a box.
export function lineCount(text, opts) {
  const width = opts.width;
  if (!text) return 1;
  const words = text.split(/\s+/).filter(Boolean);
  let lines = 1;
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (widthOf(candidate, opts) <= width || !line) {
      line = candidate;
    } else {
      lines += 1;
      line = word;
    }
  }
  return lines;
}

const plain = (html) =>
  String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');

// The size a capture's single line of type needs to stay on one line in the
// substitute face. Jost runs a few percent wider than Futura, so a heading that
// fitted its Wix box would otherwise wrap and shove the page below it down.
export function fitSize(html, { width, family, size, weight, spacing, lines = 1, minRatio = 0.86 }) {
  const fits = (s) => textHeight(html, { width, family, size: s, weight, spacing }).lines <= lines;
  if (fits(size)) return size;
  const floor = size * minRatio;
  if (!fits(floor)) return size;
  let lo = floor;
  let hi = size;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  return Math.floor(lo * 10) / 10;
}

// Height of a text block at a given width. Wix's rich text carries its own line
// structure — where the lines break, and each line's own size — so the markup is
// walked line by line: a line set smaller takes fewer pixels, and an empty line
// between paragraphs takes a full one.
export function textHeight(html, { width, family, size, weight, lineHeight, spacing }) {
  const base = size || 16;
  const baseLine = lineHeight || base * normalLine(family, weight);
  const parts = String(html).split(/((?:<br[^>]*>\s*)+)/i);
  let lines = 0;
  let height = 0;
  let paragraphs = 0;
  let pending = 0;
  for (let i = 0; i < parts.length; i += 1) {
    if (i % 2 === 1) {
      pending = (parts[i].match(/<br/gi) || []).length;
      continue;
    }
    const raw = parts[i];
    const text = plain(raw).trim();
    if (!text) continue;
    const own = /font-size:\s*([\d.]+)(px|em)/.exec(raw);
    const ownSize = own ? (own[2] === 'em' ? base * Number(own[1]) : Number(own[1])) : base;
    const ownLine = lineHeight ? baseLine * (ownSize / base) : ownSize * normalLine(family, weight);
    const ownSpacing = spacing ? spacing * (ownSize / base) : 0;
    const count = text.split('\n').reduce((n, part) => n + lineCount(part, { width, family, size: ownSize, weight, spacing: ownSpacing }), 0);
    lines += count;
    height += count * ownLine;
    if (pending > 1) {
      // A blank line is one empty line of the box's own type.
      const blanks = pending - 1;
      lines += blanks;
      height += blanks * baseLine;
      paragraphs += 1;
      pending = 0;
      continue;
    }
    pending = 0;
    paragraphs = Math.max(paragraphs, 1);
  }
  if (pending > 1) height += (pending - 1) * baseLine;
  return { lines, height, paragraphs: Math.max(paragraphs, 1) };
}
