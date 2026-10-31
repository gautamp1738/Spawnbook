# Spawnbook

A daily board and a weekly report on small, fast-growing Roblox games, for the studios and investors who buy them. Scores each game out of 100 from public Roblox data, estimates what it could sell for, flags risks, and includes a free valuation tool for developers. Data updates automatically every day.

## What's in here

Everything the site serves is in `public/`:

| File | What it is |
| --- | --- |
| `index.html` | The landing page: what Spawnbook is, a peek at today's top pick, and the sign-up form. |
| `board.html` | The full daily board: up to 50 young games that score 55 or more. Open to members and to visitors on their free 24 hours. Has a search box that opens the lookup. |
| `lookup.html` | Look up any Roblox game (`/lookup?q=<link, place ID or name>`): its numbers from Roblox right now, its trend from our daily record, an estimated price, and a plain-English list of what looks good, what to check first and what's worth knowing, with an overall read. Same access as the board. The work happens in `worker/lookup.js` (`/api/lookup`), which caches each game for 10 minutes. |
| `data.js` | Today's board, picks and tables, replaced automatically every day. Gated like the board. |
| `report.html`, `report.js` | The weekly report: each Monday's top 10, biggest movers, what's new and what fell off the board (with the reason), and how last week's picks did. Has an archive and a "Copy as an email" button. Signed-in visitors with access only. `report.js` is rebuilt every day. |
| `trends.html` | "What's working on Roblox": a public, shareable write-up of the Oct 28, 2026 reading of Roblox's top 100 games (minus the 10 biggest), comparing hits launched in the last six months with young games that stayed small. Static; rebuilt by hand from a fresh reading. |
| `game.html` | A page for each game (`/game?pid=<place id>`): players, visits a day and rating over time, compared with up to two other games by date or by days since launch, board history, live numbers, and watchlist status and notes. Signed-in visitors with access only. |
| `leads.html` | Verified leads, for any signed-in account (even after its access ends, so a free lead still shows): the buyer says what they buy (genres, players, visits, age, revenue, budget, kind of deal), and sees each lead sent to them with the owner's contact, asking price, verified Robux and peak players, what was checked, and their own status and notes. |
| `sell.html` | "Open to selling?": the public form for game owners. It saves their game, contact, role, what they'd sell, asking price and age group as a lead on the admin page. Their contact reaches a buyer only after they say yes. |
| `watchlist.html` | Each member's followed games with live player counts, change since they last looked and over a week, board rank, deal status and notes. |
| `market.html` | Genre trends among young games: players, like-for-like change, share, new launches and the fastest riser per genre, plus the fastest-rising and newest games. |
| `history.js` | The daily readings behind those three pages (60 days), rebuilt every day. Gated like the board. |
| `tools.js` | Shared code for those pages, including the charts. |
| `track.html`, `track.js` | The public track record: every Monday's picks at 1, 2, 4 and 8 weeks, next to the games that made the cut but weren't picked. `track.js` only names a week's picks once they're a week old. |
| `value.html` | The free valuation tool and request form for developers. Public. |
| `subscribe.html` | Pricing ($500 a month during the pilot), shown when someone's free day is over. |
| `signin.html` | Sign in with email and password. Visitors who open the board signed out land here. |
| `account.html` | Who's signed in, when their access ends, change or set a password, and sign out. Also where one-time password links open (`/account#t=...`). |
| `site.css`, `site.js` | Shared styles and page behaviour. |
| `privacy.html`, `terms.html`, `cookies.html`, `refunds.html`, `legal.css` | The policy pages. |
| `fonts/` | Big Shoulders and Public Sans, served from the site itself. Both are under the SIL Open Font License (see the `OFL-*.txt` files). |
| `favicon.svg` | The browser-tab icon. |
| `og.png` | The 1200×630 preview image that LinkedIn, Discord, Slack and others show when someone shares the link. |
| `_headers` | Security headers. |

`wrangler.jsonc` at the top level tells Cloudflare to run `worker/index.js` in front of the `public` folder.

## Accounts and access

`worker/index.js` runs the accounts. Anyone who opens a board page without an account gets a free 24-hour pass, no sign-up needed: a signed `sb_trial` cookie holds when it started (the signing key is made once and kept in the Store), and the browser keeps it for 30 days so it gets one free day. The landing page offers the pass in a popup, and the board welcomes new pass holders and shows how long is left. When it runs out, board pages send people to the pricing page. Signing up on the landing page makes an account with an email and password that runs on the same free day (or starts one), for the watchlist, buyer criteria and verified leads. After that, people sign in at `/signin`. Signing up again with an email that already has an account never signs anyone in; it sends them to the sign-in page instead.

Accounts are stored in a Cloudflare Durable Object (SQLite), which Cloudflare creates on deploy. Passwords are kept only as salted PBKDF2-SHA256 hashes (100,000 rounds), worked out inside the Durable Object. After 8 wrong passwords for one email, that email is locked for 15 minutes.

There's no automatic email yet, so forgotten passwords go through you: on the admin page, **Make a link** creates a one-time link (good for 7 days) that lets the person choose a new password. Send it to them yourself. Accounts made before passwords existed can keep using the board on the device they signed up on, and are asked to set a password there.

