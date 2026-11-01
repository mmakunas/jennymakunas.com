// Composes each page from two sources: `content/<slug>.md` supplies the words
// and the images (so editing Markdown changes the site), `src/layout/*.json`
// supplies where and how big each block sits on the live Wix page.
//
// Geometry model, measured from the live site:
//   desktop — blocks sit at fixed vertical offsets in a 983px canvas that
//             stretches horizontally with the viewport, so every block records
//             a rect at 983 and at 1440 and CSS interpolates linearly between
//             them (`calc(a + b·100cqw)`);
//   mobile  — the phone layout is a separate 320px canvas scaled uniformly to
//             the device width, so every length is a share of that width.
import { readFileSync } from 'node:fs';
import { inline } from './content.js';
import path from 'node:path';
import { allPages, siteContent } from './content.js';
import { textHeight, fitSize } from './metrics.js';

const root = process.cwd();
const read = (rel) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));

export const REF = 983;
export const WIDE = 1440;
export const MOBILE_DESIGN = 320;

let cachedSite = null;
const site = () => (cachedSite ??= read('src/layout/site.json'));
const layoutCache = new Map();
export const layoutOf = (slug) => {
  if (!layoutCache.has(slug)) layoutCache.set(slug, read(`src/layout/${slug}.json`));
  return layoutCache.get(slug);
};

const manifest = read('images/manifest.json');
// Wix serves one image under many renditions; the media id in the file name
// survives every rendition, so it is the join key between capture and tree.
const mediaId = (url) => {
  const m = /([0-9a-f]{6}_[0-9a-f]{32}~mv2\.[a-z]+)/i.exec(url || '');
  return m ? m[1].toLowerCase() : (url || '').split('/').pop().split('?')[0].toLowerCase();
};
// Wix crops a picture to the shape of its box, and the phone's box is a different
// shape, so a picture carries a second rendition for the phone layout.
const phoneImages = new Map(manifest.images
  .filter((i) => i.mobile && i.mobile.file)
  .map((i) => [`/${i.file}`, `/${i.mobile.file}`]));
// The reverse join: a Markdown image path back to the media id Wix serves it as.
const fileToMedia = new Map(manifest.images.map((i) => [`/${i.file}`, mediaId(i.url)]));
const phoneImage = (src) => phoneImages.get(src) || null;

