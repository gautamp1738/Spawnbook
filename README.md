# Spawnbook

A weekly scouting report on small, fast-growing Roblox games for the studios and investors who buy them. Scores each game out of 100 from public Roblox data, estimates what it could sell for, flags risks, and includes a free valuation tool for developers. Data updates automatically every day.

## What's in here

Everything the site serves is in `public/`:

| File | What it is |
| --- | --- |
| `index.html` | The report page. It reads this week's numbers from `data.js`. |
| `data.js` | This week's board, picks and tables. Replaced automatically every Monday. |
| `privacy.html`, `terms.html`, `cookies.html`, `refunds.html`, `legal.css` | The policy pages. |
| `fonts/` | Big Shoulders and Public Sans, served from the site itself. Both are under the SIL Open Font License (see the `OFL-*.txt` files). |
| `favicon.svg` | The browser-tab icon. |
| `og.png` | The 1200×630 preview image that LinkedIn, Discord, Slack and others show when someone shares the link. |
| `_headers` | Security headers. |

`wrangler.jsonc` at the top level tells Cloudflare to serve the `public` folder.

## Hosting

The site is plain HTML with no build step. It runs on Cloudflare Workers: connect this repository, leave the build command empty and keep the deploy command `npx wrangler deploy`.

Visits are counted with Cloudflare Web Analytics, which Cloudflare adds to each page automatically. The Content-Security-Policy in `_headers` allows its script from `static.cloudflareinsights.com`; it reports back to the site's own `/cdn-cgi/rum`, which `connect-src 'self'` already covers.

## How the data updates

A scheduled task reads Roblox's public charts once a day and keeps a daily record. On Mondays it writes a new `public/data.js` and commits it here, which redeploys the site.
