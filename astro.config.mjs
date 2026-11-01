import { defineConfig } from 'astro/config';

// GitHub Pages serves this repo from two places:
//   production — www.jennymakunas.com, served at the root            BASE=/
//   preview    — www.makunas.com/jennymakunas.com/, served under a path
//                BASE=/jennymakunas.com/
// Every internal URL goes through Astro's base-aware helpers, and a build step
// fails if any absolute href/src in the output skips the prefix.
const base = process.env.BASE || '/';

export default defineConfig({
  site: process.env.SITE || 'https://www.jennymakunas.com',
  base,
  trailingSlash: 'ignore',
  build: { format: 'directory', inlineStylesheets: 'always' },
  devToolbar: { enabled: false },
});
