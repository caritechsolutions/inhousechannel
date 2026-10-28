# Content server — build notes (step 3, built 2026-10-28)

## What exists

### `shared/` (copied from codenameduck and cut down to signage)
- `zone-types.json` — `text image slideshow video ticker clock date weather qr html shape`.
- `layout-model.js` — schema-2 document: `canvas`, `zones[]`, `pages[{id,name,zones,duration_s}]`.
  Pages are timed (default 15 s) and cycle; `upgradeLayout()` drops TV fields (keys, focus,
  home, actions, items), gives pages durations, and puts zones referenced by no page on the first
  page. `validatePages()`, `nextPageId()`, `pageDuration()`, `visibleZoneList()`, `videoZone()`.
  Import-free, so the server loads it with `esm.js`.
- `zone-draw.js` — one drawer per type; `renderStage()` draws one page; `runPages()` cycles pages
  on a timer; `tick()` refreshes clock/date/`{{time}}`/`{{date}}` once a second. Ticker and
  slideshow fade run as CSS animations stepped at 30 fps (`steps()`), never rAF. The `video`
  zone draws a transparent hole with `data-video-region="1"`. `qr` uses `qr.js`.
- `qr.js` — import-free QR encoder (byte mode, versions 1–10, EC L/M; verified decoding with
  OpenCV). `qrSvg()` returns inline SVG.
- `zones.css`, `fonts.json`, `fonts/` (OFL woff2 + `fonts.css`), `layout-templates.json`
  (lobby, menu board, full-screen slideshow).

Media references inside layouts are the token `media:<id>`; `env.mediaUrl()` maps it to a URL
(`/api/player/media/<id>` on the server, `./media/<id>` in the player's cache). `{{site}}` and
`{{logo}}` come from the manifest's `ctx`.

### `server/`
Node 20 + Express 4 + better-sqlite3 + bcryptjs + busboy + sharp (same conventions as codenameduck:
forward-only SQL migrations in `src/migrations/`, HttpOnly session cookie `ihc_session`).

- `src/app.js` `buildApp({dbPath|memory, dataDir, adminDist, publicUrl, log, now})` → `{app, server, db, …}`.
- `src/index.js` listens on `HOST`/`PORT` (127.0.0.1:3100); `src/config.js` reads `IHC_DATA`,
  `IHC_DB`, `IHC_ADMIN_DIST`, `PUBLIC_URL`.
- `src/auth.js` — users (email + bcrypt), sessions, `requireAuth`, `requireSuperadmin`,
  `siteAccess(req, siteId, minRole)` via memberships (superadmin bypasses), `createUser()`.
- `src/media.js` — streamed uploads sniffed by magic bytes, stored at `<data>/media/<site>/<uuid>.<ext>`;
  images get sharp thumbnails (`<data>/thumbs/`) + dimensions; video/audio go through an
  in-process one-at-a-time ffmpeg queue (CLAUDE.md §3.4 profile: 720p30 H.264 High, GOP 60,
  ≤ 6 Mb/s, AAC 48 kHz stereo, `+faststart`; a silent track is synthesised when the source has
  none). `status` processing → ready/failed; the original is kept; `sha256` is of the file players
  download. Jobs left `processing` by a crash are re-queued at startup.
- `src/schedule.js` — `resolveLayout({default_layout_id, schedules}, now, tz)`; weekday mask bit 0 =
  Sunday, `HH:MM` windows, end < start = overnight (and an overnight window belongs to the weekday
  it started on), inclusive local date range, priority then lowest id.
- `src/players.js` — key issue (`ihc_…`, sha256 stored, last 4 chars shown), manifest, strong ETag
  that ignores the time-dependent `current_layout_id`, heartbeat storage.
- `src/renderer.js` — the renderer zip (shared files + fonts + generated `render.html`).
  `render.html?res=WxH&layout=…&ctx=…&media=…` loads `./layout.json` + `./ctx.json`, scales the
  1920×1080 stage, cycles pages, exposes `window.__ihcPage` / `window.__ihcVideoRect()`.
  Verified in headless Chromium: logo, text, clock, date, image via `media:` mapping, QR, ticker.
- `src/routes/admin.js` — login/logout/me; dashboard; superadmin sites + users; site-scoped
  (404 for sites the caller cannot see) members, players (create returns the key once + `pair`
  command, patch, rotate-key, delete, thumbnail), schedules, layouts (validate, templates,
  duplicate, in-use delete refusal), media (multipart or raw upload, rename, retry, references,
  delete with 409 while referenced).
- `src/routes/player.js` — bearer key: `manifest` (ETag/304), `media/:id` (Range), `renderer`
  (zip, ETag/304), `heartbeat`, `thumbnail` (raw JPEG ≤ 300 KB), `time`.
- `src/cli.js` — `create-superadmin <email> <password>`, `set-password`, `count-users`.
- `inhousechannel-server.service`, `.env.example` (`/etc/inhousechannel/server.env` holds `PUBLIC_URL`),
  `install.sh` (Node 20 from NodeSource with keyring, ffmpeg, clone to `/opt/inhousechannel/src`,
  `npm ci`, admin build when `admin/` exists, system user, data dir, unit, superadmin seed via
  `/dev/tty` or `IHC_ADMIN_EMAIL`/`IHC_ADMIN_PASSWORD`, `/healthz` check, NPM instructions).

## Running the tests

```
cd server && npm ci && npm test        # node --test, in-memory SQLite, temp data dir
```
18 tests: auth + membership scoping, superadmin CRUD, layout validation (unknown types, >1 video
zone, page durations, upgrade), shared model + QR loaded in Node, media (magic bytes, PNG thumbnail,
delete refusal, ffmpeg video normalisation — skipped when ffmpeg is missing), player pairing /
manifest / ETag / heartbeat / thumbnail / rotate, renderer zip, schedule resolution and API.

## Deviations from the spec / notes for step 4 (admin UI)

- The spec's `POST /api/player/heartbeat` "optional thumbnail, multipart" is split: heartbeat is
  JSON, the thumbnail is a separate `POST /api/player/thumbnail` with a raw JPEG body (simpler for
  the Python player).
- Weather: `src/weather.js` is copied but not wired to a route yet; the renderer reads
  `ctx.weather` when the player puts it in `ctx.json`. Add `GET /api/player/weather` when needed.
- Fonts uploaded as media (kind `font`) are stored and listed but not yet turned into
  `@font-face` rules in the renderer — only the bundled OFL fonts are usable in layouts for now.
- The `html` zone loads `url` in a sandboxed iframe; a raw `html` string is also accepted.
- No WebSocket push yet (`ws` is a dependency for later live updates); players poll every 60 s.
- Schedules belong to a player; there is no group concept.
