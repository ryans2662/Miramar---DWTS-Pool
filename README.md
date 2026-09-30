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

1. Picks lock automatically when the live show starts: 8:00 PM Eastern on the next air date in Wikipedia's episode list, set when the week opens (next Tuesday if the list has none). If the schedule changes after that, change the time in the Week panel, or lock by hand.
2. After the show, scores and eliminations fill in automatically from the Scoring chart in Wikipedia's season article, checked every 15 minutes once the week is locked (and for two days after, to pick up corrections). To fix a number, edit it and save; hand-entered weeks are never overwritten. "Pull from Wikipedia" fetches right away and turns automatic updates back on.
3. The next week starts on its own once the week's scores are in, whether pulled from Wikipedia or saved by hand (never after the finale week). "Start week N" still works if you'd rather not wait. Tiers rebuild automatically from a weighted average in which recent weeks count more (week N counts N times; ties go to the higher score last week), and switch to the final stretch on their own once 6 or fewer couples remain.

**Finale week.** When the finale week opens, it is marked as the finale on its own, by matching its show date to the Finale episode in Wikipedia's episode list. Check that "Week N is the finale" is ticked in the Week panel (tick it by hand if Wikipedia had no finale date yet), set the champion bonus (25 by default), and save finale settings. Players must then pick a champion along with their couples. After the show, choose the winner under Champion and save again; everyone who picked them gets the bonus added to that week.

**Who goes home.** Every week except the finale, players also call the couple they think will be eliminated (any couple still dancing). A correct call adds 5 bonus points to that week; on a double elimination either couple counts. Picks can't be saved without it.

Players join with a name and a 4 to 8 digit PIN. For anyone who'd rather text you their picks, add them under Players and enter picks for them from the Picks tab.
