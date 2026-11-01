// Behaviour check on the built site: routes answer, the mobile menu opens and
// navigates, the trailer facade only loads YouTube after a click, media is
// local, and nothing is requested from Wix.
//   BASE=/jennymakunas.com/ npm run verify
import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
const BASE = (process.env.BASE || '/').replace(/\/?$/, '/');
const pages = JSON.parse(await readFile(path.join(root, 'src/layout/pages.json'), 'utf8'));

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.pdf': 'application/pdf' };
const server = createServer(async (req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = url.startsWith(BASE) ? url.slice(BASE.length) : url.replace(/^\//, '');
  for (const file of [path.join(dist, rel), path.join(dist, rel, 'index.html')]) {
    if (existsSync(file) && file.startsWith(dist)) {
      try {
        const data = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
        return res.end(data);
      } catch {}
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});
await new Promise((r) => server.listen(0, r));
const local = `http://127.0.0.1:${server.address().port}${BASE}`;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });
const browser = await chromium.launch();

// 1. Every route answers, with no Wix requests and no remote images.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const wix = [];
  page.on('request', (r) => {
    if (/wixsite|wixstatic|parastorage|wix\.com/.test(r.url())) wix.push(r.url());
  });
  const remote = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(local) && !u.startsWith('data:') && !u.startsWith('blob:')) remote.push(u);
  });
  for (const p of pages) {
    const res = await page.goto(`${local}${p.path.replace(/^\//, '')}`, { waitUntil: 'domcontentloaded' });
    check(`route ${p.path} → ${res.status()}`, res.status() === 200);
  }
  await page.waitForTimeout(1500);
  check('no request to any wix domain', wix.length === 0, wix.slice(0, 3).join(' '));
  check('no third-party requests at all', remote.length === 0, [...new Set(remote)].slice(0, 4).join(' '));
  await ctx.close();
}

// 2. Media: local videos with posters, local images.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  let videos = 0;
  const badPosters = [];
  const earlyControls = [];
  const badCanonicals = [];
  for (const p of pages) {
    await page.goto(`${local}${p.path.replace(/^\//, '')}`, { waitUntil: 'domcontentloaded' });
    const info = await page.evaluate(() => ({
      vids: [...document.querySelectorAll('video')].map((v) => ({
        src: v.getAttribute('src'),
        poster: v.getAttribute('poster'),
        controls: v.hasAttribute('controls'),
        autoplay: v.hasAttribute('autoplay'),
        loop: v.hasAttribute('loop'),
      })),
      imgs: [...document.querySelectorAll('img')].map((i) => i.getAttribute('src')),
    }));
    videos += info.vids.length;
    for (const v of info.vids) {
      if (!v.poster) badPosters.push(`${p.slug}: no poster`);
      // Wix shows a still and a play circle, and no control bar until the film starts.
      if (v.controls) earlyControls.push(`${p.slug}: control bar before play`);
    }
    const canonical = await page.getAttribute('link[rel="canonical"]', 'href');
    const wanted = `${(process.env.SITE || 'https://www.jennymakunas.com').replace(/\/$/, '')}${BASE === '/' ? '' : BASE.replace(/\/$/, '')}${p.path}`;
    if (canonical !== wanted) badCanonicals.push(`${p.slug}: ${canonical} (wanted ${wanted})`);
    const remoteImgs = info.imgs.filter((s) => s && !s.startsWith(BASE));
    check(`${p.slug}: all images local (${info.imgs.length})`, remoteImgs.length === 0, remoteImgs.slice(0, 2).join(' '));
  }
  check('nine films render as <video>', videos === 9, `found ${videos}`);
  check('every film has a poster', badPosters.length === 0, badPosters.join(' '));
  check('no control bar before a film is played', earlyControls.length === 0, earlyControls.join(' '));
  check('every page carries its canonical address', badCanonicals.length === 0, badCanonicals.slice(0, 2).join(' '));
  await ctx.close();
}

// 3. Links: mailto on contact and home footer, Instagram and LinkedIn as served.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${local}contact-8/`, { waitUntil: 'domcontentloaded' });
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('a')].map((a) => a.getAttribute('href')));
  check('contact has the mailto', hrefs.some((h) => h && h.startsWith('mailto:jenny@makunas.com')));
  check('contact has the phone link', hrefs.some((h) => h && h.startsWith('tel:4156091504')));
  check('Instagram link as served', hrefs.includes('https://www.instagram.com/a_live_one/'));
  check('LinkedIn link as served', hrefs.some((h) => h && h.includes('linkedin.com/in/jennymakunas')));
  await ctx.close();
}