// Markdown links are written as site paths; in the built page they carry the
// deploy base like every other internal URL.
const BASE = (import.meta.env?.BASE_URL || '/').replace(/\/?$/, '/');
const withBase = (html) => String(html).replace(/href="\/(?!\/)/g, `href="${BASE}`);

const fmt = (n) => String(Math.round(n * 100) / 100);
const lin = (a, b) => {
  const m = (b - a) / (WIDE - REF);
  return { c: a - REF * m, m };
};
// Below the captured desktop width Wix serves that layout unchanged — the page
// is wider than the window and scrolls sideways — so the container never counts
// for less than the width the layout was captured at.
const scale = (c, m) => (m ? `calc(${fmt(c)}px + ${fmt(m)} * max(${REF}px, 100cqw))` : `${fmt(c)}px`);
const linCss = (a, b, prop) => {
  const { c, m } = lin(a, b);
  return `${prop}:${scale(c, m)}`;
};
const mq = (px) => `${fmt((px / MOBILE_DESIGN) * 100)}cqw`;

const FONT_STACK = {
  cormorant: "'Cormorant Garamond', Georgia, 'Times New Roman', serif",
  futura: "'Jost', Futura, 'Century Gothic', sans-serif",
  avenir: "'Mulish', 'Avenir Next', Helvetica, sans-serif",
  system: "'Helvetica Neue', Helvetica, Arial, sans-serif",
};
const family = (font) => {
  const f = (font || '').toLowerCase();
  if (f.startsWith('cormorant')) return 'cormorant';
  if (f.startsWith('futura')) return 'futura';
  if (f.startsWith('avenir')) return 'avenir';
  return 'system';
};

// Declarations shared by both breakpoints: everything about type that the Wix
// capture fixes in absolute terms.
const sharedCss = (block) => {
  const s = block.style || {};
  const out = [`font-family:${FONT_STACK[family(s.font)]}`];
  if (s.weight) out.push(`font-weight:${s.weight}`);
  if (s.color) out.push(`color:${s.color}`);
  if (s.style && s.style !== 'normal') out.push(`font-style:${s.style}`);
  if (s.transform && s.transform !== 'none') out.push(`text-transform:${s.transform}`);
  return out.join(';');
};

const layoutCss = (block, mode) => {
  const r = block.rect;
  const wide = block.wide || r;
  const s = block.style || {};
  const out = [];
  if (mode === 'desktop') {
    // Vertical offsets are fixed on most pages, but a block below a grid that
    // stretches moves with it, so top interpolates like left and width.
    out.push(linCss(r.x, wide.x, 'left'), linCss(r.w, wide.w, 'width'), linCss(r.y, wide.y ?? r.y, 'top'));
    if (block.kind !== 'text') out.push(linCss(r.h, wide.h ?? r.h, 'height'));
    if (s.size) out.push(`font-size:${fmt(block.fit || s.size)}px`);
    if (s.lineHeight) out.push(`line-height:${fmt(s.lineHeight * ((block.fit || s.size) / s.size))}px`);
    if (s.align) out.push(`text-align:${s.align}`);
    if (s.spacing) out.push(`letter-spacing:${fmt(s.spacing)}px`);
  } else {
    out.push(`left:${mq(r.x)}`, `width:${mq(r.w)}`, `top:${mq(r.y)}`);
    if (block.kind !== 'text') out.push(`height:${mq(r.h)}`);
    if (s.size) out.push(`font-size:${mq(s.size)}`);
    if (s.lineHeight) out.push(`line-height:${mq(s.lineHeight)}`);
    if (s.align) out.push(`text-align:${s.align}`);
    if (s.spacing) out.push(`letter-spacing:${mq(s.spacing)}`);
  }
  return out.join(';');
};

// Replaces the top of a block's declarations with a computed one.
const withTop = (css, top) => String(css).replace(/(^|;)top:[^;]*/, `$1${top}`);

// A player URL carries Wix's own origin in its query string; the rebuild links
// to the film itself, so reduce an embed URL to the video it plays.
const cleanEmbed = (u) => {
  if (!u) return null;
  const yt = /youtube(?:-nocookie)?\.com\/embed\/([\w-]+)/.exec(u);
  if (yt) return `https://www.youtube.com/watch?v=${yt[1]}`;
  const vimeo = /player\.vimeo\.com\/video\/(\d+)/.exec(u);
  if (vimeo) return `https://vimeo.com/${vimeo[1]}`;
  return u.includes('wixsite.com') || u.includes('wixstatic') ? null : u;
};
const norm = (s) => (s || '').replace(/[\s\u200b]+/g, ' ').trim().toLowerCase();
const sameText = (a, b) => {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || y.startsWith(x.slice(0, 24)) || x.startsWith(y.slice(0, 24));
};

// Wix rich text carries its own line structure: where each line breaks and how
// big that line is set. The Markdown cannot say that, so the capture does,
// segment by segment, in the order the copy runs.
const BR_RUN = /((?:<br[^>]*>\s*)+)/i;
const segmentsOf = (html) => String(html).split(BR_RUN);

const capturedShape = (html, size) => {
  const parts = segmentsOf(html);
  const shape = [];
  let breaks = 0;
  for (let i = 0; i < parts.length; i += 1) {
    if (i % 2 === 1) {
      breaks = (parts[i].match(/<br/gi) || []).length;
      continue;
    }
    const raw = parts[i];
    const text = raw.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').trim();
    if (!text) continue;
    const own = /font-size:\s*([\d.]+)px/.exec(raw);
    shape.push({ size: own ? Number(own[1]) : size, breaks });
    breaks = 0;
  }
  return shape;
};

const shapedHtml = (contentHtml, capturedHtml, style) => {
  const shape = capturedShape(capturedHtml, (style && style.size) || 16);
  const parts = segmentsOf(contentHtml);
  const lines = [];
  for (let i = 0; i < parts.length; i += 2) if (parts[i].replace(/<[^>]+>/g, '').trim()) lines.push(parts[i].trim());
  if (shape.length < 2 || lines.length !== shape.length) return null;
  // The largest line sets the box, and each line is sized against it, so the
  // phone layout's own type size scales the whole run.
  const size = Math.max(...shape.map((l) => l.size));
  let out = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = shape[i];
    if (i > 0) out += '<br />'.repeat(Math.max(1, line.breaks));
    out += Math.abs(line.size - size) > 0.5 ? `<span style="font-size:${Number((line.size / size).toFixed(4))}em">${lines[i]}</span>` : lines[i];
  }
  return { html: out, size };
};

