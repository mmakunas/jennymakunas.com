// The fidelity pass: renders every page of the built site at desktop 1440 and
// mobile 390 with Wix blocked, captures the same page from the live Wix site,
// and writes a side-by-side comparison for each of the 30 pairs into shots/.
//
//   npm run shots              # needs dist/ from npm run build
//   npm run shots -- --only now-you-brand-campaign
import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const dist = path.join(root, 'dist');
const out = path.join(root, 'shots');
const BASE = (process.env.BASE || '/').replace(/\/?$/, '/');
const WIX = 'https://jenny6926.wixsite.com/mysite';

const pages = JSON.parse(await readFile(path.join(root, 'src/layout/pages.json'), 'utf8'));
const only = process.argv.indexOf('--only');
const wanted = only > -1 ? pages.filter((p) => p.slug === process.argv[only + 1]) : pages;

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.pdf': 'application/pdf', '.ico': 'image/x-icon' };

const server = createServer(async (req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = url.startsWith(BASE) ? url.slice(BASE.length) : url.replace(/^\//, '');
  const candidates = [path.join(dist, rel), path.join(dist, rel, 'index.html'), path.join(dist, `${rel}.html`)];
  for (const file of candidates) {
    if (!existsSync(file) || !file.startsWith(dist)) continue;
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
      return;
    } catch {}
  }
  if (!res.headersSent) res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});
await new Promise((r) => server.listen(0, r));
const local = `http://127.0.0.1:${server.address().port}${BASE}`;

await mkdir(out, { recursive: true });
const browser = await chromium.launch();

const shot = async ({ url, width, device, file, blockWix }) => {
  const context = await browser.newContext(device ? { ...device, viewport: { width, height: 844 }, deviceScaleFactor: 1 } : { viewport: { width, height: 900 } });
  const page = await context.newPage();
  if (blockWix) await page.route(/wix|wixstatic|parastorage/, (r) => r.abort());
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(blockWix ? 1500 : 7000);
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.8;
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 220));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: file, fullPage: true });
  await context.close();
};

const W = 760;
const compare = async (buildFile, wixFile, outFile) => {
  const scale = async (f) => {
    const img = sharp(f);
    const meta = await img.metadata();
    const width = Math.min(W, meta.width || W);
    const buf = await img.resize({ width }).toBuffer();
    const { height } = await sharp(buf).metadata();
    return { buf, width, height };
  };
  const a = await scale(buildFile);
  const b = await scale(wixFile);
  const gap = 24;
  const width = a.width + gap + b.width;
  const height = Math.max(a.height, b.height) + 44;
  await sharp({ create: { width, height, channels: 3, background: '#1b171d' } })
    .composite([
      { input: a.buf, top: 44, left: 0 },
      { input: b.buf, top: 44, left: a.width + gap },
    ])
    .png()
    .toFile(outFile);
};

const rows = [];
for (const page of wanted) {
  for (const [bp, width, device] of [
    ['desktop', 1440, null],
    ['mobile', 390, devices['iPhone 12']],
  ]) {
    const buildFile = path.join(out, `${page.slug}-${bp}-build.png`);
    const wixFile = path.join(out, `${page.slug}-${bp}-wix.png`);
    const cmpFile = path.join(out, `${page.slug}-${bp}.png`);
    await shot({ url: `${local}${page.path.replace(/^\//, '')}`, width, device, file: buildFile, blockWix: true });
    await shot({ url: page.url, width, device, file: wixFile, blockWix: false });
    await compare(buildFile, wixFile, cmpFile);
    rows.push({ slug: page.slug, bp, file: cmpFile });
    console.log(`shot ${page.slug} ${bp}`);
  }
}

await writeFile(path.join(out, 'index.json'), JSON.stringify(rows, null, 1));
await browser.close();
server.close();
console.log(`${rows.length} comparisons in ${path.relative(root, out)}/`);
