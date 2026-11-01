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
import path from 'node:path';
import { allPages } from './content.js';

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
    out.push(linCss(r.x, wide.x, 'left'), linCss(r.w, wide.w, 'width'), `top:${fmt(r.y)}px`);
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

// Pairs Markdown blocks with captured blocks, per category, in document order.
// A text block that does not match still consumes its slot only when nothing
// queued matches it, so a paragraph Wix split differently does not shift the rest.
function zip(contentBlocks, layoutBlocks) {
  const queue = { text: [], image: [], media: [] };
  for (const b of contentBlocks) {
    if (b.type === 'image') queue.image.push(b);
    else if (b.type === 'text' || b.type === 'list') queue.text.push(b);
    else queue.media.push(b);
  }
  const placed = [];
  const orphaned = [];
  for (const lb of layoutBlocks) {
    const cat = lb.kind === 'text' ? 'text' : lb.kind === 'image' ? 'image' : 'media';
    let content = queue[cat][0];
    if (cat === 'text' && content && !sameText(content.text, lb.text)) {
      const idx = queue.text.findIndex((c) => sameText(c.text, lb.text));
      content = idx >= 0 ? queue.text[idx] : null;
    }
    if (cat === 'image' && lb.src) {
      // Match images by media id: Wix reorders and re-renditions freely, but the
      // media id is stable, so the tree's image lands in its own frame.
      const id = mediaId(lb.src);
      const idx = queue.image.findIndex((c) => fileToMedia.get(c.src) === id);
      if (idx >= 0) content = queue.image[idx];
    } else if (cat === 'image') {
      content = null;
    }
    if (!content) {
      orphaned.push({ block: lb, why: `no ${cat} left in content` });
      placed.push({ ...lb, orphan: true, src: isWixUrl(lb.src) ? localImage(lb.src) || lb.src : lb.src });
      continue;
    }
    queue[cat].splice(queue[cat].indexOf(content), 1);
    if (cat === 'image') {
      placed.push({ ...lb, content, src: content.src, alt: content.alt || lb.alt, href: content.href || lb.href });
    } else if (cat === 'text') {
      placed.push({ ...lb, content, html: content.html, list: content.type === 'list' });
    } else {
      placed.push({ ...lb, content, label: content.label, mediaType: content.type, still: lb.iframe ? null : localImage(lb.src), embedUrl: cleanEmbed(lb.iframe || lb.playableUrl) });
    }
  }
  const leftover = [...queue.text, ...queue.image, ...queue.media];
  return { placed, leftover, orphaned };
}

// The header: logo, Work, Thoughts, About, Contact. Positions are captured;
// the active page is tinted the accent the live site uses for it.
function headerData(currentPath) {
  const s = site();
  const navItems = s.desktop.header.nav.filter((n) => n.rect.w > 0);
  const wideItems = s.desktopWide.header.nav.filter((n) => n.rect.w > 0);
  const items = navItems.map((n, i) => {
    const w = wideItems[i] || n;
    const p = new URL(n.href).pathname.replace(/^\/mysite/, '') || '/';
    const isLogo = n.rect.y < 10;
    return {
      text: n.text,
      href: p,
      isLogo,
      isActive: !isLogo && (p === currentPath || (p === '/' && currentPath === '/')),
      style: { ...n.style, color: isLogo ? 'rgb(217, 75, 149)' : n.style.color },
      rect: n.rect,
      wide: w.rect,
    };
  });
  const study = allPages().filter((p) => p.kind === 'case_study').sort((a, b) => a.order - b.order);
  return {
    height: s.desktop.header.rect.h,
    mobileHeight: s.mobile.header.rect.h,
    desktopNav: items.filter((i) => !i.isLogo),
    logo: items.find((i) => i.isLogo),
    mobileLogo: s.mobile.header.nav.find((n) => n.text === 'Jenny Makunas'),
    mobileBurger: s.mobile.header.burger,
    studies: study.map((p) => ({ text: p.nav_label, href: p.path, active: p.path === currentPath })),
    menu: s.mobileMenu,
  };
}

