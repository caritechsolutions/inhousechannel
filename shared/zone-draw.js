// Zone drawing shared by the player's renderer page (Chrome in Xvfb, captured by ffmpeg) and
// the admin's in-editor preview. Plain DOM, no framework, ES2015-safe. Styling lives in
// ./zones.css, which both load. Adapted from codenameduck without the TV concepts (focus,
// actions, menus, channel lists).
//
// A drawer gets (element, zone, ctx, env):
//   ctx  — text variables: site, time, date, plus whatever the server puts in; ctx.__preview
//          marks the editor preview (placeholders instead of empty boxes)
//   env  — mediaUrl(src) → URL to load media from (the player maps media ids to its cache);
//          weather {ok,temp_c,temp_f,text,icon}; units; preview (bool)
// Rule 4 of CLAUDE.md §1: everything that moves (ticker, slideshow fades) is paced at 30 fps
// with CSS `steps()`; nothing uses requestAnimationFrame.

import { visibleZoneList, firstPageId, pageDuration, nextPageId } from './layout-model.js';
import { qrSvg } from './qr.js';

export var FPS = 30;
export var VARIABLES = ['site', 'time', 'date'];

export function substitute(text, ctx) {
  ctx = ctx || {};
  return String(text == null ? '' : text).replace(/\{\{\s*(\w+)\s*\}\}/g, function (_, k) { return ctx[k] == null ? '' : ctx[k]; });
}
export function hasLiveVars(text) { return /\{\{\s*(time|date)\s*\}\}/.test(String(text == null ? '' : text)); }

var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function pad2(n) { return (n < 10 ? '0' : '') + n; }
// Tokens: HH hh mm ss a | dddd ddd D DD MMMM MMM MM YYYY. Literal text in [brackets].
export function formatClock(fmt, d) {
  var h24 = d.getHours(), h12 = h24 % 12 || 12;
  var map = { HH: pad2(h24), hh: pad2(h12), mm: pad2(d.getMinutes()), ss: pad2(d.getSeconds()), a: h24 < 12 ? 'AM' : 'PM',
    dddd: DAYS[d.getDay()], ddd: DAYS[d.getDay()].slice(0, 3), DD: pad2(d.getDate()), D: String(d.getDate()),
    MMMM: MONTHS[d.getMonth()], MMM: MONTHS[d.getMonth()].slice(0, 3), MM: pad2(d.getMonth() + 1), YYYY: String(d.getFullYear()) };
  return String(fmt || 'HH:mm').replace(/\[([^\]]*)\]|dddd|ddd|MMMM|MMM|YYYY|HH|hh|mm|ss|DD|MM|D|a/g, function (m, lit) { return lit !== undefined ? lit : map[m]; });
}
// ctx + the clock-driven variables for "now".
export function liveContext(ctx, now, dateFormat) {
  var d = now || new Date();
  var out = {};
  for (var k in (ctx || {})) out[k] = ctx[k];
  out.time = formatClock('HH:mm', d);
  out.date = formatClock(dateFormat || 'dddd D MMMM YYYY', d);
  return out;
}