// Pairs the Markdown's words with the page's captured boxes. Text pairs by its
// own text; media pairs in document order — every image, film and facade in the
// Markdown against every media box on the page — with an exact media-id match
// taking precedence, because Wix lays a film's poster above its stills.
function zip(contentBlocks, layoutBlocks, { byText = false } = {}) {
  const text = [];
  const media = [];
  for (const b of contentBlocks) {
    if (b.type === 'image' || b.type === 'video' || b.type === 'facade') media.push(b);
    else if (b.type === 'text' || b.type === 'list') text.push(b);
  }
  const placed = [];
  const orphaned = [];
  let listSlots = 0;
  for (let li = 0; li < layoutBlocks.length; li++) {
    const lb = layoutBlocks[li];
    const wantsText = lb.kind === 'text';
    // A bulleted list is one Markdown block but several boxes on the page; the
    // first box carries the list and the rest are its continuation.
    if (wantsText && listSlots > 0) {
      listSlots -= 1;
      placed.push({ ...lb, continuation: true, html: '' });
      continue;
    }
    if (wantsText) {
      // Wix draws the gap between two paragraphs as an empty paragraph of its
      // own; it holds nothing, so it must not take the next paragraph's words.
      if (!norm(lb.text)) {
        placed.push({ ...lb, empty: true, html: '' });
        continue;
      }
      // Text pairs by position, not by wording: the Markdown is the copy's
      // source of truth, so an edit to any part of a paragraph must land in
      // that paragraph's box rather than fall back to the captured text.
      let content = text[0];
      if (byText && content && !sameText(content.text, lb.text)) {
        const idx = text.findIndex((c) => sameText(c.text, lb.text));
        content = idx >= 0 ? text[idx] : text[0];
      }
      if (!content) {
        orphaned.push({ block: lb, why: 'no text left in content' });
        placed.push({ ...lb, orphan: true, html: withBase(lb.html) });
        continue;
      }
      text.splice(text.indexOf(content), 1);
      // One captured box can hold several Markdown paragraphs: the Markdown
      // keeps a blank line between them and each renders as its own paragraph
      // inside the one box, with the gap the capture shows between them.
      const parts = [content];
      while (text.length) {
        const next = text[0];
        const nt = norm(next.text);
        if (nt.length < 8 || !norm(lb.text).includes(nt.slice(0, 40))) break;
        parts.push(next);
        text.shift();
      }
      if (parts.length > 1) {
        content = {
          ...content,
          html: parts.map((p) => p.html).join('<br /><br />'),
          text: parts.map((p) => p.text).join('\n\n'),
        };
      }
      // One Markdown paragraph can be several boxes on the page (a run of
      // attribution lines, for one): the paragraph renders in the first box and
      // the boxes it covers keep their space without repeating it.
      let absorb = 0;
      while (
        layoutBlocks[li + 1 + absorb] &&
        layoutBlocks[li + 1 + absorb].kind === 'text' &&
        layoutBlocks[li + 1 + absorb].text &&
        norm(content.text).includes(norm(layoutBlocks[li + 1 + absorb].text))
      ) {
        absorb += 1;
      }
      if (absorb) listSlots = absorb;
      if (content.type === 'list' && content.items > 1) listSlots = content.items - 1;
      const shaped = content.type === 'text' ? shapedHtml(content.html, lb.html, lb.style) : null;
      placed.push({
        ...lb,
        content,
        style: shaped ? { ...lb.style, size: shaped.size } : lb.style,
        html: withBase(shaped ? shaped.html : content.html),
        list: content.type === 'list',
      });
      continue;
    }

    let content = null;
    // An embedded player (the trailer) pairs with the facade the Markdown carries
    // for it; there is one on the site, so order is enough here.
    if (lb.iframe) {
      const idx = media.findIndex((c) => c.type === 'facade' || c.type === 'embed');
      if (idx >= 0) content = media[idx];
    }
    if (lb.src) {
      const id = mediaId(lb.src);
      const idx = media.findIndex((c) => c.type === 'image' && fileToMedia.get(c.src) === id);
      if (idx >= 0) content = media[idx];
      // A film's poster frame is a media box too.
      if (!content) {
        const filmIdx = media.findIndex((c) => c.type === 'video' && c.poster
          && fileToMedia.get(c.poster) === id);
        if (filmIdx >= 0) content = media[filmIdx];
      }
    }
    if (!content) {
      // No picture in the Markdown is left for this box. Rendering the captured
      // one would make a deleted image look applied, so the build refuses instead.
      orphaned.push({ block: lb, why: 'no media left in content' });
      placed.push({ ...lb, orphan: true, drop: true });
      continue;
    }
    media.splice(media.indexOf(content), 1);
    if (content.type === 'image') {
      placed.push({ ...lb, content, src: content.src, phone: phoneImage(content.src),
                    alt: content.alt || lb.alt, href: content.href || lb.href });
    } else {
      // The box now carries a film or a facade: drop the captured still URL so
      // nothing can fall back to a hot-linked Wix image.
      placed.push({ ...lb, content, src: null, still: null, label: content.label, mediaType: content.type, embedUrl: content.embedUrl || null });
    }
  }
  return { placed, leftover: [...text, ...media], orphaned };
}

