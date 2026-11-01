// Fails the build when the output would break under the GitHub Pages base path:
// an absolute href/src that skips the prefix, or any request to Wix.
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

const files = walk(dir).filter((f) => f.endsWith('.html'));
for (const file of files) {
  const rel = path.relative(dir, file);
  const html = readFileSync(file, 'utf8');
  for (const m of html.matchAll(/(?:href|src)="(\/[^"]*)"/g)) {
    const target = m[1];
    if (!target.startsWith(base)) problems.push(`${rel}: ${target}`);
  }
  for (const m of html.matchAll(/https?:\/\/[^"'\s)]*(wixsite|wixstatic|parastorage)[^"'\s)]*/g)) {
    problems.push(`${rel}: wix request ${m[0]}`);
  }
}

if (problems.length) {
  console.error(`lint:paths — ${problems.length} problem(s) at base ${base}`);
  for (const p of [...new Set(problems)].slice(0, 40)) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`lint:paths — ${files.length} pages clean at base ${base}`);