export function fontFamilyCss(f) {
  if (!f) return '';
  if (/["',]/.test(f)) return f;
  return '"' + f + '", Helvetica, Arial, sans-serif';
}
export var SHADOWS = { none: '', soft: '0 2px 8px rgba(0,0,0,0.55)', strong: '0 3px 14px rgba(0,0,0,0.9)', outline: '0 0 4px rgba(0,0,0,1), 0 0 4px rgba(0,0,0,1)' };

export function applyStyle(el, st) {
  st = st || {};
  if (st.fontSize) el.style.fontSize = st.fontSize + 'px';
  if (st.color) el.style.color = st.color;
  if (st.background) el.style.background = st.background;
  if (st.fontWeight) el.style.fontWeight = st.fontWeight;
  if (st.fontStyle) el.style.fontStyle = st.fontStyle;
  if (st.fontFamily) el.style.fontFamily = fontFamilyCss(st.fontFamily);
  if (st.align) el.style.textAlign = st.align;
  if (st.valign) el.style.justifyContent = st.valign === 'middle' ? 'center' : st.valign === 'bottom' ? 'flex-end' : 'flex-start';
  if (st.padding != null) el.style.padding = st.padding + 'px';
  if (st.borderRadius != null) el.style.borderRadius = st.borderRadius + 'px';
  if (st.letterSpacing != null) el.style.letterSpacing = st.letterSpacing + 'px';
  if (st.opacity != null) el.style.opacity = st.opacity;
  if (st.lineHeight != null) el.style.lineHeight = st.lineHeight;
  if (st.border) el.style.border = st.border;
  if (st.shadow) { var s = SHADOWS[st.shadow] !== undefined ? SHADOWS[st.shadow] : st.shadow; if (s) el.style.textShadow = s; }
  if (st.boxShadow) el.style.boxShadow = st.boxShadow;
}

export function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); }
export function mediaImg(src, env) {
  var img = document.createElement('img');
  img.src = env && env.mediaUrl ? env.mediaUrl(src) : src; img.alt = '';
  return img;
}
// Zones that start timers keep them here so a redraw can stop them (slideshow).
function stopTimers(e) { if (e.__ihcTimer) { clearInterval(e.__ihcTimer); e.__ihcTimer = null; } }

