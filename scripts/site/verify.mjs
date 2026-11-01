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

// 7. The desktop Work dropdown reveals the 11 case studies.
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