// The header: logo, Work, Thoughts, About, Contact. Labels and destinations
// come from `content/_site.md`; positions from the capture of the live site.
function headerData(currentPath) {
  const s = site();
  const siteNav = siteContent();
  const captured = s.desktop.header.nav.filter((n) => n.rect.w > 0);
  const capturedWide = s.desktopWide.header.nav.filter((n) => n.rect.w > 0);
  const logoIdx = captured.findIndex((n) => !siteNav.nav.some((v) => v.text === n.text));
  const logo = captured[logoIdx] || captured[0];
  const logoWide = capturedWide[logoIdx] || logo;
  const topLevel = captured.filter((_, i) => i !== logoIdx);
  const topWide = capturedWide.filter((_, i) => i !== logoIdx);
  // `_site.md` lists Work, the 11 case studies, then Thoughts, About, Contact.
  const work = siteNav.nav[0];
  const studies = siteNav.nav.slice(1).filter((n) => !['Thoughts', 'About', 'Contact'].includes(n.text));
  const rest = siteNav.nav.filter((n) => ['Thoughts', 'About', 'Contact'].includes(n.text));
  const items = [work, ...rest].map((n, i) => {
    const c = topLevel[i] || topLevel[topLevel.length - 1];
    const w = topWide[i] || c;
    return {
      text: n.text,
      href: n.href,
      isActive: n.href === currentPath,
      rect: c.rect,
      wide: w.rect,
      color: n.href === currentPath ? 'rgb(228, 162, 128)' : 'rgb(160, 161, 173)',
    };
  });
  return {
    height: s.desktop.header.rect.h,
    mobileHeight: s.mobile.header.rect.h,
    desktopNav: items,
    logo: { text: logo.text, href: '/', rect: logo.rect, wide: logoWide.rect },
    mobileLogo: s.mobile.header.nav.find((n) => n.text === logo.text),
    mobileBurger: s.mobile.header.burger,
    studies: studies.map((p) => ({ text: p.text, href: p.href, active: p.href === currentPath })),
    menu: (() => {
      const top = ['Work', 'Thoughts', 'About', 'Contact', 'Jenny Makunas'];
      const children = (s.mobile.header.nav || []).filter(
        (n) => !top.includes(n.text) && !siteNav.nav.some((v) => v.text === n.text && studies.some((st) => st.text === n.text)),
      );
      return { items: children.map((n) => ({ text: n.text, href: n.href })) };
    })(),
  };
}

const ACTIVE_DESKTOP = 'rgb(228, 162, 128)';
const ACTIVE_MOBILE = 'rgb(217, 75, 149)';
export { ACTIVE_DESKTOP, ACTIVE_MOBILE };

// Footer: the social row, the contact line and the © line, in `_site.md`'s
// words at the capture's positions. Rendered once, shared by every page.
function footerData() {
  const s = site();
  const sc = siteContent();
  const dTop = s.desktop.footer.rect.y;
  const wTop = s.desktopWide.footer.rect.y;
  const mTop = s.mobile.footer.rect.y;
  const dBlocks = s.desktop.footerBlocks || [];
  const wBlocks = s.desktopWide.footerBlocks || [];
  const mBlocks = s.mobile.footerBlocks || [];
  const dLinks = s.desktop.footerLinks || [];
  const wLinks = s.desktopWide.footerLinks || [];
  const mLinks = s.mobile.footerLinks || [];
  const rel = (r, top) => ({ ...r, y: r.y - top });

  const rows = [
    {
      cls: 'f0',
      social: sc.social,
      rect: dLinks[0] ? { x: dLinks[0].rect.x, y: dLinks[0].rect.y - dTop, w: 234, h: 21 } : { x: 373.5, y: 41, w: 234, h: 21 },
      wide: wLinks[0] ? { x: wLinks[0].rect.x, y: wLinks[0].rect.y - wTop, w: 234, h: 21 } : null,
      mobile: mLinks[0] ? { x: mLinks[0].rect.x, y: mLinks[0].rect.y - mTop, w: 130, h: 21 } : { x: 100, y: 20, w: 130, h: 21 },
      style: dLinks[0] ? dLinks[0].style : { font: 'cormorantgaramond-semibold', size: 14, color: 'rgb(217, 75, 149)' },
    },
    {
      cls: 'f1',
      html: withBase(inline(sc.contact)),
      rect: { x: 211.5, y: 91, w: 560, h: 21 },
      wide: { x: 440, y: 91, w: 560, h: 21 },
      mobile: { x: 80, y: 20, w: 162, h: 42 },
      style: { font: 'cormorantgaramond-semibold', size: 17, color: 'rgb(217, 75, 149)' },
    },
    {
      cls: 'f2',
      html: withBase(inline(sc.copyright)),
      rect: { x: 181.5, y: 121, w: 619, h: 19.6 },
      wide: { x: 410, y: 121, w: 619, h: 19.6 },
      mobile: { x: 48, y: 85, w: 224, h: 21 },
      style: { font: 'cormorantgaramond-semibold', size: 14, color: 'rgb(217, 75, 149)' },
    },
  ];
  // On the phone layout Wix drops the social row: only the contact line and the
  // © line remain, so the row is hidden below the breakpoint.
  rows[0].hideMobile = mLinks.length === 0;
  const decorate = (row) => ({
    ...row,
    shared: sharedCss({ style: row.style }),
    desktopCss: layoutCss({ kind: 'text', rect: row.rect, wide: { ...row.rect, ...(row.wide || {}) }, style: row.style }, 'desktop'),
    mobileCss: layoutCss({ kind: 'text', rect: row.mobile, style: row.style }, 'mobile'),
  });
  return {
    height: s.desktop.footer.rect.h,
    mobileHeight: s.mobile.footer.rect.h,
    heightCss: `${fmt(s.desktop.footer.rect.h)}px`,
    mobileHeightCss: mq(s.mobile.footer.rect.h),
    blocks: rows.map(decorate),
  };
}

