// Captures the live Wix site's rendered geometry so the Astro rebuild can
// reproduce it rather than approximate it. Output: src/layout/*.json.
//
//   node scripts/site/extract-layout.mjs             # every page in src/layout/pages.json
//   node scripts/site/extract-layout.mjs thoughts    # named pages only
//   node scripts/site/extract-layout.mjs --site      # header, footer and mobile menu only
//
// The Wix site has two layouts and both are captured:
//   desktop — a 983px canvas that stretches horizontally with the viewport but
//             never vertically, so each block records its rect at 983 and at
//             1440 and the rebuild interpolates linearly between the two;
//   mobile  — a separate 320px-wide layout served to phones and scaled to the
//             device width, so one capture is enough.
import { chromium, devices } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const SITE = 'https://jenny6926.wixsite.com/mysite';
const DESKTOP_REF = 983;
const DESKTOP_WIDE = 1440;
const MOBILE_W = 390;

const PAGE_JS = ({ offset, wantMenu }) => {
  const y0 = offset || 0;
  const textEl = (el) => {
    let n = el;
    while (n.children.length) {
      const next = [...n.children].find((c) => c.textContent.trim());
      if (!next) break;
      n = next;
    }
    return n;
  };
  const rect = (el) => {
    const b = el.getBoundingClientRect();
    return {
      x: +(b.x + window.scrollX).toFixed(1),
      y: +(b.y + window.scrollY - y0).toFixed(1),
      w: +b.width.toFixed(1),
      h: +b.height.toFixed(1),
    };
  };
  const comp = (el) => el.closest('[id^="comp-"]') || el;
  const styleOf = (el) => {
    const s = getComputedStyle(el);
    return {
      font: s.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
      size: parseFloat(s.fontSize),
      weight: +s.fontWeight,
      lineHeight: s.lineHeight === 'normal' ? null : parseFloat(s.lineHeight),
      color: s.color,
      align: s.textAlign,
      spacing: s.letterSpacing === 'normal' ? null : parseFloat(s.letterSpacing),
      transform: s.textTransform,
      decoration: s.textDecorationLine,
      style: s.fontStyle,
    };
  };

  const blocks = [];
  for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6,p')) {
    if (el.parentElement.closest('h1,h2,h3,h4,h5,h6,p')) continue;
    const r = rect(el);
    if (!r.w || !el.innerText.trim()) continue;
    const anchor = el.closest('a');
    blocks.push({
      kind: 'text',
      tag: el.tagName.toLowerCase(),
      html: el.innerHTML.trim(),
      text: el.innerText.replace(/\u200b/g, '').trim(),
      rect: r,
      box: rect(comp(el)),
      style: styleOf(el),
      href: anchor ? anchor.getAttribute('href') : null,
      target: anchor ? anchor.getAttribute('target') : null,
    });
  }
  for (const el of document.querySelectorAll('img,video,iframe')) {
    const inner = rect(el);
    if (inner.w <= 2 || inner.h <= 2) continue;
    const owner = comp(el);
    const anchor = el.closest('a');
    const player = el.tagName !== 'img' && el.tagName !== 'IMG' ? el : owner.querySelector('[data-testid="playable"]');
    const s = getComputedStyle(el);
    blocks.push({
      kind: player ? 'video' : 'image',
      src: el.tagName === 'IMG' ? el.currentSrc || el.src : null,
      iframe: el.tagName === 'IFRAME' ? el.src : null,
      playable: !!player,
      rect: inner,
      box: rect(owner),
      fit: s.objectFit,
      radius: s.borderRadius,
      href: anchor ? anchor.getAttribute('href') : null,
      alt: el.getAttribute('alt') || '',
    });
  }
  // Wix paints each image twice (a sizing layer and the img) and gives a video
  // player both a poster image and a player element. Keep one block per box,
  // preferring the one that carries a still frame.
  const best = new Map();
  for (const b of blocks) {
    if (b.kind === 'text') continue;
    const k = `${b.rect.x}:${b.rect.y}:${b.rect.w}:${Math.round(b.rect.h)}`;
    const prev = best.get(k);
    if (!prev || (!prev.src && b.src) || (!prev.iframe && b.iframe)) best.set(k, b);
  }
  const kept = blocks.filter((b) => b.kind === 'text' || best.get(`${b.rect.x}:${b.rect.y}:${b.rect.w}:${Math.round(b.rect.h)}`) === b);

  const gallery = [...document.querySelectorAll('.gallery-item-content')].map((el) => {
    const img = el.querySelector('img');
    const anchor = el.closest('a');
    return {
      kind: 'tile',
      rect: rect(el),
      src: img ? img.currentSrc || img.src : null,
      fit: img ? getComputedStyle(img).objectFit : null,
      href: anchor ? anchor.getAttribute('href') : null,
      alt: (img && img.getAttribute('alt')) || '',
    };
  });

  const header = document.querySelector('#SITE_HEADER');
  const footer = document.querySelector('#SITE_FOOTER');
  const bgOf = (sel) =>
    [...document.querySelectorAll(sel)]
      .map((e) => ({ bg: getComputedStyle(e).backgroundColor, h: Math.round(e.getBoundingClientRect().height), y: Math.round(e.getBoundingClientRect().y - y0) }))
      .filter((x) => x.bg !== 'rgba(0, 0, 0, 0)');

  const nav = header
    ? [...header.querySelectorAll('[data-testid="linkElement"]')].map((el) => {
        const t = textEl(el);
        return {
          text: el.innerText.replace(/\u200b/g, '').trim(),
          href: el.getAttribute('href'),
          rect: rect(el),
          style: styleOf(t),
        };
      })
    : [];

  let menu = null;
  if (wantMenu) {
    const toggle = document.querySelector('#MENU_AS_CONTAINER_TOGGLE');
    if (toggle) {
      toggle.click();
      menu = { opened: true };
    }
  }

  return {
    viewportW: window.innerWidth,
    docHeight: document.documentElement.scrollHeight - y0,
    header: header
      ? {
          rect: rect(header),
          bg: getComputedStyle(header).backgroundColor,
          shadow: getComputedStyle(header).boxShadow,
          border: getComputedStyle(header).borderBottom,
          position: getComputedStyle(header).position,
          nav,
          burger: header.querySelector('#MENU_AS_CONTAINER_TOGGLE')
            ? rect(header.querySelector('#MENU_AS_CONTAINER_TOGGLE'))
            : null,
        }
      : null,
    footer: footer ? { rect: rect(footer), bg: getComputedStyle(footer).backgroundColor } : null,
    bands: bgOf('[data-testid="colorUnderlay"], #pageBackground_c1dmp'),
    blocks: kept.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x),
    gallery,
    menu,
  };
};

