# admin/ — build notes (step 4, 2026-10-28)

Vite 6 + React 18 + react-router-dom 6, plain CSS, Vitest + testing-library. Structure and the
canvas editor are copied from codenameduck's admin and stripped of every TV concept (actions, key
map, focus ring, screens, menu/button/apps/app_launcher/banner/digits/popup). Served by the Node
server under `/admin` from `admin/dist`.

## Dev / build / test

```
cd admin
npm install
npm run dev        # http://localhost:5173/admin/ — proxies /api and /media to http://127.0.0.1:3100 (VITE_DEV_TARGET overrides)
npm run build      # → admin/dist (the server serves it; install.sh builds it)
npx vitest run     # 21 tests: login flow + site switcher, editor (template, durations, Ctrl-D/Delete/undo, single video), geometry, media refs
```

`vite.config.js` has `fs.allow: ['..']` because the editor imports `../../../shared/*` directly
(`zone-types.json`, `fonts.json`, `layout-model.js`, `zone-draw.js`, `zones.css`,
`fonts/fonts.css` + the `.woff2` files, which Vite bundles into `dist/assets`). No stubs were
needed: `shared/` was complete before the first build.

## Pages

| Route | What |
|---|---|
| `/login` | email + password → `POST /login` |
| `/` Dashboard | one card per player across every visible site: thumbnail, online dot, site, current layout, fps / CPU / bitrate / restarts, version, uptime, last seen; refreshes every 15 s |
| `/players`, `/players/:id` | selected site's players; create → modal with the key and pair command (copy buttons, "shown once" note); drawer with edit (name, resolution, default layout), rotate key, and the **schedule rules** table (weekday chips, time window, date range, priority, enabled) |
| `/layouts`, `/layouts/:id` | list with `LayoutThumb`, new from template (blank + `shared/layout-templates.json`), duplicate, delete; editor = Canvas / Preview / Advanced JSON, PageNavigator with per-page `duration_s`, palette, toolbar (align, distribute, z-order, lock), typed ZonePanel, undo/redo 50, Ctrl-Z/Y, Ctrl-D, Delete, Ctrl-S; save = publish |
| `/media` | selected site's library: drag-drop / button upload with per-file progress (XHR), status badge processing / ready / failed (polls every 3 s while processing), rename, delete, preview (image / video / audio), "Retry normalisation" for failed items |
| `/sites` (superadmin) | CRUD + Members modal (role per user: none / editor / admin) |
| `/users` (superadmin) | create, reset password, superadmin flag, delete |

Site switcher in the sidebar: the sites from `/me` (a superadmin gets every site). The chosen
site is kept in `localStorage['ihc.site']`; every site-scoped page keys on it and shows a
"create / join a site" notice when there is none. Non-superadmins never see Sites/Users (nav
and routes).

## Zone property panels (ZonePanel.jsx) — field names match `shared/zone-draw.js`

| type | fields stored on the zone |
|---|---|
| text | `text` (variables menu inserts `{{site}}`, `{{time}}`, `{{date}}`), `style.{fontFamily,fontSize,fontWeight,fontStyle,align,valign,color,background,padding,borderRadius,opacity,shadow}` |
| image | `src` (`media:<id>` from the picker, or a URL, or `{{logo}}`), `fit` |
| slideshow | `images: ["media:<id>"…]`, `interval_s`, `fade`, `fit` |
| video | `playlist: [{src:"media:<id>", name}]`, `loop`, `mute`; panel warns: one per layout, drawn as a hole |
| ticker | `items: [string…]`, `separator`, `speed` (px/s), style |
| clock / date | `format` |
| weather | `lat`, `lon`, `units` (`metric`/`imperial`), `showText` |
| qr | `data`, `fg`, `bg`, `ecl`, `caption` |
| html | `url` |
| shape | `shape` (`rect`/`ellipse`), `fill`, `border` (CSS), `radius` |

Library media is **always stored as `media:<id>`** (`src/mediaUrl.js`): that is what the
server's manifest / delete protection and the player's cache key on. The admin resolves the
token to `/api/admin/sites/:site/media/:id/file|thumb` only for display (canvas, preview via
`env.mediaUrl`, panel thumbnails). The preview's `{{logo}}` is `media:<site.logo_media_id>`,
as the server sends it to players.

