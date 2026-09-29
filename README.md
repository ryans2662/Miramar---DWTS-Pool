# Miramar's DWTS Pool

Weekly Dancing with the Stars pool. Pick one couple from each tier; judges' scores decide the week; points accumulate over the season. Once 6 or fewer couples remain, the tiers drop and it's the final stretch: pick any two couples. In the finale, players also pick a champion for bonus points.

- `index.html` is the site, hosted on GitHub Pages.
- `worker/` is the shared backend (Cloudflare Worker + D1) that stores players, picks, and scores.

## One-time setup

**1. Deploy the backend** (from the `worker` folder):

```
npx wrangler login
npx wrangler d1 create ballroom-pool          # copy the database_id it prints into wrangler.toml
npx wrangler d1 execute ballroom-pool --remote --file=schema.sql
npx wrangler d1 execute ballroom-pool --remote --file=seed.sql
npx wrangler secret put ADMIN_PASSWORD        # your commissioner password
npx wrangler deploy                           # prints your Worker URL
```

**2. Point the site at it.** In `index.html`, set `const API=` to the Worker URL from the deploy step.

**3. Publish the site.** Push this repo to GitHub, then Settings > Pages > Deploy from branch > `main` / root. Share the Pages URL.

**4. Optional: lock the API to your site.** In `worker/wrangler.toml`, set `ALLOWED_ORIGIN` to your Pages origin (e.g. `https://yourname.github.io`) and run `npx wrangler deploy` again.

## Weekly routine (Commissioner tab)

1. Lock picks before the show starts.
2. After the show, enter each couple's judges' total and check who was eliminated.
3. Start the next week. Tiers rebuild from season average automatically, and switch to the final stretch on their own once 6 or fewer couples remain.

**Finale week.** Right after starting the finale week, before anyone picks, tick "Week N is the finale" in the Week panel, set the champion bonus (25 by default), and save finale settings. Players must then pick a champion along with their couples. After the show, choose the winner under Champion and save again; everyone who picked them gets the bonus added to that week.

Players join with a name and a 4 to 8 digit PIN. For anyone who'd rather text you their picks, add them under Players and enter picks for them from the Picks tab.
