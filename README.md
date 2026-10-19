# inhousechannel

Digital signage that plays out as a TV channel. A content server (layout editor,
media library, schedules) and a player that renders layouts on a hotel's existing
Linux box and emits an MPEG-TS over UDP multicast straight into the modulator or
IP decoders — no HDMI encoder.

See `CLAUDE.md` for the full build spec and the measured hardware budget.

- `server/` — content server (Ubuntu VM behind Nginx Proxy Manager)
- `player/` — player daemon for the hotel box (`curl .../player/install.sh | bash`)
- `tools/` — ffmpeg build for the player binary
- `docs/` — architecture notes
