# Spawnbook

A daily board and a weekly report on small, fast-growing Roblox games, for the studios and investors who buy them. Scores each game out of 100 from public Roblox data, estimates what it could sell for, flags risks, and includes a free valuation tool for developers. Data updates automatically every day.

## What's in here

Everything the site serves is in `public/`:

| File | What it is |
| --- | --- |
| `index.html` | The landing page: what Spawnbook is, a peek at today's top pick, and the sign-up form. |
| `board.html` | The full daily board. Only signed-in visitors whose access hasn't run out can open it. |
| `data.js` | Today's board, picks and tables, replaced automatically every day. Gated like the board. |
| `value.html` | The free valuation tool and request form for developers. Public. |
| `subscribe.html` | Pricing, shown when someone's free day is over. |
| `site.css`, `site.js` | Shared styles and page behaviour. |
| `privacy.html`, `terms.html`, `cookies.html`, `refunds.html`, `legal.css` | The policy pages. |
| `fonts/` | Big Shoulders and Public Sans, served from the site itself. Both are under the SIL Open Font License (see the `OFL-*.txt` files). |
| `favicon.svg` | The browser-tab icon. |
| `og.png` | The 1200×630 preview image that LinkedIn, Discord, Slack and others show when someone shares the link. |
| `_headers` | Security headers. |

`wrangler.jsonc` at the top level tells Cloudflare to run `worker/index.js` in front of the `public` folder.

## Sign-ups and access

`worker/index.js` is the sign-up gate. Signing up on the landing page gives 24 hours of free access to the board, then sends people to the pricing page. Sign-ups are stored in a Cloudflare Durable Object (SQLite), which Cloudflare creates on deploy.

To see sign-ups and give paying subscribers access, add a secret named `ADMIN_KEY` to the Worker in Cloudflare (Settings → Variables and Secrets) and open `/admin` with that password. From there you can set anyone's days of access, end it, delete someone, or download everyone as a CSV.

## Hosting

The site is plain HTML with no build step. It runs on Cloudflare Workers: connect this repository, leave the build command empty and keep the deploy command `npx wrangler deploy`.

Visits are counted with Cloudflare Web Analytics, which Cloudflare adds to each page automatically. The Content-Security-Policy in `_headers` allows its script from `static.cloudflareinsights.com`; it reports back to the site's own `/cdn-cgi/rum`, which `connect-src 'self'` already covers.

## How the data updates

GitHub Actions runs `.github/workflows/daily.yml` once a day, at 21:33 UTC (2:33 PM Pacific in summer, 1:33 PM in winter). Each run reads Roblox's public chart lists and game stats, scores the young games against their history, and commits:

- `public/data.js`, the new board, which makes Cloudflare redeploy the site
- the day's reading in `pipeline/state/hist/`, the daily record the growth scores are worked out from
- `pipeline/last-run.json`, a summary of the run
- on Mondays, that week's picks in `pipeline/state/picks/` and `pipeline/picks-log.csv`, for the weekly report and its track record

To start a run by hand, open the **Actions** tab, pick **Daily data pull** and click **Run workflow**. If a run fails, GitHub emails you and the site keeps showing the last good data.

| File in `pipeline/` | What it is |
| --- | --- |
| `collector.js` | Reads Roblox's public APIs, keeps the daily record and scores the games. |
| `runner.mjs` | Runs the collector in Node, reading and writing the record in `state/`. |
| `apply-batch.mjs` | Saves each run's changes to the record in `state/`. |

A Claude scheduled task copies the day's `public/data.js` to the Claude-hosted version of the site after the run.
