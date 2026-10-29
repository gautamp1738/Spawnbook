# Spawnbook

A daily board and a weekly report on small, fast-growing Roblox games, for the studios and investors who buy them. Scores each game out of 100 from public Roblox data, estimates what it could sell for, flags risks, and includes a free valuation tool for developers. Data updates automatically every day.

## What's in here

Everything the site serves is in `public/`:

| File | What it is |
| --- | --- |
| `index.html` | The landing page: what Spawnbook is, a peek at today's top pick, and the sign-up form. |
| `board.html` | The full daily board. Only signed-in visitors whose access hasn't run out can open it. |
| `data.js` | Today's board, picks and tables, replaced automatically every day. Gated like the board. |
| `report.html`, `report.js` | The weekly report: each Monday's top 10, biggest movers, what's new and what fell off the board (with the reason), and how last week's picks did. Has an archive and a "Copy as an email" button. Signed-in visitors with access only. `report.js` is rebuilt every day. |
| `trends.html` | "What's working on Roblox": a public, shareable write-up of the Oct 28, 2026 reading of Roblox's top 100 games (minus the 10 biggest), comparing hits launched in the last six months with young games that stayed small. Static; rebuilt by hand from a fresh reading. |
| `game.html` | A page for each game (`/game?pid=<place id>`): players, visits a day and rating over time, compared with up to two other games by date or by days since launch, board history, live numbers, and watchlist status and notes. Signed-in visitors with access only. |
| `watchlist.html` | Each member's followed games with live player counts, change since they last looked and over a week, board rank, deal status and notes. |
| `market.html` | Genre trends among young games: players, like-for-like change, share, new launches and the fastest riser per genre, plus the fastest-rising and newest games. |
| `history.js` | The daily readings behind those three pages (60 days), rebuilt every day. Gated like the board. |
| `tools.js` | Shared code for those pages, including the charts. |
| `track.html`, `track.js` | The public track record: every Monday's picks at 1, 2, 4 and 8 weeks, next to the games that made the cut but weren't picked. `track.js` only names a week's picks once they're a week old. |
| `value.html` | The free valuation tool and request form for developers. Public. |
| `subscribe.html` | Pricing, shown when someone's free day is over. |
| `signin.html` | Sign in with email and password, or ask for an emailed link under "Forgot your password?". Visitors who open the board signed out land here. |
| `account.html` | Who's signed in, when their access ends, change or set a password, and sign out. Also where one-time password links open (`/account#t=...`). |
| `site.css`, `site.js` | Shared styles and page behaviour. |
| `privacy.html`, `terms.html`, `cookies.html`, `refunds.html`, `legal.css` | The policy pages. |
| `fonts/` | Big Shoulders and Public Sans, served from the site itself. Both are under the SIL Open Font License (see the `OFL-*.txt` files). |
| `favicon.svg` | The browser-tab icon. |
| `og.png` | The 1200×630 preview image that LinkedIn, Discord, Slack and others show when someone shares the link. |
| `_headers` | Security headers. |

`wrangler.jsonc` at the top level tells Cloudflare to run `worker/index.js` in front of the `public` folder.

## Accounts and access

`worker/index.js` runs the accounts. Signing up on the landing page makes an account with an email and password and gives 24 hours of free access to the board, then sends people to the pricing page. After that, people sign in at `/signin`. Signing up again with an email that already has an account never signs anyone in; it sends them to the sign-in page instead.

Accounts are stored in a Cloudflare Durable Object (SQLite), which Cloudflare creates on deploy. Passwords are kept only as salted PBKDF2-SHA256 hashes (100,000 rounds), worked out inside the Durable Object. After 8 wrong passwords for one email, that email is locked for 15 minutes.

Forgotten passwords are self-serve once email is on (see **Email** below): **Forgot your password?** on `/signin` emails a one-time link that works for 2 hours. It answers the same way whether or not the email has an account, and sends at most one link per address every 10 minutes. You can still make a link yourself: on the admin page, **Make a link** creates a one-time link (good for 7 days), which you can copy, email from your own inbox, or click **Send it from Spawnbook**. Accounts made before passwords existed can keep using the board on the device they signed up on, and are asked to set a password there.

To see accounts and give paying subscribers access, add a secret named `ADMIN_KEY` to the Worker in Cloudflare (Settings → Variables and Secrets) and open `/admin` with that password. From there you can add an account for someone who paid first, set anyone's days of access, end it, make a password link, delete someone, or download everyone as a CSV.

