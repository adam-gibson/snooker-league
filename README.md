# Patteson Social Club Snooker

The club website: a home page (`index.html`) linking to the **League** (`league.html`) and the **Ladder** (separate site, unchanged).

- **Website** is hosted on GitHub Pages from this repository.
- **League data** is stored in a Google Sheet, read and updated by a Google Apps Script (`apps-script/Code.gs`). It is separate from the ladder's sheet.
- The old Spring 2026 page is kept at `archive/spring-2026.html`.

## Setting up the league (one time only)

1. Go to <https://sheets.new> and name the sheet **Snooker League**.
2. **Extensions > Apps Script**: delete what is there, paste in all of `apps-script/Code.gs` and save.
3. Optional: type your own admin PIN between the quotes in `const ADMIN_PIN = '';`.
4. Open the **Snooker Ladder spreadsheet** (not its Apps Script page). Its address looks like `docs.google.com/spreadsheets/d/LONG-CODE/edit`. Copy the long code and paste it between the quotes in `const LADDER_SHEET_ID = '';`. Players who are on both then use their ladder PIN, and changing it on either site changes both.
5. Choose **setup** from the function drop-down and click **Run**. Allow the permissions. This also creates the **Winter 2026-27** season (see `INITIAL_SEASON` at the top of the script). The PINs of league-only players are shown in the run log and in Admin > Players.
6. **Deploy > New deployment**, cog, **Web app**: Execute as **Me**, Who has access **Anyone**. Deploy and copy the URL ending `/exec`.
7. Paste that URL into `config.js` (`LEAGUE_API_URL`).
8. **Settings > Pages**: Deploy from a branch, **main**, **/ (root)**. The site appears at `https://adam-gibson.github.io/snooker-league/`.
9. Your admin PIN is in the sheet's **Settings** tab (`adminPin`).

Updating the script later: paste the new code, then **Deploy > Manage deployments**, pencil, **Version: New version**, Deploy. The URL stays the same.

## Starting a season

Open the league, go to **Admin** (bottom of the page) and choose **Set up a new season**:

- Season name, e.g. *Winter 2026-27*.
- Start date: the Sunday of the first week.
- Player names, one per line, top division first.
- Number of divisions and players in each (Yellow, then Green, then Brown, Blue, Pink, Black).
- Weeks with no matches, e.g. `2026-12-20 Christmas`.
- Catch-up weeks at the end.
- Play-off final between the Yellow and Green winners (in the week after the catch-up week). Choose the finalists in Admin > results; the current leaders are filled in for you.

A preview shows the divisions and the final week before you create it. Everyone plays everyone twice: home (left) in the first half and away in the second. With an odd number of players, one player has a bye each week.

New players are given a 4-digit PIN, shown once when the season is created (and always in Admin > Players). Players already in the list keep theirs. You can set a player's PIN to match their ladder PIN under **Edit**.

## Scores

- A player chooses their name, taps a match, picks the score and enters their PIN.
- The opponent confirms or disputes it, or the admin confirms it. Only confirmed results count.
- Optional: in Settings, set **auto-confirm after (hours)** to confirm results nobody disputes.
- Admin can set, confirm or clear any score, and withdraw a player (their matches stop counting).

Points: 1 per frame won plus 2 for a match win (both changeable in Settings). Ties: frame difference, then wins, then frames won.

## End of season

Admin > Seasons > **Finish and archive**. The season stays on the site under the season picker for anyone to look back at; scores can no longer be entered. **Reopen** undoes this.
