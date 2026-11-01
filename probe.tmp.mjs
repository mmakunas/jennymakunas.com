import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
const pages = JSON.parse(await readFile('src/layout/pages.json', 'utf8'));
const b = await chromium.launch();
for (const pg of pages) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await p.goto(pg.url, { waitUntil: 'load', timeout: 60000 });
    await p.waitForTimeout(3500);
    await p.evaluate(async () => { const step = window.innerHeight * 0.8; for (let y = 0; y < document.documentElement.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 150)); } window.scrollTo(0, 0); });
    const n = await p.evaluate(() => [...document.querySelectorAll('div,hr')].filter((el) => {
      const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
      const t = parseFloat(cs.borderTopWidth) || 0; const bb = parseFloat(cs.borderBottomWidth) || 0;
      return (t > 0 || bb > 0) && r.width > 150 && r.height <= 8 && !el.querySelector('img, video');
    }).length);
    console.log(pg.slug.padEnd(36), n);
  } catch (e) { console.log(pg.slug, 'ERR', e.message.slice(0, 60)); }
  await p.close();
}
await b.close();
