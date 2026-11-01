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
const localImages = new Map(manifest.images.map((i) => [mediaId(i.url), `/${i.file}`]));
// The reverse join: a Markdown image path back to the media id Wix serves it as.
const fileToMedia = new Map(manifest.images.map((i) => [`/${i.file}`, mediaId(i.url)]));
export const localImage = (wixUrl) => localImages.get(mediaId(wixUrl)) || null;

// Markdown links are written as site paths; in the built page they carry the
// deploy base like every other internal URL.
const BASE = (import.meta.env?.BASE_URL || '/').replace(/\/?$/, '/');
const withBase = (html) => String(html).replace(/href="\/(?!\/)/g, `href="${BASE}`);

const fmt = (n) => String(Math.round(n * 100) / 100);
const lin = (a, b) => {
  const m = (b - a) / (WIDE - REF);
  return { c: a - REF * m, m };
};
const linCss = (a, b, prop) => {
  const { c, m } = lin(a, b);
  return `${prop}:calc(${fmt(c)}px + ${fmt(m * 100)}cqw)`;
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
    if (block.kind !== 'text') out.push(`height:${fmt(r.h)}px`);
    if (s.size) out.push(`font-size:${fmt(s.size)}px`);
    if (s.lineHeight) out.push(`line-height:${fmt(s.lineHeight)}px`);
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

const isWixUrl = (u) => /wixstatic|parastorage/.test(u || '');
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

// Pairs the Markdown's words with the page's captured boxes. Text pairs by its
// own text; media pairs in document order — every image, film and facade in the
// Markdown against every media box on the page — with an exact media-id match
// taking precedence, because Wix lays a film's poster above its stills.
function zip(contentBlocks, layoutBlocks) {
  const text = [];
  const media = [];
  for (const b of contentBlocks) {
    if (b.type === 'image' || b.type === 'video' || b.type === 'facade') media.push(b);
    else if (b.type === 'text' || b.type === 'list') text.push(b);
  }
  const placed = [];
  const orphaned = [];
  let listSlots = 0;
  for (const lb of layoutBlocks) {
    const wantsText = lb.kind === 'text';
    // A bulleted list is one Markdown block but several boxes on the page; the
    // first box carries the list and the rest are its continuation.
    if (wantsText && listSlots > 0) {
      listSlots -= 1;
      placed.push({ ...lb, continuation: true, html: '' });
      continue;
    }
    if (wantsText) {
      let content = text[0];
      if (content && !sameText(content.text, lb.text)) {
        const idx = text.findIndex((c) => sameText(c.text, lb.text));
        content = idx >= 0 ? text[idx] : null;
      }
      if (!content) {
        orphaned.push({ block: lb, why: 'no text left in content' });
        placed.push({ ...lb, orphan: true, html: withBase(lb.html) });
        continue;
      }
      text.splice(text.indexOf(content), 1);
      if (content.type === 'list' && content.items > 1) listSlots = content.items - 1;
      placed.push({ ...lb, content, html: withBase(content.html), list: content.type === 'list' });
      continue;
    }

    let content = null;
    if (lb.src) {
      const id = mediaId(lb.src);
      const idx = media.findIndex((c) => c.type === 'image' && fileToMedia.get(c.src) === id);
      if (idx >= 0) content = media[idx];
      // A film's poster frame is a media box too.
      if (!content) {
        const filmIdx = media.findIndex((c) => c.type === 'video' && c.poster && mediaId(c.poster) === id);
        if (filmIdx >= 0) content = media[filmIdx];
      }
    }
    if (!content) content = media[0] || null;
    if (!content) {
      orphaned.push({ block: lb, why: 'no media left in content' });
      const local = isWixUrl(lb.src) ? localImage(lb.src) : lb.src;
      // Never hot-link Wix: a box with no local image simply does not render.
      placed.push({ ...lb, orphan: true, src: local, drop: !local });
      continue;
    }
    media.splice(media.indexOf(content), 1);
    if (content.type === 'image') {
      placed.push({ ...lb, content, src: content.src, alt: content.alt || lb.alt, href: content.href || lb.href });
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
    menu: s.mobileMenu,
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
  const decorate = (row) => ({
    ...row,
    shared: sharedCss({ style: row.style }),
    desktopCss: layoutCss({ kind: 'text', rect: row.rect, wide: { ...row.rect, ...(row.wide || {}) }, style: row.style }, 'desktop'),
    mobileCss: layoutCss({ kind: 'text', rect: row.mobile, style: row.style }, 'mobile'),
  });
  return {
    height: s.desktop.footer.rect.h,
    mobileHeight: s.mobile.footer.rect.h,
    blocks: rows.map(decorate),
  };
}

// The Work grid is a Wix gallery: its cells are divs, not page content, and the
// capture lists them in a different order than they appear. Each cell is paired
// with the Markdown image that is the same picture, by media id.
function tileData(slug, images) {
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
        alt: image.alt || '',
        href: image.href || null,
        fit: cell.fit || 'cover',
        shared: 'font-family:inherit',
        desktopCss: layoutCss({ kind: 'image', rect: cell.rect, wide: wideCell.rect, style: {} }, 'desktop'),
        mobileCss: m ? layoutCss({ ...m, kind: 'image', style: {} }, 'mobile') : '',
      };
    })
    .filter(Boolean);
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
    const body = bp.blocks
      .filter((b) => b.rect.y >= headerH - 1 && b.rect.y < footerTop - 1)
      .map((b) => ({ ...b, rect: { ...b.rect, y: b.rect.y - headerH }, wide: b.wide ? { ...b.wide, y: b.wide.y - headerH } : undefined }));
    return { headerH, height: footerTop - headerH, body };
  };

  const desk = split(l.desktop);
  const mob = split(l.mobile);
  const withoutGallery = (body) => body.filter((b) => !(b.kind === 'image' && galleryIds.has(mediaId(b.src))));
  const zipped = zip(contentBlocks, withoutGallery(desk.body));
  const mobZipped = zip(contentBlocks, withoutGallery(mob.body));

  // One DOM, two stylesheets: each desktop block borrows the geometry of the
  // mobile block that occupies the same slot in the phone layout.
  const blocks = zipped.placed.map((b, i) => {
    const m = mobZipped.placed[i];
    return {
      ...b,
      cls: `b${i}`,
      shared: sharedCss(b),
      desktopCss: layoutCss(b, 'desktop'),
      // The phone layout sets its own type sizes; only geometry is borrowed.
      mobileCss: m ? layoutCss(m, 'mobile') : '',
    };
  });

  const tiles = homeImages.length ? tileData(slug, homeImages) : [];

  // On the Work page the grid stretches vertically too, which moves the footer
  // down with the page: the canvas height follows the same interpolation.
  const footerWideY = l.desktop.footerWide ? l.desktop.footerWide.rect.y - desk.headerH : desk.height;
  const h = lin(desk.height, footerWideY);
  return {
    page,
    header,
    footer,
    tiles,
    blocks,
    height: desk.height,
    heightCss: `calc(${fmt(h.c)}px + ${fmt(h.m * 100)}cqw)`,
    mobileHeight: mob.height,
    headerHeight: desk.headerH,
    mobileHeaderHeight: mob.headerH,
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
  for (const b of composed.footer.blocks) emit(b.cls, b.shared, b.desktopCss, b.mobileCss);
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
      `@media (min-width:750px){.nav-${i}{left:calc(${fmt(c)}px + ${fmt(m * 100)}cqw);width:calc(${fmt(w.c)}px + ${fmt(w.m * 100)}cqw);top:${fmt(item.rect.y)}px;height:${fmt(item.rect.h)}px}}`,
    );
  });
  const logo = header.logo;
  if (logo) {
    const { c, m } = lin(logo.rect.x, logo.wide.x);
    rules.push(`@media (min-width:750px){.logo{left:calc(${fmt(c)}px + ${fmt(m * 100)}cqw);width:${fmt(logo.rect.w)}px;top:${fmt(logo.rect.y)}px}}`);
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
