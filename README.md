# Tanks a lot

Rainwater tank tracker and rain history for Norton Summit, South Australia. Runs as an installable web app on GitHub Pages.

- **Rain**: this year against every year since 1889, long-term patterns, and how El Niño, La Niña and the Indian Ocean Dipole have played out locally.
- **Outlook**: replays the tanks through every historical rain sequence from today's date to give odds, not forecasts.
- **Tanks**: tank level and meter readings (data lives in a private Google Sheet via Apps Script; nothing private is stored in this repo).

Rain data: SILO (Queensland Government), refreshed daily by `.github/workflows/update-data.yml` (needs the `SILO_EMAIL` repository secret). Climate driver years: Bureau of Meteorology, in `data/drivers.json`.
