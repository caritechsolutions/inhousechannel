# inhousechannel — build spec

Digital signage platform by Caritech Solutions Inc. that plays out as a **TV channel**:
the player renders a layout and emits an MPEG-TS over UDP multicast directly — no
hardware encoder, no HDMI capture. The TS feeds a hotel's IP modulator (ATSC / J.83)
or IP decoders/STBs. Replaces the old Xibo + Android STB + HDMI-encoder chain.

Two deployable parts live in this repo:

| Part | Runs on | Purpose |
|---|---|---|
| `server/` | Its own Ubuntu VM (Proxmox, behind Nginx Proxy Manager) | Admin UI, layout editor, media library, schedules, player API |
| `player/` | The existing hotel "ristreceiver" box | Pulls content, renders it, outputs UDP multicast TS |

Deployment pattern (same as codenameduck): Claude Code builds from this spec; each part
has an `install.sh` that is `curl | bash`-ed from the target machine and is idempotent.

---

## 1. Facts established (measured 2026-10-19 on a live hotel box)

Hotel box "timeout": Intel Celeron 3965U (Kaby Lake, 2 cores, HD Graphics 610),
7.7 GB RAM, Ubuntu 20.04.6, headless, already running ~30 `ristreceiver` processes
(~55 % CPU baseline, load avg ~1.7–2.0). `/dev/dri/renderD128` present.

Hardware encode works: `intel-media-va-driver-non-free` (iHD 20.1.1) exposes
`VAProfileH264Main/High : VAEntrypointEncSlice`. Distro ffmpeg 4.2 has `h264_vaapi`.

Measured, with rist running (2 cores = 200 %):

| Component | CPU |
|---|---|
| ristreceiver baseline | ~55 % |
| Chrome 155 in Xvfb, 1080p page with ticker + clock, **no video element** | ~45 % |
| Same page **with** an HTML `<video>` element (software decode + compositing) | ~105 % (too much) |
| Xvfb | 2–6 % |
| ffmpeg x11grab → CPU `format=nv12` → `h264_vaapi` | ~68 % |
| ffmpeg x11grab → `hwupload,scale_vaapi=format=nv12` → `h264_vaapi` (GPU convert) | ~26 % |
| Synthetic 1080p30 `h264_vaapi` encode alone | 92 fps, 3.07× realtime, ~27 % of one core |

**Decision 2026-10-28 (Richard): the player must not depend on GPU access.** Second box
"worthingcourt" (same Celeron 3965U, load ~1.5 before the test) measured CPU-only:

| CPU-only, `mpeg2video` | CPU |
|---|---|
| Synthetic 1080p30 MPEG-2 12 Mb/s encode | 61 % of one core (2.2× realtime) |
| Synthetic 720p30 MPEG-2 8 Mb/s encode | 26 % of one core |
| **Realtime 720p: x11grab + mpeg2video + TS → UDP, Chrome slate with 30 fps ticker, rist running** | **ffmpeg 34–42 %, Chrome ~15 %, Xvfb 3–6 %; box 34–51 % idle** |
| **Realtime 1080p, same test, 12 Mb/s video + MP2 audio** | **ffmpeg 73–80 %, Chrome ~12 %, Xvfb ~7 %; box 26–32 % idle** |