The video region is a singleton: the palette item is disabled once one exists, Ctrl-D /
toolbar duplicate skips it, duplicating a page shares it, and the type selector hides `video`
when another zone already has it.

## API the UI uses (verified against server/src/routes/admin.js with the server running)

The brief's contract differed from what the server ships; the UI follows the **server**:

- `POST /login`, `GET /me` → `{ user: {id,email,is_superadmin}, sites: [{id,name,slug,timezone,logo_media_id,role}] }` (login gives `sites: null` for a superadmin; the UI then calls `/me`). `POST /logout`.
- `GET /dashboard` → `{ sites: [{ …site, players: [...], counts }] }` (a flat `{players}` is also accepted).
- `GET /sites`, `POST /sites {name,slug,timezone}`, `PATCH /sites/:id`, `DELETE /sites/:id`.
- Members: `GET /sites/:id/members` → `[{id,email,is_superadmin,role}]`; `PUT /sites/:id/members {user_id, role}` (one upsert per call); `DELETE /sites/:id/members/:user`. The Members modal diffs and sends only changes.
- `GET/POST /users`, `PATCH /users/:id {password | is_superadmin}`, `DELETE /users/:id`; rows carry `memberships: [{site_id, role, site_name}]`.
- Players: `GET/POST /sites/:s/players` (POST → `{ …player, key, pair }`; `default_layout_id` is not accepted on create, so the UI PATCHes it right after), `PATCH /sites/:s/players/:id {name,resolution,default_layout_id}`, `POST …/rotate-key` → `{ …player, key, pair }`, `DELETE`. Player rows: `online, last_seen_at, version, resolution, status{cpu_pct,fps,bitrate_kbps,restarts_last_hour,uptime_s}, output, thumbnail_url, current_layout_id, current_layout_name`.
- Schedules: `GET/POST /sites/:s/players/:p/schedules`, **`PUT`** `…/schedules/:id` (partial body merged server-side), `DELETE`. Fields as in the brief (`days_mask` bit0 = Mon).
- Layouts: `GET/POST /sites/:s/layouts {name, json}`, `GET /sites/:s/layouts/:id` (adds `players: [{id,name}]`), **`PUT`** `/sites/:s/layouts/:id {name, json}`, `POST …/duplicate`, `DELETE` (409 `{players}` while in use). `GET /layout-templates`.
- Media: `GET /sites/:s/media` (rows: `kind,name,mime,size,width,height,duration_s,status,error,url,thumb_url,ref`), `POST /sites/:s/media` multipart `file` + `name`, `PATCH …/:id {name}`, `POST …/:id/retry`, `DELETE` (409 `{layouts, logo}` while referenced).

Session cookie `ihc_session`, same-origin; a 401 anywhere dispatches `ihc:unauthorized` and
the app returns to the login page.

## Verified

- `npm run build` → `admin/dist` (287 kB JS, 20 kB CSS, fonts bundled); `npx vitest run` → 21 passed.
- Real server (`server/src/index.js`, in-memory data dir) + built dist in headless Chrome:
  login, dashboard card, player drawer with a schedule rule, editor on the Lobby template
  (7 zones, palette = the 11 signage types), preview drawn by `shared/zone-draw.js` with the
  live clock and Inter loaded, media page. No console exceptions.
- Every admin endpoint above exercised with curl (create site, layout from template, PUT
  layout, create player + PATCH default layout, schedule POST/PUT, user + membership, PNG
  upload → thumbnail, delete).

## Open items for the server / shared agent

1. **`shared/layout-model.js` `upgradeLayout()` deletes `items` from every zone**
   (`delete c.items`, left over from stripping coopcentric menu items). Since the ticker's
   lines live in `items`, every load/save (server `validateLayout` and the editor's
   `ensurePages`) wipes them — the stored Lobby template's ticker has no `items` and the
   preview shows the "ticker" placeholder. Drop that `delete` (or limit it to the removed TV
   types); nothing else in the admin depends on it.
2. `POST /sites/:s/players` ignores `default_layout_id` (the UI works around it with a PATCH).
3. The brief's `pair_command` / `{player, key}` / `PATCH` layout / `memberships` spellings do
   not exist on the server; the UI accepts both spellings where cheap, but the server's are
   canonical.
4. Weather: the zone carries `lat`/`lon`/`units`; the server/player need to fetch Open-Meteo
   for those coordinates (the preview uses sample data).