// 4. The mobile menu opens, holds the keyboard, expands Work, and navigates.
{
  const ctx = await browser.newContext({ ...devices['iPhone 12'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(local, { waitUntil: 'domcontentloaded' });
  await page.click('.burger');
  await page.waitForTimeout(300);
  const open = await page.evaluate(() => {
    const el = document.getElementById('mobile-menu');
    return !!el && !el.hidden;
  });
  check('mobile menu opens', open);
  await page.click('#mobile-menu .sub-toggle');
  await page.waitForTimeout(200);
  const studies = await page.evaluate(() => document.querySelectorAll('#menu-work a').length);
  check('Work expands to the 11 case studies', studies === 11, `${studies}`);
  const trapped = await page.evaluate(async () => {
    const overlay = document.getElementById('mobile-menu');
    const items = [...overlay.querySelectorAll('a[href], button')].filter((el) => el.offsetParent !== null);
    const last = items[items.length - 1];
    last.focus();
    return { last: document.activeElement === last, inside: overlay.contains(document.activeElement) };
  });
  await page.keyboard.press('Tab');
  const wrapped = await page.evaluate(() => {
    const overlay = document.getElementById('mobile-menu');
    const first = [...overlay.querySelectorAll('a[href], button')].filter((el) => el.offsetParent !== null)[0];
    return overlay.contains(document.activeElement) && document.activeElement === first;
  });
  check('the open menu keeps the keyboard inside it', trapped.inside && wrapped, `${JSON.stringify(trapped)} ${wrapped}`);
  const restored = await page.evaluate(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { className: document.activeElement?.className || '', closed: document.getElementById('mobile-menu').hidden };
  });
  check('closing the menu returns the keyboard to the menu button', restored.className === 'burger' && restored.closed, JSON.stringify(restored));
  await page.click('.burger');
  await page.waitForTimeout(200);
  if (!(await page.evaluate(() => document.getElementById('menu-work').classList.contains('open')))) {
    await page.click('#mobile-menu .sub-toggle');
    await page.waitForTimeout(200);
  }
  await page.click('#menu-work a:nth-child(2) a, #menu-work a');
  await page.waitForTimeout(500);
  check('menu navigates', page.url().includes('/now-you-brand-campaign') || page.url().includes('/anna-wintour'), page.url());
  await ctx.close();
}

// 5. The trailer is a facade: no YouTube iframe until it is clicked.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const yt = [];
  page.on('request', (r) => {
    if (/youtube|ytimg/.test(r.url())) yt.push(r.url());
  });
  await page.goto(`${local}animaniacs-x-masterclass/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const before = await page.evaluate(() => document.querySelectorAll('iframe').length);
  check('no YouTube iframe before the click', before === 0 && yt.length === 0, `${before} iframes`);
  await page.click('.facade');
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => [...document.querySelectorAll('iframe')].map((f) => f.src));
  check('click inserts the youtube-nocookie player', after.some((s) => s.includes('youtube-nocookie.com/embed/')), after.join(' '));
  await ctx.close();
}

// 6. A film starts from its still: the play circle is the only thing shown, and the
// control bar arrives with the click, as Wix's does.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${local}now-you-brand-campaign/`, { waitUntil: 'domcontentloaded' });
  const before = await page.evaluate(() => {
    const v = document.querySelector('video');
    return { controls: v.hasAttribute('controls'), title: !!document.querySelector('.filmtitle') };
  });
  check('a film shows its still and play circle, no controls', before.title && !before.controls, JSON.stringify(before));
  await page.locator('.filmtitle').scrollIntoViewIfNeeded();
  await page.click('.filmtitle');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => {
    const v = document.querySelector('video');
    return { controls: v.controls, facade: !!document.querySelector('.filmtitle') };
  });
  check('clicking the still gives the film its controls', after.controls && !after.facade, JSON.stringify(after));
  await ctx.close();
}