**Verified on the bench 2026-10-28:** player → UDP multicast → modulator → LG TV, slate on
screen. At 1080p the ticker judders (ffmpeg at ~110 % on the bench box); at 720p it is smooth.
So the production design is **CPU-only MPEG-2 video + MP2 audio, 720p by default** (~60 % of
the box's 200 %, no driver, no custom ffmpeg); 1080p (~95 %) is a config option for a box with
headroom, and `h264` via libx264 / `aac` stay config options for sites that need them. The earlier
VAAPI measurements stay here as the record of why the GPU path was dropped.

These numbers drive the architecture below. **Rules:**

1. Video never plays inside the browser (software decode + compositing in Chrome measured
   ~60 % on its own). Chrome renders graphics only; ffmpeg decodes video clips (CPU, the
   server pre-normalises them to 720p MPEG-2/H.264 so decode is cheap) and overlays them
   with the software `overlay` filter. The CPU cost of that overlay path is unmeasured —
   measure it on a hotel box before step 5 is designed.
2. No GPU, VAAPI or custom ffmpeg dependency anywhere in the player; the distro ffmpeg is
   enough (`mpeg2video`, `libx264`, `x11grab`, `overlay`).
3. Output is 1280×720 by default; layouts are authored at 1920×1080 and the renderer scales
   the page (CSS zoom) to the player's resolution.
4. Layout CSS animations run at 30 fps (`steps()` or 30 fps keyframe cadence) — 60 fps
   repaints roughly double Chrome's cost for no benefit on a 30 fps channel. The slate's
   ticker is the reference (`steps(N)` with N = seconds × 30).
5. Chrome is managed by PID, never `pkill -f`; a second `google-chrome` invocation
   hands its URL to the running instance and exits ("Opening in existing browser
   session") — this fooled the tests. Launch with a dedicated `--user-data-dir`.
6. ffmpeg always runs with `-y`; the `Overwrite? [y/N]` prompt looks like a hang.
7. Chrome flags that worked: `--no-sandbox --kiosk --window-size=1920,1080
   --window-position=0,0 --no-first-run --disable-gpu --disable-dev-shm-usage
   --autoplay-policy=no-user-gesture-required`. GStreamer `wpesrc` was rejected:
   Ubuntu 20.04's GStreamer 1.16 is too old for reliable headless use.

Packages the player installer must handle (confirmed): `xvfb ffmpeg`, Google Chrome stable from
`https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb` (the Ubuntu
`chromium-browser` package is a snap stub — do not use it).

---

## 2. Player (`player/`)

Language: Python 3 (already on the boxes), single daemon `inhousechannel-player`
under systemd, config in `/etc/inhousechannel/player.conf` (INI). No Docker.

### 2.1 Config

```
[server]
url        = https://signage.example.com      ; content server base URL
player_key = ...                              ; issued by the server per player

[output]
address    = 239.1.1.10                        ; UDP multicast (unicast allowed)
port       = 1234
ttl        = 4
interface  = (optional source interface)
resolution = 1280x720                          ; default; 1920x1080 for a box with headroom
fps        = 30
video_codec = mpeg2                            ; or h264 (libx264)
video_bitrate_kbps = 8000                      ; MPEG-2 CBR (12000 at 1080p)
audio_codec = mp2                              ; or aac
audio_bitrate_kbps = 192
mux_rate_kbps      = 10000                     ; CBR TS for modulators (14000 at 1080p)
service_name = In-House
service_id   = 1
pmt_pid = 4096 ; video_pid = 256 ; audio_pid = 257
```

### 2.2 Pipeline (per player, one channel)

```
                ┌───────────────┐   X11 (RGB)   ┌─────────────────────────────┐
  layout HTML → │ Chrome + Xvfb │ ─────────────▶│ ffmpeg (CPU only)            │
  (local files) │ 1280×720      │               │ x11grab → yuv420p            │
                └───────────────┘               │ clip.mp4 → decode ────┐      │
                                                │ overlay ◀─────────────┘      │ ─▶ UDP TS
                ┌───────────────┐               │ audio: silent / music / clip │
                │ sync + sched  │ ─ controls ─▶ │ mpeg2video + mp2 → mpegts    │
                └───────────────┘               └─────────────────────────────┘
```

- **Renderer**: Xvfb on a private display + Chrome kiosk loading
  `http://127.0.0.1:<port>/render/<layout>` served by the daemon's own small HTTP
  server from the local content cache. The page runs the layout and its widgets
  (clock, ticker, weather, RSS, images, slideshow regions) entirely client-side with
  cached assets; it must keep rendering with the WAN down.
- **Video regions**: the layout marks at most one video region (x, y, w, h); the page
  leaves it transparent/black. The daemon drives ffmpeg to decode the region's clip
  playlist (concat demuxer, looped) and the software `overlay` filter at that position. Clips are pre-normalised by the server (§3.4) so
  the player never transcodes.
- **Audio**: from ffmpeg, never captured from Chrome. Modes: silent MP2 (default —
  an audio PID must always exist, modulators and STBs expect one), background music
  playlist, or the video clips' own audio.
- **Continuity**: the TS must not stop when layouts change. Design the ffmpeg graph so
  a layout change with the same video-region geometry does not restart ffmpeg (Chrome
  simply navigates). When a restart is unavoidable (geometry change, fps/resolution
  change, crash), the daemon restarts within one GOP and the gap must be < 2 s. Log
  every restart with the reason.
- **Watchdog**: the daemon supervises Xvfb, Chrome and ffmpeg; restarts any that die;
  if the layout render fails it shows a built-in fallback slate (hotel logo + clock)
  rather than going black.
- **Sync**: poll the server every 60 s (`If-None-Match`); download changed media to
  `/var/lib/inhousechannel/cache/` atomically; verify SHA-256; evict unreferenced
  files after 7 days. Playback follows the server's schedule, evaluated locally with
  the box clock (NTP assumed), so the player keeps correct scheduling offline.
- **Status**: POST heartbeat every 60 s: version, uptime, layout playing, CPU %, GPU
  encode fps, TS bitrate, restarts in last hour, cache size, last sync time. Include a
  1-frame JPEG thumbnail of the X display every 5 min so the admin UI can show
  "now playing".
- **Local control**: `inhousechannel-player status|restart|preview` CLI; `preview`
  writes a PNG of the current frame.

### 2.3 `player/install.sh`

Idempotent, Ubuntu 20.04/22.04/24.04, run as root:
apt packages → ffmpeg check (`mpeg2video` encoder + `x11grab`) → Chrome .deb → Python
venv in `/opt/inhousechannel/player` → prompts (or env vars) for server URL and
player key → writes conf → enables and starts the systemd unit → runs a 10 s
self-test encode and prints measured fps and CPU.

---

## 3. Content server (`server/`)

**Stack = codenameduck's, verified 2026-10-19 from its repo** (public:
`https://github.com/caritechsolutions/codenameduck`, clone it read-only for reference):
Node.js 20 + Express + better-sqlite3 + ws on the server; admin UI = Vite + React served by
Node under `/admin`; forward-only SQL migrations; bcryptjs sessions in an HttpOnly cookie.
Reuse, by copying into this repo (not by depending on codenameduck):

- `shared/layout-model.js` (schema-2 layout JSON: `canvas`, `pages`, `zones` with
  `{id,type,x,y,w,h,style,…}`), `shared/zone-draw.js` + `shared/zones.css` (the one drawing
  implementation used by both the editor preview and the on-screen renderer),
  `shared/fonts.json` + the OFL `.woff2` fonts, `shared/layout-templates.json`.
- `admin/src/editor/*` (CanvasEditor, ZonePanel, Palette, PageNavigator, geometry.js,
  LayoutPreview) and `admin/src/components/MediaPicker.jsx`, `server/src/media.js`
  (magic-byte typing, sharp thumbnails), `server/src/auth.js`, `server/src/tenants.js`
  (tenant from `Host` header), `server/src/weather.js` (Open-Meteo).

Signage differences from coopcentric, applied when copying: no TV/remote-control concepts
(drop `channel_list`, `menu`, `button`, `apps`, `app_launcher`, `banner`, `digits`, `popup`,
keys, actions, focus); `pages` become timed pages (each page has `duration_s`; the renderer
cycles them — this replaces Playlist for most uses); zone types = `text`, `image`,
`slideshow` (new: images + interval + transition), `video` (new semantics: a clip playlist
region, max one, rendered by ffmpeg — the page draws a transparent hole), `ticker` (new:
scrolling text / RSS, 30 fps stepped), `clock`, `date`, `weather`, `qr` (new), `html`
(iframe URL), `shape`. `shared/zone-types.json` is the single list, as in codenameduck.
The **player's renderer page** is `zone-draw.js` running in Chrome with `env` pointed at the
local cache — the same code the editor preview runs.

Runs as a systemd service on its own Ubuntu 24.04 VM, plain HTTP on 127.0.0.1:3100, TLS by
Nginx Proxy Manager. **One hostname for everything: `signage.caritech.net`** (decided
2026-10-28 — not one hostname per hotel). Access is by assignment, not by hostname: Richard is
the superadmin; every other user sees only the **sites** (hotels) they are a member of, and
within them only the players (screens), layouts and media of those sites.

### 3.1 Entities

- **Site** (hotel): name, slug, logo, timezone. Every player, layout and media item belongs
  to exactly one site.
- **User**: email, password (bcryptjs like codenameduck), `is_superadmin`; **memberships**
  = (user, site, role `admin` | `editor`). A superadmin sees everything and manages sites,
  users and memberships; a site admin manages users within the site; an editor edits layouts,
  media and schedules of the site. A user with no membership sees an empty dashboard.
- **Media**: images (png/jpg/svg/webp), videos (any input → normalised, §3.4), audio
  (mp3/aac → normalised AAC), fonts. Stored under `/var/lib/inhousechannel/media/<site>/`.
- **Layout**: codenameduck schema-2 JSON (see above) restricted to the signage zone types;
  canvas 1920×1080 (720p scales from the same JSON); pages carry `duration_s`.
- **Schedule**: per player — default layout plus dated/time-of-day/day-of-week overrides,
  priority ordered.
- **Player**: belongs to a site; **name is set in the CMS** (e.g. "test modulator"); the CMS
  generates the key and shows a pairing command. On the box:
  `inhousechannel-player pair https://signage.caritech.net <key>` writes `[server]` into the
  conf and restarts the service. Also: output settings mirror (read-only, as the box reports
  them), last heartbeat, thumbnail, version, health.

### 3.2 Layout editor

Copy codenameduck's `admin/src/editor/*` into `admin/src/editor/` and strip the TV-only
panels (actions, key map, focus, screens). Keep: drag/resize with snapping and guides,
multi-select, z-order, per-zone property panel, undo/redo 50, Ctrl-D, page navigator
(now with per-page duration), live preview via the shared drawer, templates, media picker.

### 3.3 Player API (bearer `player_key`)

```
GET  /api/player/manifest      → { schedule, layouts[], media[{id,sha256,size,url}] } with ETag
GET  /api/player/media/:id     → file (Range supported)
GET  /api/player/renderer      → renderer bundle (zone-draw.js, zones.css, fonts) with ETag
POST /api/player/heartbeat     → status JSON (+ optional thumbnail, multipart)
GET  /api/player/time          → server time (sanity check only)
```

### 3.4 Media normalisation

On upload, videos are transcoded server-side with ffmpeg (VM has no GPU; use
`libx264 -preset medium`) to the player's profile so the box only ever hw-decodes:
H.264 High, 1280×720, 30 fps CFR, `-g 60`, 6 Mbps max, AAC 48 kHz stereo, MP4 with
`+faststart` (720p so the player's software decode stays cheap; ffmpeg scales it into the
region anyway). Keep the original. Show progress in the UI; the media is unusable
in layouts until normalised.

### 3.5 `server/install.sh`

Idempotent, Ubuntu 24.04, `curl … | sudo bash` (prompts read `/dev/tty`): Node 20
(NodeSource keyring + apt source, as codenameduck), ffmpeg (distro), clones the repo to
`/opt/inhousechannel/src`, `npm ci` + build of `server/` and `admin/`, creates the
`inhousechannel` system user, data in `/var/lib/inhousechannel/server` (SQLite DB, media,
thumbnails), systemd unit `inhousechannel-server` on 127.0.0.1:3100, first run seeds the
superadmin (`IHC_ADMIN_EMAIL` / `IHC_ADMIN_PASSWORD`, else prompts), prints the NPM proxy
settings to use (host 127.0.0.1:3100, websockets on, no forced HTTPS redirect issues — the
player talks HTTPS through NPM).

---

## 4. Repo layout

```
CLAUDE.md
README.md
server/   package.json, src/ (Express), migrations; install.sh; inhousechannel-server.service
admin/    Vite + React admin UI (editor copied from codenameduck), built to admin/dist
shared/   layout-model.js, zone-draw.js, zones.css, zone-types.json, fonts — used by admin, server and player
player/   player/ (python package), install.sh, inhousechannel-player.service, player.conf.example
docs/     architecture notes; keep §1 numbers here when they are re-measured
```

## 5. Build order

1. Player skeleton: config, Xvfb + Chrome + ffmpeg supervision, static test layout,
   UDP TS out. Verify on the hotel box against the §1 budget before anything else.
2. Player: local renderer HTTP server, sync, schedule evaluation, heartbeat.
3. Server: auth + memberships, sites, players + pairing, media upload + normalisation,
   layouts, schedules, player API (manifest / media / renderer / heartbeat), install.sh.
4. Admin UI: login, dashboard (players with thumbnails), sites/users (superadmin), players,
   media library, layouts with the canvas editor copied from codenameduck, schedules.
   Steps 3 and 4 ship together: the first install must let Richard create "test modulator",
   pair the bench box and publish a layout to it.
5. Video regions (software `overlay`) — measure the decode+overlay cost on a hotel box first.
6. Admin dashboard: player health, thumbnails, schedules.

Every step ends with the player still producing a continuous TS on the test box.

## 6. Conventions

- Commit messages: imperative, one topic each.
- No secrets in the repo; `player.conf.example` and `.env.example` only.
- Scripts are POSIX-ish bash with `set -euo pipefail`; everything logs to journald.
- Keep this file current: when a §1 number is re-measured or a decision changes,
  update it here, not in chat.

---

## Build log

### Step 1 — player skeleton (built 2026-10-19; reworked CPU-only 2026-10-28; awaiting the hotel box)

- `player/inhousechannel/` Python 3.8+ package, stdlib only: `config.py` (INI →
  dataclasses), `pipeline.py` (Xvfb / Chrome / ffmpeg command lines — the ffmpeg graph is the
  measured GPU-convert path), `renderserver.py` (127.0.0.1:8089 serving the active layout
  dir, built-in slate in `assets/slate/` until step 2 syncs real layouts, `/status.json`),
  `supervisor.py` (Proc with stderr tail + per-process backoff; Xvfb death restarts the chain,
  Chrome or ffmpeg death restarts only that process; status to `/run/inhousechannel/status.json`
  every 10 s), `__main__.py` CLI `run|status|preview|selftest|init|ffmpeg-cmd|version`.
- `player/install.sh` (curl | bash), `inhousechannel-player.service` (runs as root for now),
  `player.conf.example`, `/usr/local/bin/inhousechannel-player`. Distro ffmpeg only.
- Tested end-to-end in the dev container (Xvfb + Chromium + ffmpeg 6.1 → UDP → captured
  with ffprobe: MPEG-2 Main 30 fps PID 0x100 + audio 0x101, decoded frame shows the slate;
  re-tested at 1080p/MP2 after the defaults changed). Note: capturing with `ffmpeg -c copy` rewrites the SDT, so check
  service names on the live stream, not a re-muxed file.
- `install.sh` was run in the dev container (Ubuntu 24.04) up to the systemd step with a
  stubbed Chrome (the container's proxy blocks dl.google.com); the installed tree under
  `/opt/inhousechannel` then ran the player as the unit does. The ffmpeg capability check
  must compare the encoder *name column* (`awk '{print $2}'`), not grep the line.
- Not yet: sync, schedule, heartbeat (step 2); video regions (step 5).
