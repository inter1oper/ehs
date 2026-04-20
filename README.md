# Meal Menu

A small static web app that pulls today's breakfast, lunch, and dinner from
the published EHS Google Sheets, shows photos for each dish, and lets you
search Google Images for any food item.

Live data sources:

- Breakfast — [published sheet](https://docs.google.com/spreadsheets/d/e/2PACX-1vQAlRze_52a3tIEwh7S504rO9dDSpUs8PFo79tiOJxjJQc-nKKAK6MrcCj8_uakl8_MnrujU4aS8bXj/pubhtml)
- Lunch — [published sheet](https://docs.google.com/spreadsheets/u/2/d/e/2PACX-1vRBl5DZC8B5QifnbVsFQDqZ0pLeoHL-TE2Z_3-WvzLSRtgjUQjn0jmTSI9IUMEqnufxPD7jP7Ky0y0z/pubhtml)
- Dinner — [published sheet](https://docs.google.com/spreadsheets/u/2/d/e/2PACX-1vSE_IkMGx1BOtazOic5f4Dcy_j6S4h_KSb-gsDNha4wf6wpgmN35aDCytFfD-cOoHpQyIF8f2g5UsQh/pubhtml)

## Features

- Today's full menu, with tabs to jump to any day in the published week.
- Inline photo per dish, looked up via the Wikipedia search API and cached in
  `localStorage`.
- "Photo" button per card to try the next-best Wikipedia match if the first
  one isn't right.
- "Google" button per card and a top-bar search box that opens a Google
  Images query in a new tab.
- Dark mode and light mode that follow the OS by default, with a manual
  toggle that cycles dark → light → auto.
- Responsive layout for desktop and mobile.
- Installable PWA (manifest + service worker). On iPhone Safari a one-time
  banner explains how to add the app to the Home Screen.

## Local preview

Serve the folder with any static server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

The Google Sheets pubhtml endpoints serve CSV via `?output=csv` and respond
with permissive CORS, so no proxy is needed.

## Deploy

This repo includes `.github/workflows/pages.yml`, which publishes the site to
GitHub Pages on every push to `main` or to the `claude/meal-menu-web-app-*`
branch.

To enable it the first time:

1. Open the repo on GitHub.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **GitHub Actions**.
4. Push a commit (or run the workflow manually) and the site will appear at
   `https://<owner>.github.io/<repo>/`.

## File layout

| File                          | Purpose                                          |
| ----------------------------- | ------------------------------------------------ |
| `index.html`                  | App shell, day tabs, search bar, iOS banner      |
| `styles.css`                  | Themes (light/dark, auto), responsive layout     |
| `app.js`                      | CSV fetch + parse, rendering, image lookup       |
| `sw.js`                       | Service worker (cache app shell, network for data) |
| `manifest.webmanifest`        | PWA metadata                                     |
| `icon.svg`, `icon-*.png`      | App icons                                        |
| `.github/workflows/pages.yml` | GitHub Pages deploy                              |