// The Work grid is a Wix gallery: its cells are divs, not page content, and the
// capture lists them in a different order than they appear. Each cell is paired
// with the Markdown image that is the same picture, by media id.
function tileData(slug, images, headerH, mobileHeaderH) {
  const l = layoutOf(slug);
  // Both captures list the cells in the same order, including a duplicate box
  // Wix keeps for the hover layer; dedupe each list the same way so an index
  // means the same cell at each width.
  const unique = (list) => {
    const out = [];
    const seen = new Set();
    for (const t of list || []) {
      const k = `${t.rect.y}:${Math.round(t.rect.x / 10)}`;
      if (seen.has(k) || !t.src) continue;
      seen.add(k);
      out.push({ ...t, id: mediaId(t.src) });
    }
    return out;
  };
  const desk = unique(l.desktop.gallery);
  const wide = unique(l.desktop.galleryWide);
  const mob = unique(l.mobile.gallery);
  // Gallery cells are measured from the page top; the canvas starts below the
  // header, so every cell and its row offset move up by the header height.
  const shift = (r) => ({ ...r, y: r.y - headerH });
  // The phone layout has its own header height, 71px rather than 88.
  const shiftMobile = (r) => ({ ...r, y: r.y - mobileHeaderH });
  return images
    .map((image, i) => {
      const id = fileToMedia.get(image.src);
      const at = desk.findIndex((c) => c.id === id);
      if (at < 0) return null;
      const cell = desk[at];
      const wideCell = wide[at] || cell;
      const m = mob.find((c) => c.id === id);
      return {
        cls: `t${i}`,
        src: image.src,
        phone: phoneImage(image.src),
        alt: image.alt || '',
        href: image.href || null,
        fit: cell.fit || 'cover',
        shared: 'font-family:inherit',
        desktopCss: layoutCss({ kind: 'image', rect: shift(cell.rect), wide: shift(wideCell.rect), style: {} }, 'desktop'),
        mobileCss: m ? layoutCss({ ...m, rect: shiftMobile(m.rect), kind: 'image', style: {} }, 'mobile') : '',
        top: shift(cell.rect).y,
        wideTop: shift(wideCell.rect).y,
        mobileTop: m ? shiftMobile(m.rect).y : 0,
        bottom: shift(cell.rect).y + cell.rect.h,
        wideBottom: shift(wideCell.rect).y + wideCell.rect.h,
        mobileBottom: m ? shiftMobile(m.rect).y + m.rect.h : 0,
      };
    })
    .filter(Boolean);
}

