# NFL DFS Lineup Optimizer

A free lineup optimizer for DraftKings, FanDuel and Yahoo NFL contests: classic on all three, DraftKings Showdown, FanDuel Single Game and DraftKings Tiers. It runs entirely in your browser on GitHub Pages. A scheduled GitHub Action fetches DraftKings slates and Sleeper projections and deploys them straight to your Pages site. The data is never committed, so the repo stays the same size all season.

## What updates automatically

| Data | How it gets in |
| --- | --- |
| DraftKings classic and Showdown slates | Automatic. Pick a slate on the Projections tab. |
| DraftKings Tiers | Download the player CSV from the contest and import it with Tiers selected. |
| Sleeper projections | Automatic. Full PPR for DraftKings, half PPR for FanDuel and Yahoo. |
| FanDuel (classic and Single Game) and Yahoo | Download the player CSV from the contest page and import it. Sleeper is applied for you. |
| Daily Fantasy Fuel | Download their free projections CSV and import it as a source. Columns are detected automatically. |
| Any other source | Import any CSV with a name column and a points column. |

## Setup (about 5 minutes)

1. Create a new **public** repository on GitHub (free Actions minutes and Pages need public on the free plan).
2. Upload everything in this folder, keeping the folder structure. The `.github` folder is hidden on some computers; make sure it uploads.
3. **Settings → Pages → Build and deployment:** set Source to **GitHub Actions**.
4. **Actions tab → Update data and deploy → Run workflow** to build the site with this week's data.
5. Open `https://<your-username>.github.io/<repo-name>/` when the run finishes (about a minute).

## Put it on your home screen

Open your site in Safari (iPhone) or Chrome (Android), then tap **Share → Add to Home Screen** (iPhone) or **⋮ → Add to Home screen / Install app** (Android). It gets the football icon, is named “Lineups,” and opens full screen like an app.

## Schedule

Tuesday to Saturday three times a day, Thursday afternoon before the night game, and every hour Sunday morning until the 1pm ET lock. Edit the `cron` lines in `.github/workflows/update-data.yml` to change it. Scheduled runs can start a few minutes late when GitHub is busy.

## Storage

Only the current week's data exists, on the live site. Each run replaces it. The build files GitHub keeps for each deploy expire after 1 day.

## Notes

- The DraftKings and Sleeper endpoints are public but unofficial. If one fails, the job copies the last good data from the live site and the Actions log shows the error.
- GitHub normally pauses schedules after 60 days without a commit. The job re-enables itself on every scheduled run, so it shouldn't pause. If it ever does, turn it back on from the Actions tab.
- Locks, weights and your imported files are saved in your browser only.