const MENU_JS = ({ offset }) => {
  const y0 = offset || 0;
  const rect = (el) => {
    const b = el.getBoundingClientRect();
    return { x: +b.x.toFixed(1), y: +(b.y - y0).toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) };
  };
  const textEl = (el) => {
    let n = el;
    while (n.children.length) {
      const next = [...n.children].find((c) => c.textContent.trim());
      if (!next) break;
      n = next;
    }
    return n;
  };
  const styleOf = (el) => {
    const s = getComputedStyle(el);
    return {
      font: s.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
      size: parseFloat(s.fontSize),
      weight: +s.fontWeight,
      color: s.color,
      lineHeight: s.lineHeight === 'normal' ? null : parseFloat(s.lineHeight),
      align: s.textAlign,
    };
  };
  const container = document.querySelector('#MENU_AS_CONTAINER, [id^="MENU_AS_CONTAINER"]');
  const items = [...document.querySelectorAll('[data-testid="linkElement"]')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && el.closest('#MENU_AS_CONTAINER');
    })
    .map((el) => ({ text: el.innerText.replace(/\u200b/g, '').trim(), href: el.getAttribute('href'), rect: rect(el), style: styleOf(textEl(el)) }));
  const panels = [...document.querySelectorAll('#MENU_AS_CONTAINER, #MENU_AS_CONTAINER *')]
    .map((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { id: el.id, bg: s.backgroundColor, rect: { x: Math.round(r.x), y: Math.round(r.y - y0), w: Math.round(r.width), h: Math.round(r.height) } };
    })
    .filter((p) => p.bg !== 'rgba(0, 0, 0, 0)' && p.rect.w > 100);
  const close = document.querySelector('#MENU_AS_CONTAINER_CLOSE, [aria-label="Close navigation menu"]');
  return { container: container ? rect(container) : null, items, panels: panels.slice(0, 6), close: close ? rect(close) : null, docHeight: document.documentElement.scrollHeight - y0 };
};

async function open(browser, url, { width, device }) {
  const context = await browser.newContext(device ? { ...device, viewport: { width, height: 844 }, deviceScaleFactor: 1 } : { viewport: { width, height: 900 } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(7000);
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.8;
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 320));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(2200);
  const offset = await page.evaluate(() => {
    const ads = document.querySelector('#WIX_ADS');
    return ads ? ads.getBoundingClientRect().height : 0;
  });
  return { page, context, offset };
}

