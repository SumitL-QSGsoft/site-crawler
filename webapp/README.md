# Demo Web App

A small local web UI on top of the existing crawler engine (`../src`). Paste a
website URL in, click **Start Crawl**, and watch it discover screens, modals,
buttons/actions and forms — rendered live in the browser instead of only as
markdown files.

The crawling logic itself (navigation, extraction, modal/form discovery,
graph/screen writing) is unmodified — this only wraps `Crawler` from
`../src/crawl/crawler.js` in an Express server and renders its output.

The crawler records conditional views reached by clicking through a page even when
the URL does not change. These appear as `#state:` screens connected to the page
that revealed them. Nested click exploration obeys the configured max link depth;
links found on later rows of a visible table are included. Repeated row action
buttons are still sampled from the first row to keep probing bounded, so sites
where each row has unique button-only navigation may need additional coverage.

## Run it

```
npm install
npm run web
```

Then open http://localhost:4000.

## Repeat crawls

The first successful crawl saves a checkpoint alongside its screenshots and knowledge-base
files. Clicking **Start Crawl** again for the same URL reuses the previous result: known
pages are checked briefly, and only changed or newly discovered pages are fully extracted
and probed. The browser remembers the last successful job for each URL across server
restarts. Clear this site's browser storage to start a fresh crawl. Changing the depth
or same-site setting also starts a fresh crawl.

The CLI works the same way when reusing `--out`: `npm start -- --url https://example.com`.
Login may still be required on every run; credentials and browser sessions are not
reused from an old job. A page that cannot be loaded on a repeat run retains its previous
capture rather than being reported as verified current content.

## Notes

- Each crawl runs headless Chromium in-process; output (screenshots,
  content.md, meta.json) is written per-job under `webapp/runs/<jobId>/`
  (git-ignored) and served statically so screenshots show up in the UI.
- Only `http://` / `https://` URLs are accepted, and loopback/private/link-local
  hosts are rejected to reduce SSRF risk since this is a web-facing form.
- Auth-walled sites aren't supported here (no interactive/manual login) — use
  the CLI (`npm start -- --url ... --auth manual`) for those.
- Jobs are kept in memory only and are lost on server restart.