const ACTIVE_DESKTOP = 'rgb(228, 162, 128)';
const ACTIVE_MOBILE = 'rgb(217, 75, 149)';
export { ACTIVE_DESKTOP, ACTIVE_MOBILE };

// Footer: everything the capture found below the footer top, moved into its own
// coordinate space so it renders once, after the page canvas.
function footerData() {
  const home = layoutOf('home');
  const top = home.desktop.footer.rect.y;
  const mtop = home.mobile.footer.rect.y;
  const shift = (b, t) => ({ ...b, rect: { ...b.rect, y: b.rect.y - t }, wide: { ...(b.wide || b.rect), y: (b.wide || b.rect).y - t } });
  const desk = home.desktop.blocks.filter((b) => b.rect.y >= top - 2).map((b) => shift(b, top));
  const mob = home.mobile.blocks.filter((b) => b.rect.y >= mtop - 2).map((b) => shift(b, mtop));
  // The two captures segment the footer the same way; pair by index so one
  // element carries both breakpoints.
  const blocks = desk.map((b, i) => {
    const m = mob[i] || mob[mob.length - 1];
    return {
      ...b,
      src: isWixUrl(b.src) ? localImage(b.src) || null : b.src,
      cls: `f${i}`,
      shared: sharedCss(b),
      desktopCss: layoutCss(b, 'desktop'),
      mobileCss: m ? layoutCss({ ...m, style: b.style }, 'mobile') : '',
    };
  });
  return { height: home.desktop.footer.rect.h, mobileHeight: home.mobile.footer.rect.h, blocks };
}

// The Work grid is a Wix gallery, so its tiles never appear as block content:
// they are paired with the Markdown's linked images in order.
function tileData(slug, images) {
  const l = layoutOf(slug);
  const desk = l.desktop.gallery || [];
  const mob = l.mobile.gallery || [];
  return images.map((image, i) => {
    const d = desk[i];
    const m = mob[i];
    if (!d) return null;
    return {
      cls: `t${i}`,
      src: image.src,
      alt: image.alt || '',
      href: image.href || (d.href ? new URL(d.href).pathname.replace(/^\/mysite/, '') : null),
      fit: d.fit || 'cover',
      shared: 'font-family:inherit',
      desktopCss: layoutCss({ ...d, kind: 'image', style: {} }, 'desktop'),
      mobileCss: m ? layoutCss({ ...m, kind: 'image', style: {} }, 'mobile') : '',
    };
  }).filter(Boolean);
}

export function composePage(slug) {
  const page = allPages().find((p) => p.slug === slug);
  const l = layoutOf(slug);
  const currentPath = page.path.replace(/(.)\/$/, '$1');
  const header = headerData(currentPath);
  const footer = footerData();
  const homeImages = slug === 'home' ? page.blocks.filter((b) => b.type === 'image') : [];
  const contentBlocks = homeImages.length ? page.blocks.filter((b) => b.type !== 'image') : page.blocks;

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
  const zipped = zip(contentBlocks, desk.body);
  const mobZipped = zip(contentBlocks, mob.body);

  // One DOM, two stylesheets: each desktop block borrows the geometry of the
  // mobile block that occupies the same slot in the phone layout.
  const blocks = zipped.placed.map((b, i) => {
    const m = mobZipped.placed[i];
    return {
      ...b,
      cls: `b${i}`,
      shared: sharedCss(b),
      desktopCss: layoutCss(b, 'desktop'),
      mobileCss: m ? layoutCss({ ...m, style: b.style }, 'mobile') : '',
    };
  });

  const tiles = homeImages.length ? tileData(slug, homeImages) : [];

  return {
    page,
    header,
    footer,
    tiles,
    blocks,
    height: desk.height,
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
