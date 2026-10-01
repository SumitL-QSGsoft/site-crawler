# Demo Web App

A small local web UI on top of the existing crawler engine (`../src`). Paste a
website URL in, click **Start Crawl**, and watch it discover screens, modals,
buttons/actions and forms — rendered live in the browser instead of only as
markdown files.

The crawling logic itself (navigation, extraction, modal/form discovery,
graph/screen writing) is unmodified — this only wraps `Crawler` from
`../src/crawl/crawler.js` in an Express server and renders its output.

## Run it

```
npm install
npm run web
```

Then open http://localhost:4000.

## Notes

- Each crawl runs headless Chromium in-process; output (screenshots,
  content.md, meta.json) is written per-job under `webapp/runs/<jobId>/`
  (git-ignored) and served statically so screenshots show up in the UI.
- Only `http://` / `https://` URLs are accepted, and loopback/private/link-local
  hosts are rejected to reduce SSRF risk since this is a web-facing form.
- Auth-walled sites aren't supported here (no interactive/manual login) — use
  the CLI (`npm start -- --url ... --auth manual`) for those.
- Jobs are kept in memory only and are lost on server restart.