// ---------------------------------------------------------------- per-type drawers
export function drawText(e, z, ctx) {
  e.textContent = substitute(z.text, ctx);
  if (hasLiveVars(z.text)) e.setAttribute('data-live-text', '1');
  if (z.style && z.style.valign) e.classList.add('zone-flex');
}
export function drawImage(e, z, ctx, env) {
  var src = substitute(z.src || '', ctx);
  if (!src) { if (ctx && ctx.__preview) e.appendChild(el('div', 'zone-placeholder', 'image')); return; }
  var img = mediaImg(src, env); if (z.fit) img.style.objectFit = z.fit; e.appendChild(img);
}
export function drawClock(e, z, ctx) {
  e.setAttribute('data-clock', z.format || 'HH:mm');
  e.textContent = formatClock(z.format || 'HH:mm', (ctx && ctx.__now) || new Date());
  if (z.style && z.style.valign) e.classList.add('zone-flex');
}
export function drawDate(e, z, ctx) {
  var f = z.format || 'dddd D MMMM YYYY';
  e.setAttribute('data-clock', f);
  e.textContent = formatClock(f, (ctx && ctx.__now) || new Date());
  if (z.style && z.style.valign) e.classList.add('zone-flex');
}
// The player composites the clip playlist here with ffmpeg's overlay filter, so the page
// must leave this rectangle untouched: transparent, nothing drawn. The daemon reads
// data-video-region to find the geometry. The editor preview shows a hatched placeholder.
export function drawVideo(e, z, ctx, env) {
  e.style.background = 'transparent';
  e.setAttribute('data-video-region', '1');
  if (env && env.preview) e.appendChild(el('div', 'zone-video-placeholder', 'VIDEO'));
}
// images: [src…], interval_s (default 8), fade (bool, default true), fit. Two stacked <img>s;
// the incoming one fades in over 0.5 s stepped at 30 fps. Timers are cleared on redraw.
export function drawSlideshow(e, z, ctx, env) {
  stopTimers(e);
  var imgs = (z.images || []).map(function (s) { return substitute(s, ctx); }).filter(Boolean);
  e.classList.add('zone-slideshow');
  if (!imgs.length) { if (ctx && ctx.__preview) e.appendChild(el('div', 'zone-placeholder', 'slideshow (no images)')); return; }
  var fit = z.fit || 'cover', fade = z.fade !== false;
  var make = function (src) { var i = mediaImg(src, env); i.className = 'slide' + (fade ? ' fade' : ''); i.style.objectFit = fit; return i; };
  var cur = make(imgs[0]); cur.classList.add('shown'); e.appendChild(cur);
  if (imgs.length < 2 || (ctx && ctx.__preview)) return;
  var idx = 0, interval = Math.max(1, Number(z.interval_s) || 8) * 1000;
  e.__ihcTimer = setInterval(function () {
    idx = (idx + 1) % imgs.length;
    var next = make(imgs[idx]);
    e.appendChild(next);
    // force a style flush so the transition runs from opacity 0
    void next.offsetWidth; // eslint-disable-line no-void
    next.classList.add('shown');
    var old = cur; cur = next;
    setTimeout(function () { if (old.parentNode === e) e.removeChild(old); }, fade ? 600 : 0);
  }, interval);
}
// Scrolling text. text (string) or items [string…] joined with separator (default "   •   ").
// speed in px/s (default 120). One pass = (zone width + text width) / speed seconds, run as a
// CSS animation stepped at FPS so Chrome repaints 30 times a second, not 60.
export function drawTicker(e, z, ctx) {
  e.classList.add('zone-ticker');
  var items = Array.isArray(z.items) && z.items.length ? z.items : [z.text || ''];
  var sep = z.separator != null ? z.separator : '   •   ';
  var text = items.map(function (t) { return substitute(t, ctx); }).filter(Boolean).join(sep);
  if (!text) { if (ctx && ctx.__preview) e.appendChild(el('div', 'zone-placeholder', 'ticker')); return; }
  var span = el('span', 'ticker-text', text);
  e.appendChild(span);
  var speed = Math.max(10, Number(z.speed) || 120), w = z.w || 0;
  var fontSize = (z.style && z.style.fontSize) || 32;
  var apply = function (textW) {
    var dur = (w + textW) / speed, steps = Math.max(1, Math.round(dur * FPS));
    var name = 'tk-' + String(z.id).replace(/[^a-zA-Z0-9_-]/g, '_');
    var st = document.getElementById('kf-' + name);
    if (!st) { st = document.createElement('style'); st.id = 'kf-' + name; document.head.appendChild(st); }
    st.textContent = '@keyframes ' + name + '{from{transform:translateX(' + w + 'px)}to{transform:translateX(-' + textW + 'px)}}';
    span.style.animation = name + ' ' + dur.toFixed(3) + 's steps(' + steps + ') infinite';
    if (ctx && ctx.__preview) span.style.animationPlayState = 'paused';
  };
  // in the DOM the real width is measurable a tick later; before that, estimate from the font
  apply(Math.round(text.length * fontSize * 0.55));
  setTimeout(function () { if (span.offsetWidth) apply(span.offsetWidth); }, 0);
}
export function drawHtml(e, z, ctx) {
  var url = substitute(z.url || '', ctx);
  if (url) {
    var f = document.createElement('iframe');
    f.src = url; f.setAttribute('frameborder', '0'); f.setAttribute('scrolling', 'no'); f.className = 'zone-iframe';
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    e.appendChild(f);
  } else if (z.html) e.innerHTML = substitute(z.html, ctx);
  else if (ctx && ctx.__preview) e.appendChild(el('div', 'zone-placeholder', 'html (no URL)'));
}
export function drawWeather(e, z, ctx, env) {
  e.setAttribute('data-weather', '1');
  clear(e);
  var w = env && env.weather;
  var st = z.style || {};
  if (!w || !w.ok) { e.appendChild(el('span', 'wx-na', ctx && ctx.__preview ? '22°C  ⛅' : '')); return; }
  var imperial = (z.units || (env && env.units)) === 'imperial';
  var wrap = el('div', 'wx');
  wrap.appendChild(el('span', 'wx-icon', w.icon || ''));
  wrap.appendChild(el('span', 'wx-temp', (imperial ? w.temp_f + '°F' : w.temp_c + '°C')));
  if (z.showText !== false) wrap.appendChild(el('span', 'wx-text', w.text || ''));
  if (st.align === 'right') wrap.style.justifyContent = 'flex-end';
  if (st.align === 'center') wrap.style.justifyContent = 'center';
  e.appendChild(wrap);
}
export function drawQr(e, z, ctx) {
  var data = substitute(z.data || z.text || '', ctx);
  e.classList.add('zone-qr');
  if (!data) { if (ctx && ctx.__preview) e.appendChild(el('div', 'zone-placeholder', 'qr')); return; }
  var svg = qrSvg(data, { ecl: z.ecl || 'M', fg: z.fg || (z.style && z.style.color) || '#000000', bg: z.bg || '#ffffff' });
  if (!svg) { e.appendChild(el('div', 'zone-placeholder', 'text too long for QR')); return; }
  e.innerHTML = svg;
  if (z.caption) e.appendChild(el('div', 'qr-caption', substitute(z.caption, ctx)));
}
// shape: rect | ellipse; fill, border ("2px solid #fff"), radius (rect only).
export function drawShape(e, z) {
  e.classList.add('zone-shape');
  e.style.background = z.fill || (z.style && z.style.background) || 'rgba(255,255,255,0.15)';
  if (z.border) e.style.border = z.border;
  if (z.shape === 'ellipse') e.style.borderRadius = '50%';
  else if (z.radius != null) e.style.borderRadius = z.radius + 'px';
}

