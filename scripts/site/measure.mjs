// Geometric diff: the same block inventory on the live Wix page and on the
// built site, matched by image media id, with the delta in pixels at 1440.
//   node scripts/site/measure.mjs [slug]
import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
const BASE = (process.env.BASE || '/').replace(/\/?$/, '/');
const pages = JSON.parse(await readFile('src/layout/pages.json', 'utf8'));
const want = process.argv[2];

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
  if (!res.headersSent) res.writeHead(404);
  res.end('nope');
});
await new Promise((r) => server.listen(0, r));
const local = `http://127.0.0.1:${server.address().port}${BASE}`;

const inventory = async (page) =>
  page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('img')) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      out.push({ kind: 'img', src: el.currentSrc || el.src, x: Math.round(r.x), y: Math.round(r.y + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) });
    }
    for (const el of document.querySelectorAll('video')) {
      const r = el.getBoundingClientRect();
      out.push({ kind: 'video', src: 'video', x: Math.round(r.x), y: Math.round(r.y + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) });
    }
    for (const el of document.querySelectorAll('h1,h2,h3,p')) {
      if (el.parentElement.closest('h1,h2,h3,p')) continue;
      const t = el.innerText.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const r = el.getBoundingClientRect();
      out.push({ kind: 'text', text: t, x: Math.round(r.x), y: Math.round(r.y + window.scrollY), w: Math.round(r.width), h: Math.round(r.height), size: parseFloat(getComputedStyle(el).fontSize) });
    }
    return out;
  });

const media = (u) => {
  const m = /([0-9a-f]{6}_[0-9a-f]{32}~mv2\.[a-z]+)/i.exec(u || '');
  return m ? m[1].toLowerCase() : (u || '').split('/').pop();
};
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40);

const browser = await chromium.launch();
for (const page of pages.filter((p) => !want || p.slug === want)) {
  const open = async (url, opts = {}) => {
    const ctx = await browser.newContext(opts.device ? { ...opts.device, viewport: { width: opts.width, height: 844 }, deviceScaleFactor: 1 } : { viewport: { width: opts.width, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await p.waitForTimeout(opts.device ? 6000 : 6000);
    await p.evaluate(async () => {
      const step = window.innerHeight * 0.8;
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 200));
      }
      window.scrollTo(0, 0);
    });
    await p.waitForTimeout(800);
    return { p, ctx };
  };
  for (const [bp, width, device] of [['desktop', 1440, null], ['mobile', 390, devices['iPhone 12']]]) {
    const ours = await open(`${local}${page.path.replace(/^\//, '')}`, { width, device });
    const theirs = await open(page.url, { width, device });
    const a = await inventory(ours.p);
    const b = await inventory(theirs.p);
    const offset = device ? 38 : 50; // the Wix ad banner the rebuild does not carry
    const key = (i) => (i.kind === 'text' ? `t:${norm(i.text)}` : i.kind === 'video' ? 'v' : `i:${media(i.src)}`);
    // On phones Wix renders a 320px layout scaled to the device width, so its
    // rects are in that smaller space until multiplied out.
    const wixScale = device ? width / 320 : 1;
    const theirsByKey = new Map();
    for (const i of b) {
      // The ad banner is in Wix's own coordinate space, so it scales too.
      theirsByKey.set(key(i), { ...i, x: i.x * wixScale, y: i.y * wixScale - offset * wixScale, w: i.w * wixScale, h: i.h * wixScale });
    }
    const deltas = [];
    for (const i of a) {
      const t = theirsByKey.get(key(i));
      if (!t) continue;
      deltas.push({ k: key(i).slice(0, 34), dx: i.x - t.x, dy: i.y - t.y, dw: i.w - t.w, dh: i.h - t.h });
    }
    if (process.env.VERBOSE) {
      console.log('  ours:', JSON.stringify(a.filter((i) => i.kind === 'video' || i.kind === 'text').slice(0, 3)));
      console.log('  wix :', JSON.stringify(b.filter((i) => i.kind === 'video').slice(0, 3)));
      console.log('  scale wix innerWidth', await theirs.p.evaluate(() => window.innerWidth), 'ours', await ours.p.evaluate(() => window.innerWidth));
    }
    const off = deltas.filter((d) => Math.abs(d.dx) > 2 || Math.abs(d.dy) > 3 || Math.abs(d.dw) > 2 || Math.abs(d.dh) > 3);
    console.log(
      `${page.slug} ${bp}: ${deltas.length} matched, ${off.length} off by >2px, ours ${a.length} blocks / wix ${b.length}`,
    );
    for (const d of off.slice(0, 12)) console.log(`   ${d.k.padEnd(34)} dx ${String(d.dx).padStart(5)} dy ${String(d.dy).padStart(5)} dw ${String(d.dw).padStart(5)} dh ${String(d.dh).padStart(5)}`);
    await ours.ctx.close();
    await theirs.ctx.close();
  }
}
await browser.close();
server.close();