// The page is positioned absolutely, so a text box that wraps to more lines than
// the capture saw would overlap the block beneath it. This walks the blocks in
// reading order at one width, sizes every text box from its real line count, and
// pushes the blocks that follow down by the overflow, keeping the captured gap
// between neighbours.
function flowTops(blocks, width) {
  const t = (width - REF) / (WIDE - REF);
  const geo = blocks.map((b) => {
    const r = b.rect;
    const w = b.wide || r;
    return {
      b,
      x: r.x + ((w.x ?? r.x) - r.x) * t,
      w: r.w + ((w.w ?? r.w) - r.w) * t,
      y: r.y + ((w.y ?? r.y) - r.y) * t,
      h: b.kind === 'text' ? 0 : r.h + ((w.h ?? r.h) - r.h) * t,
    };
  });
  const placed = [];
  for (const g of geo) {
    if (g.b.kind === 'text' && g.b.html) {
      const style = g.b.style || {};
      const measured = textHeight(g.b.html, {
        width: g.w,
        family: family(style.font),
        size: g.b.fit || style.size || 16,
        weight: style.weight || 400,
        lineHeight: style.lineHeight
          ? style.lineHeight * ((g.b.fit || style.size) / style.size)
          : style.lineHeight,
        spacing: style.spacing,
      });
      g.h = measured.height;
    }
    let top = g.y;
    for (const p of placed) {
      const overlap = g.x < p.x + p.w - 2 && p.x < g.x + g.w - 2;
      if (!overlap) continue;
      const capturedGap = Math.max(0, g.y - (p.capturedY + (p.capturedH || 0)));
      const candidate = p.top + p.h + capturedGap;
      if (candidate > top + 0.5) top = candidate;
    }
    placed.push({ ...g, top, capturedY: g.y, capturedH: g.b.kind === 'text' ? (g.b.rect.h) : g.h });
  }
  const bottom = placed.reduce((m, p) => Math.max(m, p.top + p.h), 0);
  return { tops: placed.map((p) => ({ top: p.top, bottom: p.top + p.h })), bottom };
}