const browser = await chromium.launch();
const args = process.argv.slice(2);
const wantSite = args.includes('--site');
const only = args.filter((a) => !a.startsWith('--'));
const pages = JSON.parse(await readFile('src/layout/pages.json', 'utf8'));
const mobileDevice = { ...devices['iPhone 12'] };
await mkdir('src/layout', { recursive: true });

if (wantSite) {
  const home = pages.find((p) => p.slug === 'home');
  const site = { source: SITE, captured: new Date().toISOString(), desktopRef: DESKTOP_REF };

  for (const [name, width] of [['desktop', DESKTOP_REF], ['desktopWide', DESKTOP_WIDE]]) {
    const { page, context, offset } = await open(browser, home.url, { width });
    const data = await page.evaluate(PAGE_JS, { offset, wantMenu: false });
    site[name] = { header: data.header, footer: data.footer, bands: data.bands, docHeight: data.docHeight };
    await context.close();
  }

  const { page, context, offset } = await open(browser, home.url, { width: MOBILE_W, device: mobileDevice });
  const data = await page.evaluate(PAGE_JS, { offset, wantMenu: false });
  site.mobile = { header: data.header, footer: data.footer, bands: data.bands, docHeight: data.docHeight };
  await context.close();

  const menu = await open(browser, home.url, { width: MOBILE_W, device: mobileDevice });
  await menu.page.locator('#MENU_AS_CONTAINER_TOGGLE').click({ timeout: 15000 });
  await menu.page.waitForTimeout(2500);
  site.mobileMenu = await menu.page.evaluate(MENU_JS, { offset: menu.offset });
  await menu.page.screenshot({ path: 'src/layout/mobile-menu.png', fullPage: false });
  await menu.context.close();

  await writeFile('src/layout/site.json', JSON.stringify(site, null, 1));
  console.log(`site.json: header ${site.desktop.header.rect.h}px, footer ${site.desktop.footer.rect.h}px, menu items ${site.mobileMenu.items.length}`);
}

for (const { slug, url } of pages.filter((p) => !only.length || only.includes(p.slug))) {
  const shots = {};
  for (const [name, width, device] of [
    ['ref', DESKTOP_REF, null],
    ['wide', DESKTOP_WIDE, null],
    ['mobile', MOBILE_W, mobileDevice],
  ]) {
    const { page, context, offset } = await open(browser, url, { width, device });
    shots[name] = await page.evaluate(PAGE_JS, { offset, wantMenu: false });
    await context.close();
  }
  // Wix serves a different rendition at each width, so images are matched by
  // their media id rather than by URL.
  const key = (b) => {
    const media = /([0-9a-f]{6}_[0-9a-f]{32}~mv2\.[a-z]+)/i.exec(b.src || '') || /([0-9a-f]{6}_[0-9a-f]{32}~mv2\.[a-z]+)/i.exec(b.iframe || '');
    return `${b.kind}:${b.href || ''}:${media ? media[1].toLowerCase() : b.iframe || ''}:${b.text ? b.text.slice(0, 30) : b.rect.y}`;
  };
  const wideByKey = new Map();
  shots.wide.blocks.forEach((b) => wideByKey.set(key(b), b));
  const blocks = shots.ref.blocks.map((b) => ({ ...b, wide: (wideByKey.get(key(b)) || b).rect }));
  const out = {
    slug,
    url,
    captured: new Date().toISOString(),
    desktop: {
      width: DESKTOP_REF,
      wideWidth: DESKTOP_WIDE,
      docHeight: shots.ref.docHeight,
      header: shots.ref.header,
      footer: shots.ref.footer,
      bands: shots.ref.bands,
      gallery: shots.ref.gallery,
      blocks,
    },
    mobile: {
      width: shots.mobile.viewportW,
      docHeight: shots.mobile.docHeight,
      header: shots.mobile.header,
      footer: shots.mobile.footer,
      bands: shots.mobile.bands,
      gallery: shots.mobile.gallery,
      blocks: shots.mobile.blocks,
    },
  };
  await writeFile(path.join('src/layout', `${slug}.json`), JSON.stringify(out, null, 1));
  console.log(`${slug}: desktop ${blocks.length} blocks ${Math.round(shots.ref.docHeight)}px · mobile ${shots.mobile.blocks.length} blocks ${Math.round(shots.mobile.docHeight)}px`);
}

await browser.close();