export var DRAWERS = {
  text: drawText,
  image: drawImage,
  slideshow: drawSlideshow,
  video: drawVideo,
  ticker: drawTicker,
  clock: drawClock,
  date: drawDate,
  weather: drawWeather,
  qr: drawQr,
  html: drawHtml,
  shape: drawShape
};

export function visibleZones(layout, pageId) { return visibleZoneList(layout, pageId); }

// One positioned, styled, drawn .zone element (or null for an unknown type).
export function zoneElement(z, ctx, env) {
  var fn = DRAWERS[z.type];
  if (!fn) return null;
  var e = el('div', 'zone zone-' + z.type);
  e.id = 'zone-' + z.id;
  e.setAttribute('data-zone-id', z.id);
  e.style.left = (z.x || 0) + 'px'; e.style.top = (z.y || 0) + 'px';
  e.style.width = (z.w || 0) + 'px'; e.style.height = (z.h || 0) + 'px';
  applyStyle(e, z.style);
  fn(e, z, ctx, env);
  return e;
}

// Draw one page into `stage` (removes the previous page's .zone children and stops their
// timers). Returns the zone types it could not draw.
export function renderStage(stage, layout, ctx, env, pageId) {
  layout = layout || {};
  var canvas = layout.canvas || {};
  stage.style.background = canvas.background || '#000';
  stage.style.backgroundImage = canvas.backgroundImage ? 'url(' + (env && env.mediaUrl ? env.mediaUrl(canvas.backgroundImage) : canvas.backgroundImage) + ')' : 'none';
  Array.prototype.slice.call(stage.querySelectorAll('.zone')).forEach(function (n) { stopTimers(n); stage.removeChild(n); });
  var skipped = [];
  visibleZones(layout, pageId || firstPageId(layout)).forEach(function (z) {
    var e = zoneElement(z, ctx, env);
    if (!e) { skipped.push(z.type); return; }
    stage.appendChild(e);
  });
  return skipped;
}

// Page cycling: draws the first page now and the next one when its duration elapses. Returns
// a controller {stop(), current()}; onPage(pageId) is called at every change (the player uses
// it to drive the video region). Single-page layouts are drawn once and left alone.
export function runPages(stage, layout, ctx, env, onPage) {
  var pageId = firstPageId(layout), timer = null, stopped = false;
  function show(id) {
    if (stopped) return;
    pageId = id;
    renderStage(stage, layout, ctx, env, id);
    if (onPage) onPage(id);
    var pages = (layout && layout.pages) || [];
    if (pages.length > 1) timer = setTimeout(function () { show(nextPageId(layout, id)); }, pageDuration(pages.filter(function (p) { return p.id === id; })[0]) * 1000);
  }
  show(pageId);
  return { stop: function () { stopped = true; if (timer) clearTimeout(timer); }, current: function () { return pageId; } };
}

// Refresh clocks, dates and {{time}}/{{date}} texts without a full redraw.
export function tick(stage, layout, ctx, now) {
  var d = now || new Date();
  var clocks = stage.querySelectorAll('[data-clock]');
  for (var i = 0; i < clocks.length; i++) clocks[i].textContent = formatClock(clocks[i].getAttribute('data-clock'), d);
  var live = stage.querySelectorAll('[data-live-text]');
  if (!live.length) return;
  var lctx = liveContext(ctx, d);
  for (var j = 0; j < live.length; j++) {
    var id = live[j].getAttribute('data-zone-id');
    var z = ((layout && layout.zones) || []).filter(function (x) { return x.id === id; })[0];
    if (z) live[j].textContent = substitute(z.text, lctx);
  }
}
