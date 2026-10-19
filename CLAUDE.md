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

Total with GPU-side conversion and no in-browser video ≈ 130 % → viable 24/7.
These numbers drive the architecture below. **Rules:**

1. Video never plays inside the browser. Chrome renders graphics only; ffmpeg decodes
   video clips on the iGPU and overlays them.
2. Colour conversion and scaling happen on the GPU (`hwupload` of the RGB grab, then
   `scale_vaapi` / `overlay_vaapi`), never in CPU filters.
3. `overlay_vaapi` needs ffmpeg ≥ 5.0; Ubuntu 20.04 ships 4.2. The player installer
   provides its own ffmpeg (prebuilt binary published as a GitHub Release asset of this
   repo, built with `--enable-vaapi --enable-libdrm --enable-libx264`; fall back to
   building from source if the asset is missing). Installed to
   `/opt/inhousechannel/bin/ffmpeg`; never replaces the system ffmpeg.
4. Layout CSS animations run at 30 fps (`steps()` or 30 fps keyframe cadence) — 60 fps
   repaints roughly double Chrome's cost for no benefit on a 30 fps channel.
5. Chrome is managed by PID, never `pkill -f`; a second `google-chrome` invocation
   hands its URL to the running instance and exits ("Opening in existing browser
   session") — this fooled the tests. Launch with a dedicated `--user-data-dir`.
6. ffmpeg always runs with `-y`; the `Overwrite? [y/N]` prompt looks like a hang.
7. Chrome flags that worked: `--no-sandbox --kiosk --window-size=1920,1080
   --window-position=0,0 --no-first-run --disable-gpu --disable-dev-shm-usage
   --autoplay-policy=no-user-gesture-required`. GStreamer `wpesrc` was rejected:
   Ubuntu 20.04's GStreamer 1.16 is too old for reliable headless use.

Packages the player installer must handle (confirmed): `vainfo
intel-media-va-driver-non-free xvfb`, Google Chrome stable from
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
resolution = 1920x1080                         ; or 1280x720
fps        = 30
video_bitrate_kbps = 6000
mux_rate_kbps      = 7000                      ; CBR TS for modulators
service_name = In-House
service_id   = 1
pmt_pid = 4096 ; video_pid = 256 ; audio_pid = 257
```

### 2.2 Pipeline (per player, one channel)

```
                ┌───────────────┐   X11 (RGB)   ┌─────────────────────────────┐
  layout HTML → │ Chrome + Xvfb │ ─────────────▶│ ffmpeg                       │
  (local files) │ 1920×1080     │               │ x11grab → hwupload           │
                └───────────────┘               │ clip.mp4 → hw decode ─┐      │
                                                │ overlay_vaapi ◀───────┘      │ ─▶ UDP TS
                ┌───────────────┐               │ audio: silent / music / clip │
                │ sync + sched  │ ─ controls ─▶ │ h264_vaapi + aac → mpegts    │
                └───────────────┘               └─────────────────────────────┘
```

- **Renderer**: Xvfb on a private display + Chrome kiosk loading
  `http://127.0.0.1:<port>/render/<layout>` served by the daemon's own small HTTP
  server from the local content cache. The page runs the layout and its widgets
  (clock, ticker, weather, RSS, images, slideshow regions) entirely client-side with
  cached assets; it must keep rendering with the WAN down.
- **Video regions**: the layout marks at most one video region (x, y, w, h); the page
  leaves it transparent/black. The daemon drives ffmpeg to decode the region's clip
  playlist (concat demuxer, looped) with `h264_vaapi`/`hevc_vaapi` hw decode and
  `overlay_vaapi` at that position. Clips are pre-normalised by the server (§3.4) so
  the player never transcodes.
- **Audio**: from ffmpeg, never captured from Chrome. Modes: silent AAC (default —
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
apt packages → VAAPI check (`vainfo` must list `VAEntrypointEncSlice`; abort with a clear
message otherwise) → Chrome .deb → own ffmpeg to `/opt/inhousechannel/bin` → Python
venv in `/opt/inhousechannel/player` → prompts (or env vars) for server URL and
player key → writes conf → enables and starts the systemd unit → runs a 10 s
self-test encode and prints measured fps and CPU.

---

## 3. Content server (`server/`)

Node.js 20 + Express + SQLite (file DB, nightly backup copy); static admin UI in
plain HTML/JS (no build step) — match codenameduck's conventions where sensible.
Runs as a systemd service on its own Ubuntu VM, plain HTTP on an internal port,
TLS terminated by Nginx Proxy Manager. Multi-tenant: one **site** per hotel; a site
is reached at its own hostname (e.g. `nothingbox.signage.caritech.net`); a super-admin
hostname manages sites.

### 3.1 Entities

- **Site** (tenant): name, hostname, logo, timezone, users.
- **User**: email, password (argon2), role: `superadmin` | `site-admin` | `editor`.
- **Media**: images (png/jpg/svg/webp), videos (any input → normalised, §3.4), audio
  (mp3/aac → normalised AAC), fonts. Stored under `/var/lib/inhousechannel/media/<site>/`.
- **Layout**: canvas 1920×1080 (720p layouts scale from the same JSON); JSON document of
  regions; each region is one widget type: image, slideshow, video (max one per layout),
  text, ticker/RSS, clock, date, weather, QR code, web page (iframe URL), shape. Exported
  as self-contained HTML + assets for the player's renderer.
- **Playlist**: ordered list of layouts with durations (used where a channel cycles
  between layouts).
- **Schedule**: per player — default playlist plus dated/time-of-day/day-of-week
  overrides, priority ordered.
- **Player**: belongs to a site; name, key, output settings mirror (read-only display
  of what the box reports), last heartbeat, thumbnail, version, health.

### 3.2 Layout editor

Start from the layout editor built in codenameduck (coopcentric); copy it into
`server/public/editor/` and adapt. Required: drag/resize regions on a 16:9 canvas with
snapping, z-order, per-widget property panel, live preview that runs the real widget
code, undo/redo, duplicate layout, template gallery. The editor's output format is the
layout JSON in §3.1 — the same JSON drives the preview and the player, so what the
editor shows is what the channel shows.

### 3.3 Player API (bearer `player_key`)

```
GET  /api/player/manifest      → { schedule, layouts[], media[{id,sha256,size,url}] } with ETag
GET  /api/player/media/:id     → file (Range supported)
GET  /api/player/layout/:id    → rendered HTML bundle (zip) for the local renderer
POST /api/player/heartbeat     → status JSON (+ optional thumbnail, multipart)
GET  /api/player/time          → server time (sanity check only)
```

### 3.4 Media normalisation

On upload, videos are transcoded server-side with ffmpeg (VM has no GPU; use
`libx264 -preset medium`) to the player's profile so the box only ever hw-decodes:
H.264 High, ≤ 1920×1080, 30 fps CFR, `-g 60`, 8 Mbps max, AAC 48 kHz stereo, MP4
with `+faststart`. Keep the original. Show progress in the UI; the media is unusable
in layouts until normalised.

### 3.5 `server/install.sh`

Idempotent, Ubuntu 22.04/24.04: Node 20 (NodeSource), ffmpeg (distro is fine on the
server), creates `inhousechannel` system user, `/opt/inhousechannel/server`,
`/var/lib/inhousechannel`, systemd unit, first-run creates the superadmin from env or
prompt, prints the internal port to proxy.

---

## 4. Repo layout

```
CLAUDE.md
README.md
server/   package.json, src/, public/ (admin UI, editor), install.sh, inhousechannel-server.service
player/   player/ (python package), install.sh, inhousechannel-player.service, player.conf.example
tools/    ffmpeg build script for the player binary (Docker-based, outputs the release asset)
docs/     architecture notes; keep §1 numbers here when they are re-measured
```

## 5. Build order

1. Player skeleton: config, Xvfb + Chrome + ffmpeg supervision, static test layout,
   UDP TS out. Verify on the hotel box against the §1 budget before anything else.
2. Player: local renderer HTTP server, sync, schedule evaluation, heartbeat.
3. Server: auth, sites, media upload + normalisation, player registration, manifest API.
4. Editor port from codenameduck + layout export.
5. Video regions (`overlay_vaapi`) + own ffmpeg build + release pipeline.
6. Admin dashboard: player health, thumbnails, schedules.

Every step ends with the player still producing a continuous TS on the test box.

## 6. Conventions

- Commit messages: imperative, one topic each.
- No secrets in the repo; `player.conf.example` and `.env.example` only.
- Scripts are POSIX-ish bash with `set -euo pipefail`; everything logs to journald.
- Keep this file current: when a §1 number is re-measured or a decision changes,
  update it here, not in chat.
