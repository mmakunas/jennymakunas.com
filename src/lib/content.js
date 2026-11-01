// Parses the generated content tree (`content/<slug>.md`) into the ordered
// block list the page templates render. The tree is plain enough that the
// parser stays small: front matter, headings, paragraphs, images (alone or
// inside a link), bullet lists, and the HTML comments `extract.py` leaves where
// it could not carry a block (a video player, the contact form).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

export const familyOf = (font) => {
  const f = (font || '').toLowerCase();
  if (f.startsWith('cormorant')) return 'cormorant';
  if (f.startsWith('futura')) return 'futura';
  if (f.startsWith('avenir')) return 'avenir';
  return 'system';
};

const unescapeWs = (s) => s.replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();

// Inline Markdown → HTML. The generated files use bold, italics and links;
// `\*` is a literal asterisk (it appears in the Wix copy and must stay one).
export function inline(text) {
  const tokens = [];
  const keep = (html) => `\u0000${tokens.push(html) - 1}\u0000`;
  let s = text
    .replace(/\\\*/g, () => keep('*'))
    .replace(/\\\[/g, () => keep('['))
    .replace(/\\\]/g, () => keep(']'))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, label, href, title) => {
    const external = /^https?:/i.test(href);
    return keep(`<a href="${href}"${title ? ` title="${title}"` : ''}${external ? ' target="_blank" rel="noopener"' : ''}>${label}</a>`);
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[+i]);
  return s;
}

const plain = (html) => unescapeWs(html.replace(/<[^>]+>/g, ''));

const parseFrontMatter = (source) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!m) return { data: {}, body: source };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s*(.*)$/i.exec(line.trim());
    if (!kv) continue;
    const raw = kv[2].trim();
    data[kv[1]] = raw === 'null' ? null : /^-?\d+$/.test(raw) ? Number(raw) : raw.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return { data, body: m[2] };
};

// A hard line break in the source is a trailing double space, as in Markdown.
const BREAK = '\u0001';
const withBreaks = (chunk) =>
  chunk
    .split(/\n/)
    .map((line, i, all) => (i < all.length - 1 && / {2,}$/.test(line) ? `${line.trimEnd()}${BREAK}` : line.trim()))
    .join(' ')
    .replace(new RegExp(` {2,}${BREAK}`, 'g'), BREAK);

export const toHtml = (text) => inline(text).replace(new RegExp(BREAK, 'g'), '<br />');

export function parseBlocks(body) {
  const blocks = [];
  const chunks = body.split(/\n\s*\n/);
  for (const raw of chunks) {
    const chunk = raw.trim();
    if (!chunk) continue;
    const comment = /^<!--\s*(.*?)\s*-->$/s.exec(chunk);
    if (comment) {
      const text = comment[1];
      if (/^video not captured:/i.test(text)) blocks.push({ type: 'video', label: text.replace(/^video not captured:\s*/i, '') });
      else if (/^form not captured:/i.test(text)) blocks.push({ type: 'form', label: text.replace(/^form not captured:\s*/i, '') });
      else if (/^embedded player not captured:/i.test(text)) blocks.push({ type: 'embed', label: text.replace(/^embedded player not captured:\s*/i, '') });
      continue;
    }
    const heading = /^(#{1,6})\s+([\s\S]*)$/.exec(chunk);
    if (heading) {
      const html = toHtml(withBreaks(heading[2].trim()));
      blocks.push({ type: 'text', tag: `h${heading[1].length}`, html, text: plain(html) });
      continue;
    }
    const linkedImage = /^\[!\[([^\]]*)\]\(([^)\s]+)\)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/.exec(chunk);
    if (linkedImage) {
      blocks.push({ type: 'image', alt: linkedImage[1], src: linkedImage[2], href: linkedImage[3], caption: linkedImage[4] || '' });
      continue;
    }
    const image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(chunk);
    if (image) {
      blocks.push({ type: 'image', alt: image[1], src: image[2], href: null, caption: '' });
      continue;
    }
    if (/^([-*]|\d+\.)\s+/.test(chunk)) {
      const items = chunk.split(/\n/).map((li) => li.replace(/^\s*([-*]|\d+\.)\s+/, '').trim()).filter(Boolean);
      const html = items.map((li) => `<li>${inline(li)}</li>`).join('');
      blocks.push({ type: 'list', html, text: plain(html), items: items.length });
      continue;
    }
    const html = toHtml(withBreaks(chunk));
    blocks.push({ type: 'text', tag: 'p', html, text: plain(html) });
  }
  return blocks;
}

let cache = null;
export function allPages() {
  if (cache) return cache;
  const dir = path.join(root, 'content');
  const files = readdirSafe(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
  cache = files
    .map((file) => {
      const slug = file.replace(/\.md$/, '');
      const source = readFileSync(path.join(dir, file), 'utf8');
      const { data, body } = parseFrontMatter(source);
      return { slug, ...data, blocks: parseBlocks(body) };
    })
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  return cache;
}

const readdirSafe = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
