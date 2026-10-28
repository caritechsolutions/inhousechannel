Files shared by server/, admin/ and the player's renderer page — one source of truth.

- `zone-types.json` — every layout zone type. The renderer registers a drawer per type, the
  server validator accepts exactly this list, and the admin editor/palette reads it too.
- `layout-model.js` — the schema-2 document model (timed pages, zones), upgrade + page validation.
- `zone-draw.js` — the zone drawers (text/image/slideshow/video/ticker/clock/date/weather/qr/
  html/shape), `renderStage`, `runPages`, `tick`. `zones.css` is the matching stylesheet.
- `qr.js` — import-free QR encoder used by the `qr` drawer.
- `fonts.json` + `fonts/` — bundled OFL fonts; `fonts/fonts.css` declares the @font-face rules.
- `layout-templates.json` — starter layouts for "New layout from template".

All `.js` files are import-free or import only each other; the server loads layout-model.js and
qr.js through `server/src/esm.js`, and ships the whole directory to players as the renderer zip.
