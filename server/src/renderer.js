'use strict';
// The renderer bundle players download: shared/*.js + zones.css + fonts + a generated
// render.html. The player unpacks it next to its layout cache and points Chrome at
// render.html; the page reads ./layout.json (+ optional ./ctx.json) and draws it with the same
// zone-draw.js the editor preview uses. Built once per process; ETag = sha256 of the zip.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { zipBuffer } = require('./zip');
const { SHARED } = require('./layout');

const RENDER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>inhousechannel renderer</title>
<link rel="stylesheet" href="./fonts/fonts.css"><link rel="stylesheet" href="./zones.css">
<style>
html,body{margin:0;padding:0;background:#000;overflow:hidden;width:100%;height:100%;cursor:none}
#stage{position:absolute;left:0;top:0;width:1920px;height:1080px;transform-origin:0 0;overflow:hidden;background:#000}
#msg{position:absolute;left:0;right:0;top:45%;color:#8fb3c9;font:32px Helvetica,Arial,sans-serif;text-align:center}
</style></head>
<body><div id="stage"></div><div id="msg"></div>
<script type="module">
import { runPages, tick, liveContext } from './zone-draw.js';
// ?res=1280x720 scales the 1920x1080 canvas to the output; the player passes its resolution.
// ?layout=<url> and ?ctx=<url> override the default ./layout.json and ./ctx.json.
const q = new URLSearchParams(location.search);
const res = /^(\\d+)x(\\d+)$/.exec(q.get('res') || '') || [0, String(innerWidth), String(innerHeight)];
const stage = document.getElementById('stage');
stage.style.transform = 'scale(' + (Number(res[1]) / 1920) + ',' + (Number(res[2]) / 1080) + ')';
const mediaBase = q.get('media') || './media/';
const env = {
  mediaUrl: (src) => { const m = /^media:(\\d+)$/.exec(String(src || '')); return m ? mediaBase + m[1] : src; },
  weather: null, units: q.get('units') || 'metric', preview: false,
};
let ctx = {};
try { ctx = await (await fetch(q.get('ctx') || './ctx.json', { cache: 'no-store' })).json(); } catch { /* optional */ }
let layout = null;
try { layout = await (await fetch(q.get('layout') || './layout.json', { cache: 'no-store' })).json(); }
catch (e) { document.getElementById('msg').textContent = 'no layout: ' + e.message; }
if (layout) {
  if (ctx.weather) env.weather = ctx.weather;
  const run = runPages(stage, layout, liveContext(ctx), env, (id) => { window.__ihcPage = id; document.title = 'ihc ' + id; });
  window.__ihc = { layout, run, ctx };
  setInterval(() => tick(stage, layout, ctx), 1000);
  // the player polls this to learn where the video region is (transparent hole it composites into)
  window.__ihcVideoRect = () => { const z = (layout.zones || []).find((x) => x.type === 'video'); return z ? { x: z.x, y: z.y, w: z.w, h: z.h } : null; };
}
</script></body></html>
`;

function createRenderer({ sharedDir = SHARED } = {}) {
  let built = null;
  function build() {
    if (built) return built;
    const entries = [];
    for (const f of ['zone-draw.js', 'layout-model.js', 'qr.js', 'zones.css', 'zone-types.json', 'fonts.json']) entries.push({ path: f, data: fs.readFileSync(path.join(sharedDir, f)) });
    for (const f of fs.readdirSync(path.join(sharedDir, 'fonts')).sort()) entries.push({ path: `fonts/${f}`, data: fs.readFileSync(path.join(sharedDir, 'fonts', f)) });
    entries.push({ path: 'render.html', data: RENDER_HTML });
    const zip = zipBuffer(entries);
    built = { zip, etag: `"${crypto.createHash('sha256').update(zip).digest('hex').slice(0, 32)}"`, files: entries.map((e) => e.path) };
    return built;
  }
  return { build, invalidate: () => { built = null; }, RENDER_HTML };
}

module.exports = { createRenderer, RENDER_HTML };