**Referrals.** Every account gets a referral link on its account page (`/?ref=code`). A sign-up through it records who referred them (a hidden form field carries the code; no cookie). When someone pays, click **Record a payment** on the admin page: it adds 31 days to their access, and on their first payment it automatically adds a free month (31 days) to whoever referred them and lists it under "Free months given for referrals". If that person pays monthly, skip their next charge. Members only see counts, not who signed up through them.

The owner's account (gautamuprasanna@gmail.com) is created automatically on first start with access until 2100, along with a one-time setup link that was handed over privately. Only a hash of that link is in the code.

## Email

Account emails go out through [Resend](https://resend.com) from `hello@mail.spawnbook.com`, with replies going to gautamuprasanna@gmail.com:

| When | Resend template (alias) | Variables |
| --- | --- | --- |
| Someone signs up | `spawnbook-welcome` | `NAME`, `ACCESS_ENDS` |
| Someone asks for a password link on `/signin`, or you click **Send it from Spawnbook** on the admin page | `spawnbook-password-link` | `NAME`, `LINK`, `EXPIRES` |

The wording lives in Resend (Templates), not in this code, so you can change it there and click Publish without redeploying. Keep the variable names as they are.

To turn email on, create an API key in Resend (API Keys → Create API key) with **Sending access** limited to `mail.spawnbook.com`, then add it to the Worker in Cloudflare (Settings → Variables and Secrets) as a secret named `RESEND_API_KEY`. Never put the key in this repository; it's public. Until the key is there, the site works as before and sends nothing, and "Forgot your password?" tells people to email you.

Sends are logged in the Worker's logs (Cloudflare → the spawnbook Worker → Observability) with the Resend email id, and every email shows up under Emails in Resend. A failed send never blocks a sign-up.

`news.spawnbook.com` is a second Resend domain kept for newsletters, so newsletter complaints can't hurt delivery of sign-in emails.

## Hosting

The site is plain HTML with no build step. It runs on Cloudflare Workers: connect this repository, leave the build command empty and keep the deploy command `npx wrangler deploy`.

Visits are counted with Cloudflare Web Analytics, which Cloudflare adds to each page automatically. The Content-Security-Policy in `_headers` allows its script from `static.cloudflareinsights.com`; it reports back to the site's own `/cdn-cgi/rum`, which `connect-src 'self'` already covers.

## How the data updates

GitHub Actions runs `.github/workflows/daily.yml` once a day, at 21:33 UTC (2:33 PM Pacific in summer, 1:33 PM in winter). Each run reads Roblox's public chart lists and game stats, scores the young games against their history, and commits:

- `public/data.js`, the new board, which makes Cloudflare redeploy the site
- the day's reading in `pipeline/state/hist/`, the daily record the growth scores are worked out from
- `public/track.js` and `public/report.js`, the track record and the weekly reports
- `pipeline/state/track/track.json`, every logged pick with its numbers when picked and at 1, 2, 4 and 8 weeks
- `pipeline/last-run.json`, a summary of the run
- on Mondays, that week's picks in `pipeline/state/picks/` and `pipeline/picks-log.csv`, and a new issue in `pipeline/state/report/report.json`

For each game that makes the board, the run also reads its developer products, live servers, maturity rating and badges, and the creator's group or profile and other games. The board compares each day with the one before to show rank changes, days on the board, a 14-day player line, and how players, favorites and rating moved over a day and a week. If one of those extra sources fails, the board still updates and that part shows as missing.

GitHub sometimes starts scheduled runs late or skips them, so the workflow also has two backup times, 23:07 and 00:41 UTC. A backup quits right away if that day's board is already out.

To start a run by hand, open the **Actions** tab, pick **Daily data pull** and click **Run workflow**. If a run fails, GitHub emails you and the site keeps showing the last good data.

| File in `pipeline/` | What it is |
| --- | --- |
| `collector.js` | Reads Roblox's public APIs, keeps the daily record and scores the games. |
| `runner.mjs` | Runs the collector in Node, reading and writing the record in `state/`. |
| `apply-batch.mjs` | Saves each run's changes to the record in `state/`. |

A Claude scheduled task copies the day's `public/data.js` to the Claude-hosted version of the site after the run.
