# jennymakunas.com

Static site for Jenny Makunas (brand strategist), ported from Wix. Astro, GitHub Pages, custom domain `www.jennymakunas.com`. The bar for the first release is "as it was": same copy, images, order and look as https://jenny6926.wixsite.com/mysite without the Wix banner. The design record is `docs/DESIGN.md`.

## Rules for agent sessions
- The repo is the whole scope. Never touch Wix, DNS, GitHub settings or any account; say in the PR when a step needs one.
- No analytics, no tracking, no third-party scripts, no request to any `wix*` domain in the built site.
- Content lives in `content/<slug>.md`; images in `public/images/` with `images/manifest.json`; never hot-link to Wix.
- Paths stay identical to the Wix site (including `/contact-8`). `BASE` env var sets Astro's `base` (`/jennymakunas.com/` preview, `/` production).
- Branch `capy/<short-name>`; PR title `Closes #N`; PR body `## What changed`, `## Why`, `## Approvals`; run `/review` before the PR when gstack is available. Do not merge: merging is Michael's.
- Never print environment values.
