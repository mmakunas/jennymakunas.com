// Prints how each page's Markdown blocks landed on the captured geometry:
// how many placed, and anything left over in either direction.
import { composePage } from '../../src/lib/site.js';
import { allPages } from '../../src/lib/content.js';

const pages = allPages();
for (const { slug } of pages) {
  let c;
  try {
    c = composePage(slug);
  } catch (e) {
    console.log(`${slug.padEnd(38)} MISMATCH — ${e.message.slice(0, 140)}`);
    continue;
  }
  const orphans = c.orphaned.filter((o) => !/no image left/.test(o.why));
  const flag = c.leftover.length || orphans.length ? '  <-- check' : '';
  console.log(
    `${slug.padEnd(38)} blocks ${String(c.blocks.length).padStart(2)} tiles ${String((c.tiles || []).length).padStart(2)} left ${c.leftover.length} orphan ${c.orphaned.length}${flag}`,
  );
  for (const o of c.orphaned) console.log(`    orphan: ${o.why} — ${(o.block.text || o.block.src || '').slice(0, 50)}`);
  for (const b of c.leftover) console.log(`    leftover: ${b.type} — ${(b.text || b.src || b.label || '').slice(0, 50)}`);
}