export function composePage(slug) {
  const page = allPages().find((p) => p.slug === slug);
  const l = layoutOf(slug);
  const currentPath = page.path.replace(/(.)\/$/, '$1');
  const header = headerData(currentPath);
  const footer = footerData();
  const homeImages = slug === 'home' ? page.blocks.filter((b) => b.type === 'image') : [];
  const contentBlocks = homeImages.length ? page.blocks.filter((b) => b.type !== 'image') : page.blocks;
  // The Work grid's boxes come from the captured gallery, not from block content.
  const galleryIds =
    slug === 'home' ? new Set((l.desktop.gallery || []).map((t) => mediaId(t.src))) : new Set();

  const split = (bp) => {
    const headerH = bp.header?.rect.h ?? 0;
    const footerTop = bp.footer?.rect.y ?? bp.docHeight;
    // Reading order: blocks that sit on the same line (within a few pixels, as
    // Wix's three-column contact row does) read left to right, not by the y
    // jitter between them.
    const order = (a, b) => Math.round(a.rect.y / 8) - Math.round(b.rect.y / 8) || a.rect.x - b.rect.x;
    const body = bp.blocks
      .filter((b) => b.rect.y >= headerH - 1 && b.rect.y < footerTop - 1)
      .map((b) => ({ ...b, rect: { ...b.rect, y: b.rect.y - headerH }, wide: b.wide ? { ...b.wide, y: b.wide.y - headerH } : undefined }))
      .sort(order);
    return { headerH, height: footerTop - headerH, body };
  };

  const desk = split(l.desktop);
  const mob = split(l.mobile);
  const withoutGallery = (body) => body.filter((b) => !(b.kind === 'image' && galleryIds.has(mediaId(b.src))));
  const zipped = zip(contentBlocks, withoutGallery(desk.body));
  // The phone page orders blocks differently from the desktop one, so the phone
  // capture is matched by wording; the desktop one by position, because there
  // the Markdown order and the page order are the same thing.
  const mobZipped = zip(contentBlocks, withoutGallery(mob.body), { byText: true });

  // One DOM, two stylesheets: each block borrows the geometry of the phone
  // layout's block that carries the same thing. Index does not work here — Wix
  // reorders the phone page (the phone/email rows swap, for one).
  // Both sides of the join come from the capture, not from the Markdown, so editing
  // a word cannot re-pair the phone layout's boxes onto the wrong rectangles.
  const mobKey = (b) =>
    b.kind === 'text'
      ? `t:${norm(b.text).slice(0, 60)}`
      : `m:${mediaId(b.src || b.content?.src || '')}`;
  const mobileByKey = new Map();
  for (const m of mobZipped.placed) {
    const k = mobKey(m);
    if (k !== 'm:') mobileByKey.set(k, m);
  }
  const unplaced = [];
  const tiles = homeImages.length ? tileData(slug, homeImages, desk.headerH, mob.headerH) : [];
  // The Work grid pairs each Markdown picture with its captured cell; a picture
  // with no cell would simply vanish from the page.
  if (homeImages.length && tiles.length !== homeImages.length) {
    const missing = homeImages.filter((i) => !tiles.some((t) => t.src === i.src)).map((i) => i.src);
    throw new Error(`${slug}: ${missing.length} Markdown picture(s) have no cell in the Work grid — ${missing.join(', ')}`);
  }
  const entries = zipped.placed.map((b, i) => {
    // A phone page draws the same blocks, so a block with no phone twin means the
    // join broke; borrowing another block's rectangle would hide it.
    const m = mobileByKey.get(mobKey(b));
    if (!m && (b.content || b.html)) unplaced.push(`"${(b.text || b.src || b.iframe || '').slice(0, 40)}"`);
    return { b, m, cls: `b${i}` };
  });
  if (unplaced.length) {
    throw new Error(`${slug}: no phone-layout box for ${unplaced.length} block(s) — ${unplaced.join(', ')}`);
  }

  // Wix's gallery finishes laying out its last row after the page was measured,
  // so a block the capture found inside the grid belongs under it: everything
  // below the gallery sits at the grid's bottom plus the captured gap.
  if (tiles.length) {
    const gap = 20;
    const lastRow = Math.max(...tiles.map((t) => t.top));
    const below = entries.map((e) => e.b).filter((b) => b.rect.y > lastRow);
    if (below.length) {
      const dyRef = Math.max(...tiles.map((t) => t.bottom)) + gap - Math.min(...below.map((b) => b.rect.y));
      const dyWide = Math.max(...tiles.map((t) => t.wideBottom)) + gap - Math.min(...below.map((b) => (b.wide || b.rect).y));
      for (const b of below) {
        b.rect = { ...b.rect, y: b.rect.y + dyRef };
        if (b.wide) b.wide = { ...b.wide, y: b.wide.y + dyWide };
      }
    }
  }

  // A box keeps the number of lines the capture shows: Jost runs wider than
  // Futura, so where the substitute face would break a line early the size gives
  // way, and only a box that still cannot fit grows and pushes the page down.
  for (const { b } of entries) {
    const style = b.style || {};
    if (b.kind !== 'text' || !b.html || !style.size) continue;
    const line = style.lineHeight || style.size * 1.2;
    const size = fitSize(b.html, {
      width: b.rect.w,
      family: family(style.font),
      size: style.size,
      weight: style.weight || 400,
      spacing: style.spacing,
      lines: Math.max(1, Math.round(b.rect.h / line)),
    });
    if (size < style.size - 0.5) b.fit = size;
  }

  // Every text box is sized from its real line count at each width, and the
  // blocks under it move down by any overflow rather than overlapping it.
  const deskFlow = flowTops(entries.map((e) => e.b), REF);
  const wideFlow = flowTops(entries.map((e) => e.b), WIDE);
  const mobFlow = flowTops(
    entries.map((e) => (e.m ? { ...e.b, fit: undefined, rect: e.m.rect, wide: e.m.rect, style: e.m.style } : e.b)),
    MOBILE_DESIGN,
  );

  const blocks = entries.map(({ b, m, cls }, i) => ({
    ...b,
    cls,
    shared: sharedCss(b),
    desktopCss: withTop(layoutCss(b, 'desktop'), linCss(deskFlow.tops[i].top, wideFlow.tops[i].top, 'top')),
    mobileCss: withTop(m ? layoutCss(m, 'mobile') : '', `top:${mq(mobFlow.tops[i].top)}`),
  }));

  // The captured hairlines ride with the blocks above them: if a text box grew,
  // the rules under it move down with everything else.
  const ruleShift = (flow) => (y) => {
    let delta = 0;
    entries.forEach(({ b }, i) => {
      if (b.rect.y <= y) delta = Math.max(delta, flow.tops[i].top - b.rect.y);
    });
    return delta;
  };
  const deskShift = ruleShift(deskFlow);
  const wideShift = ruleShift(wideFlow);
  const rules = (l.desktop.rules || []).map((r, i) => {
    const wr = (l.desktop.rulesWide || [])[i] || r;
    const deskTop = r.y - desk.headerH + deskShift(r.y - desk.headerH);
    const wideTop = wr.y - desk.headerH + wideShift(wr.y - desk.headerH);
    return {
      cls: `rule${i}`,
      css: [
        linCss(r.x, wr.x, 'left'),
        linCss(r.w, wr.w, 'width'),
        linCss(deskTop, wideTop, 'top'),
        `border-top:${fmt(r.weight || 1)}px solid ${r.color}`,
      ].join(';'),
    };
  });

  // Content that has nowhere to go is a hard error: silently publishing the
  // captured text would make an edit to the Markdown look applied when it is not.
  const stray = zipped.leftover.filter((b) => (b.text || b.src || b.label || '').trim());
  const homeless = zipped.orphaned.filter((o) => (o.block.text || o.block.src || o.block.iframe || '').trim());
  if (stray.length || homeless.length) {
    const detail = [...stray.map((b) => `content block with no box: "${(b.text || b.src || b.label).slice(0, 60)}"`), ...homeless.map((o) => `box with no content: "${(o.block.text || o.block.src || o.block.iframe || '').slice(0, 60)}"`)].join('; ');
    throw new Error(`${slug}: the Markdown does not line up with the captured page — ${detail}`);
  }

  // On the Work page the grid stretches vertically too, which moves the footer
  // down with the page: the canvas height follows the same interpolation.
  const footerWideY = l.desktop.footerWide ? l.desktop.footerWide.rect.y - desk.headerH : desk.height;
  const h = lin(desk.height, footerWideY);
  // The canvas is as tall as the flowed content, never shorter than the capture.
  const tileBottom = (key) => (tiles || []).reduce((m, t) => Math.max(m, t[key] || 0), 0);
  const growRef = Math.max(desk.height, deskFlow.bottom, tileBottom('bottom'));
  const growWide = Math.max(footerWideY, wideFlow.bottom, tileBottom('wideBottom'));
  const hg = lin(growRef, growWide);
  return {
    page,
    header,
    footer,
    tiles,
    blocks,
    height: desk.height,
    heightCss: scale(hg.c, hg.m),
    mobileHeightCss: mq(Math.max(mob.height, mobFlow.bottom, tileBottom('mobileBottom'))),
    mobileHeight: mob.height,
    headerHeight: desk.headerH,
    mobileHeaderHeight: mob.headerH,
    rules,
    leftover: zipped.leftover,
    orphaned: zipped.orphaned,
    mobileLeftover: mobZipped.leftover,
  };
}