To see accounts and give paying subscribers access, add a secret named `ADMIN_KEY` to the Worker in Cloudflare (Settings → Variables and Secrets) and open `/admin` with that password. From there you can add an account for someone who paid first, set anyone's days of access, end it, make a password link, delete someone, or download everyone as a CSV.

`/admin/leads` runs verified leads. It lists each buyer's criteria with a **Find games** button that pulls matching games from the daily history, fastest-growing first. **Start a lead** on one, or add any game by its Roblox link; owners who fill in `/sell` appear there too. Each lead has a ready-to-send message for the owner (send it from X or Discord, not Roblox chat), a form for what the owner told you, and a **Send** button that works only once the lead is Verified: their contact, their OK to share it, their age, Robux earned and what you checked. The page checks each lead's game against Roblox and flags it if the owner has changed, which usually means it sold.

Every evening at 03:23 UTC (the cron in `wrangler.jsonc`), the Worker runs the daily leads check: it adds up to 3 new games for each buyer's criteria (15 in all), looks up who runs each game on Roblox, flags leads whose game has changed owner, and saves a summary that shows at the top of `/admin/leads` (with a **Run the daily check now** button). Suggestions nobody touches for 14 days are cleared out. Owners' Discord and X links aren't public on Roblox, so the page shows the owner's Roblox account and an X search for that name instead.

Email goes through Resend once the `RESEND_API_KEY` secret is added to the Worker in Cloudflare: the daily summary to the owner, a note to a buyer when a lead is sent to them, and an alert when someone fills in `/sell`. The sender defaults to `leads@mail.spawnbook.com` (change it with an `EMAIL_FROM` variable), so `mail.spawnbook.com` has to be verified in Resend first. Without the key, everything still works and shows on the admin page.

**Activity.** `/admin/activity` shows what people do on the site, so you can tell whether outreach brings anyone in: home page visits (with the site that sent them), free passes started, people who opened the board, lookups, accounts made and daily-email sign-ups, for the past week and day by day, plus the games people looked at and a list of the latest activity. A visitor without an account shows as "pass" and the last digits of their pass; accounts show their email. Bots and link previews are left out, and records are kept 120 days.

**The daily top 5.** Visitors can ask for the day's top 5 by email from the landing page or the board ("Email me"), and members can switch it on from their account page. Without an account it's free for 7 days, then one last email says so. Members can also connect a Discord channel on their account page by pasting a webhook link; saving it posts a hello, so a wrong link is caught right away. Both go out every evening from the same cron, after the leads check, once per board (the admin activity page has a **Send today's top 5 now** button). Every email has an unsubscribe link (which asks before unsubscribing, so link scanners can't) and one-click unsubscribe headers, and the footer carries the mailing address CAN-SPAM requires. Emails need Resend, like the rest; Discord posts work without it. For tests, `DISCORD_API_URL` replaces `https://discord.com` in webhook links.

**Referrals.** Every account gets a referral link on its account page (`/?ref=code`). A sign-up through it records who referred them (a hidden form field carries the code; no cookie). When someone pays, click **Record a payment** on the admin page: it adds 31 days to their access, and on their first payment it automatically adds a free month (31 days) to whoever referred them and lists it under "Free months given for referrals". If that person pays monthly, skip their next charge. Members only see counts, not who signed up through them.

The owner's account (gautamuprasanna@gmail.com) is created automatically on first start with access until 2100, along with a one-time setup link that was handed over privately. Only a hash of that link is in the code.

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

The board holds up to 50 games (`BOARD_MAX` in `collector.js`).

Each daily reading also keeps every game's last update time, and the index keeps a history of renames (studios often rename for a big update). From these, the board, game pages and lookup show "buyer signals": a game's rank among young games in its genre, which Roblox chart lists it's on today, whether it's ready for brand deals (rated Minimal or Mild with no outside brands in its name), its share of the most players we've seen, how often it updates between our readings, and how players moved after each rename. Update records started on Oct 30, 2026, so they fill in over the following weeks. For each game that makes the board, the run also reads its developer products, live servers, maturity rating and badges, and the creator's group or profile and other games. The board compares each day with the one before to show rank changes, days on the board, a 14-day player line, and how players, favorites and rating moved over a day and a week. If one of those extra sources fails, the board still updates and that part shows as missing.

GitHub sometimes starts scheduled runs late or skips them, so the workflow also has two backup times, 23:07 and 00:41 UTC. A backup quits right away if that day's board is already out.

To start a run by hand, open the **Actions** tab, pick **Daily data pull** and click **Run workflow**. If a run fails, GitHub emails you and the site keeps showing the last good data.

| File in `pipeline/` | What it is |
| --- | --- |
| `collector.js` | Reads Roblox's public APIs, keeps the daily record and scores the games. |
| `runner.mjs` | Runs the collector in Node, reading and writing the record in `state/`. |
| `apply-batch.mjs` | Saves each run's changes to the record in `state/`. |

A Claude scheduled task copies the day's `public/data.js` to the Claude-hosted version of the site after the run.