// 7. A picture that has its own phone rendering uses it on a phone.
{
  const ctx = await browser.newContext({ ...devices['iPhone 12'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const wrong = [];
  let checked = 0;
  for (const slug of ['today-s-the-day-brand-campaign', 'now-you-brand-campaign', '23andme-dna-day-2023']) {
    await page.goto(`${local}${slug}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      for (let y = 0; y < document.documentElement.scrollHeight; y += window.innerHeight * 0.8) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 150));
      }
    });
    await page.waitForTimeout(400);
    const results = await page.evaluate(() => [...document.querySelectorAll('picture')].map((pic) => {
      const phone = pic.querySelector('source[media*="749.9"]');
      const crop1440 = pic.querySelector('source[media*="1449.9"]');
      const img = pic.querySelector('img');
      if (!img || !img.currentSrc) return null;
      const used = img.currentSrc.split('/').pop();
      return {
        wanted: phone ? phone.getAttribute('srcset').split('/').pop() : null,
        // A 1440 crop must never reach a phone: the extractor records no phone
        // rendition when that crop is the widest one's, and the widest one is
        // what a phone is owed then.
        crop1440: crop1440 ? crop1440.getAttribute('srcset').split('/').pop() : null,
        crop1440Media: crop1440 ? crop1440.getAttribute('media') : null,
        widest: img.getAttribute('src').split('/').pop(),
        used,
      };
    }).filter(Boolean));
    checked += results.length;
    for (const r of results) {
      if (r.crop1440Media && !/min-width:\s*750px/.test(r.crop1440Media)) wrong.push(`${slug}: the 1440 crop applies below 750px (${r.crop1440Media})`);
      if (r.used === r.crop1440) wrong.push(`${slug}: a phone renders the 1440 crop ${r.used}`);
      if (!r.wanted) continue;
      if (r.used !== r.wanted) wrong.push(`${slug}: ${r.used} instead of ${r.wanted}`);
    }
  }
  check('a picture with a phone rendering uses it on a phone', checked > 0 && wrong.length === 0, `${checked} checked, ${wrong.slice(0, 2).join(' ')}`);
  await ctx.close();
}

// 8. Picture boxes sit where the layout says at 1440 — the geometry interpolates from
// the block's 983 rect to its 1440 rect, and a picture prop that shadowed that rect once
// collapsed every image box to the left edge while every other check stayed green.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const problems = [];
  for (const slug of ['23andme-dna-day-2023', 'now-you-brand-campaign']) {
    const layout = JSON.parse(await readFile(path.join(root, 'src/layout', `${slug}.json`), 'utf8'));
    const expected = layout.desktop.blocks.filter((b) => b.kind === 'image' || b.kind === 'video');
    await page.goto(`${local}${slug}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    const measured = await page.evaluate(() => {
      const canvas = document.querySelector('.canvas');
      // A container query width is the viewport minus the scrollbar, which is what the
      // calc()s interpolate against.
      const width = document.documentElement.clientWidth;
      return {
        width,
        boxes: [...canvas.querySelectorAll('.blk.image, .blk.video')].map((el) => {
          const r = el.getBoundingClientRect();
          return { x: +(r.x - canvas.getBoundingClientRect().x).toFixed(1), w: +r.width.toFixed(1) };
        }),
      };
    });
    // The canvas stretches with the viewport, so the interpolation is evaluated at the
    // width the canvas was actually given rather than at 1440 exactly.
    const t = (Math.max(983, measured.width) - 983) / (1440 - 983);
    for (const box of measured.boxes) {
      const near = expected
        .map((b) => {
          const wide = b.wide || b.rect;
          return { x: b.rect.x + (wide.x - b.rect.x) * t, w: b.rect.w + (wide.w - b.rect.w) * t };
        })
        // A picture box must land on one of the captured 1440 rects, near enough that a
        // lost or collapsed box cannot hide inside the tolerance.
        .find((e) => Math.abs(e.x - box.x) <= 8 && Math.abs(e.w - box.w) <= 8);
      if (!near) problems.push(`${slug}: a box at x=${box.x} w=${box.w} is not in the capture`);
    }
    const html = await page.content();
    if (html.includes('NaNpx')) {
      problems.push(`${slug}: a box computed NaN geometry`);
    }
  }
  check('picture boxes keep their captured 1440 geometry', problems.length === 0, problems.slice(0, 3).join(' '));
  await ctx.close();
}

// 9. The desktop Work dropdown reveals the 11 case studies.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(local, { waitUntil: 'domcontentloaded' });
  await page.hover('.nav-work');
  await page.waitForTimeout(250);
  const n = await page.evaluate(() => {
    const menu = document.querySelector('.work-menu');
    return menu ? [...menu.querySelectorAll('a')].filter((a) => a.getBoundingClientRect().height > 0).length : 0;
  });
  check('Work dropdown shows 11 case studies', n === 11, `${n}`);
  await ctx.close();
}

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
