// Fails the build when the output would break under the GitHub Pages base path:
// an absolute URL that skips the prefix wherever the page carries one — href, src,
// srcset, poster, action, a CSS url() — or any request to Wix.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), 'dist');
const base = (process.env.BASE || '/').replace(/\/?$/, '/');
const problems = [];

const walk = (d) =>
  readdirSync(d).flatMap((f) => {
    const p = path.join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const files = walk(dir).filter((f) => /\.(html|css)$/.test(f));

const attributes = /\b(href|src|poster|action|srcset|content)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const cssUrls = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi;
const wix = /https?:\/\/[^\s"'()]*(?:wixsite|wixstatic|parastorage|wix\.com)[^\s"'()]*/gi;

const urls = (attribute, value) =>
  attribute.toLowerCase() === 'srcset'
    ? value.split(',').map((candidate) => candidate.trim().split(/\s+/)[0]).filter(Boolean)
    : [value];

const inspect = (rel, target) => {
  const url = target.trim();
  if (!url || url.startsWith('#') || url.startsWith('data:')) return;
  if (url.startsWith('//')) problems.push(`${rel}: protocol-relative request ${url}`);
  else if (url.startsWith('/') && !url.startsWith(base)) problems.push(`${rel}: ${url} skips base ${base}`);
};

for (const file of files) {
  const rel = path.relative(dir, file);
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(attributes)) {
    for (const target of urls(m[1], m[2] ?? m[3] ?? '')) inspect(rel, target);
  }
  for (const m of text.matchAll(cssUrls)) inspect(rel, m[1] ?? m[2] ?? m[3] ?? '');
  for (const m of text.matchAll(wix)) problems.push(`${rel}: wix request ${m[0]}`);
}

if (problems.length) {
  console.error(`lint:paths — ${problems.length} problem(s) at base ${base}`);
  for (const p of [...new Set(problems)].slice(0, 40)) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`lint:paths — ${files.length} files clean at base ${base}`);