// Combines the two breakpoints into one stylesheet of media-queried rules.
export function pageCss(composed) {
  const rules = [];
  const emit = (cls, shared, desktopCss, mobileCss) => {
    rules.push(`@media (min-width:750px){.${cls}{${shared};${desktopCss}}}`);
    rules.push(`@media (max-width:749.9px){.${cls}{${shared};${mobileCss}}}`);
  };
  for (const b of composed.blocks) emit(b.cls, b.shared, b.desktopCss, b.mobileCss);
  for (const t of composed.tiles || []) emit(t.cls, t.shared, t.desktopCss, t.mobileCss);
  for (const r of composed.rules || []) rules.push(`@media (min-width:750px){.${r.cls}{position:absolute;${r.css}}}`);
  for (const b of composed.footer.blocks) {
    if (b.hideMobile) {
      rules.push(`@media (min-width:750px){.${b.cls}{${b.shared};${b.desktopCss}}}`);
      rules.push(`@media (max-width:749.9px){.${b.cls}{display:none}}`);
    } else {
      emit(b.cls, b.shared, b.desktopCss, b.mobileCss);
    }
  }
  rules.push(`@media (min-width:750px){.site-footer{height:${composed.footer.heightCss}}}`);
  rules.push(`@media (max-width:749.9px){.site-footer{height:${composed.footer.mobileHeightCss}}}`);
  return rules.join('\n');
}

// Header stylesheet: absolute nav positions at desktop, logo and burger at mobile.
export function chromeCss(composed) {
  const { header } = composed;
  const rules = [];
  header.desktopNav.forEach((item, i) => {
    const { c, m } = lin(item.rect.x, item.wide.x);
    const w = lin(item.rect.w, item.wide.w);
    rules.push(
      `@media (min-width:750px){.nav-${i}{left:${scale(c, m)};width:${scale(w.c, w.m)};top:${fmt(item.rect.y)}px;height:${fmt(item.rect.h)}px}}`,
    );
  });
  const logo = header.logo;
  if (logo) {
    const { c, m } = lin(logo.rect.x, logo.wide.x);
    rules.push(`@media (min-width:750px){.logo{left:${scale(c, m)};width:${fmt(logo.rect.w)}px;top:${fmt(logo.rect.y)}px}}`);
  }
  if (header.mobileLogo) {
    rules.push(`@media (max-width:749.9px){.logo{left:${mq(header.mobileLogo.rect.x)};width:${mq(header.mobileLogo.rect.w)};top:${mq(header.mobileLogo.rect.y)}}}`);
  }
  if (header.mobileBurger) {
    rules.push(`@media (max-width:749.9px){.burger{right:${mq(MOBILE_DESIGN - header.mobileBurger.x - header.mobileBurger.w)};top:${mq(header.mobileBurger.y)};width:${mq(header.mobileBurger.w)};height:${mq(header.mobileBurger.h)}}}`);
  }
  return rules.join('\n');
}

export { fmt, lin, mq, FONT_STACK, family };
