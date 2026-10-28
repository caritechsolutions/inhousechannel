// Minimal QR code encoder (byte mode, versions 1–10, EC level L or M) for the `qr` zone. No
// network, no dependency; ES2015-safe, import-free so server tests can load it like
// layout-model.js. Returns a boolean matrix (true = dark). Follows ISO 18004 (same structure
// as Nayuki's qrcodegen); texts longer than version 10 carries (~270 bytes at L) return null.

// [ecCodewordsPerBlock, blocksG1, dataPerBlockG1, blocksG2, dataPerBlockG2] by version 1..10
var RS = {
  L: [null, [7, 1, 19], [10, 1, 34], [15, 1, 55], [20, 1, 80], [26, 1, 108], [18, 2, 68], [20, 2, 78], [24, 2, 97], [30, 2, 116], [18, 2, 68, 2, 69]],
  M: [null, [10, 1, 16], [16, 1, 28], [26, 1, 44], [18, 2, 32], [24, 2, 43], [16, 4, 27], [18, 4, 31], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]]
};
var ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
var EC_BITS = { L: 1, M: 0 };

var EXP = [], LOG = [];
(function () { var x = 1; for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255]; })();
function gmul(a, b) { return a && b ? EXP[LOG[a] + LOG[b]] : 0; }
function rsGenerator(n) {
  var g = [1];
  for (var i = 0; i < n; i++) {
    var ng = new Array(g.length + 1).fill(0);
    for (var j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= gmul(g[j], EXP[i]); }
    g = ng;
  }
  return g;
}
function rsRemainder(data, gen) {
  var res = new Array(gen.length - 1).fill(0);
  for (var i = 0; i < data.length; i++) {
    var f = data[i] ^ res.shift(); res.push(0);
    for (var j = 0; j < res.length; j++) res[j] ^= gmul(gen[j + 1], f);
  }
  return res;
}

function utf8(str) {
  var s = unescape(encodeURIComponent(String(str))), out = [];
  for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  return out;
}
function dataCapacity(spec) { return spec[1] * spec[2] + (spec[3] ? spec[3] * spec[4] : 0); }

// Encode bytes → codewords for a version (mode 0100, count, data, terminator, pad).
function codewords(bytes, ver, spec) {
  var cap = dataCapacity(spec), bits = [];
  function put(v, n) { for (var i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); }
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16);
  bytes.forEach(function (b) { put(b, 8); });
  put(0, Math.min(4, cap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  var out = [];
  for (var i = 0; i < bits.length; i += 8) { var v = 0; for (var j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; out.push(v); }
  for (var p = 0xec; out.length < cap; p ^= 0xec ^ 0x11) out.push(p);
  // split into blocks, append EC, interleave
  var gen = rsGenerator(spec[0]), blocks = [], pos = 0;
  var groups = [[spec[1], spec[2]]]; if (spec[3]) groups.push([spec[3], spec[4]]);
  groups.forEach(function (g) { for (var k = 0; k < g[0]; k++) { var d = out.slice(pos, pos + g[1]); pos += g[1]; blocks.push({ d: d, e: rsRemainder(d, gen) }); } });
  var res = [], maxD = Math.max.apply(null, blocks.map(function (b) { return b.d.length; }));
  for (var i2 = 0; i2 < maxD; i2++) blocks.forEach(function (b) { if (i2 < b.d.length) res.push(b.d[i2]); });
  for (var i3 = 0; i3 < spec[0]; i3++) blocks.forEach(function (b) { res.push(b.e[i3]); });
  return res;
}

function penalty(m, n) {
  var score = 0, dark = 0, r, c, run, prev;
  for (r = 0; r < n; r++) { run = 0; prev = null; for (c = 0; c < n; c++) { if (m[r][c] === prev) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else { prev = m[r][c]; run = 1; } if (m[r][c]) dark++; } }
  for (c = 0; c < n; c++) { run = 0; prev = null; for (r = 0; r < n; r++) { if (m[r][c] === prev) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else { prev = m[r][c]; run = 1; } } }
  for (r = 0; r + 1 < n; r++) for (c = 0; c + 1 < n; c++) { var v = m[r][c]; if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3; }
  var k = Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1;
  return score + Math.max(0, k) * 10;
}

// text, {ecl: 'L'|'M'} → { size, modules: bool[][] } or null when too long.
export function qrEncode(text, opts) {
  var ecl = (opts && opts.ecl) === 'L' ? 'L' : 'M';
  var bytes = utf8(text), ver = 0;
  for (var v = 1; v <= 10; v++) { var hdr = (v < 10 ? 8 : 16) + 4; if (dataCapacity(RS[ecl][v]) * 8 >= bytes.length * 8 + hdr) { ver = v; break; } }
  if (!ver) return null;
  var spec = RS[ecl][ver], n = ver * 4 + 17;
  var mod = [], fn = [];
  for (var r = 0; r < n; r++) { mod.push(new Array(n).fill(false)); fn.push(new Array(n).fill(false)); }
  function set(x, y, d) { mod[y][x] = !!d; fn[y][x] = true; }
  function finder(x, y) { for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) { var xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue; var d = Math.max(Math.abs(dx), Math.abs(dy)); set(xx, yy, d !== 2 && d !== 4); } }
  for (var i = 0; i < n; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  finder(3, 3); finder(n - 4, 3); finder(3, n - 4);
  var al = ALIGN[ver];
  al.forEach(function (ax, ai) { al.forEach(function (ay, bi) {
    if ((ai === 0 && bi === 0) || (ai === 0 && bi === al.length - 1) || (ai === al.length - 1 && bi === 0)) return;
    for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }); });
  function format(mask) {
    var data = (EC_BITS[ecl] << 3) | mask, rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412, b = function (i) { return ((bits >>> i) & 1) === 1; };
    for (var a = 0; a <= 5; a++) set(8, a, b(a));
    set(8, 7, b(6)); set(8, 8, b(7)); set(7, 8, b(8));
    for (var c = 9; c < 15; c++) set(14 - c, 8, b(c));
    for (var d = 0; d < 8; d++) set(n - 1 - d, 8, b(d));
    for (var e = 8; e < 15; e++) set(8, n - 15 + e, b(e));
    set(8, n - 8, true);
  }
  format(0);
  if (ver >= 7) {
    var rem = ver; for (var q = 0; q < 12; q++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    var vb = (ver << 12) | rem;
    for (var t = 0; t < 18; t++) { var col = ((vb >>> t) & 1) === 1, a2 = n - 11 + (t % 3), b2 = Math.floor(t / 3); set(a2, b2, col); set(b2, a2, col); }
  }
  var data = codewords(bytes, ver, spec), bi = 0, total = data.length * 8;
  for (var right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (var vert = 0; vert < n; vert++) for (var j = 0; j < 2; j++) {
      var x = right - j, up = ((right + 1) & 2) === 0, y = up ? n - 1 - vert : vert;
      if (!fn[y][x] && bi < total) { mod[y][x] = ((data[bi >>> 3] >>> (7 - (bi & 7))) & 1) === 1; bi++; }
    }
  }
  var MASKS = [
    function (r, c) { return (r + c) % 2 === 0; }, function (r) { return r % 2 === 0; }, function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; }, function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return (r * c) % 2 + (r * c) % 3 === 0; }, function (r, c) { return ((r * c) % 2 + (r * c) % 3) % 2 === 0; },
    function (r, c) { return ((r + c) % 2 + (r * c) % 3) % 2 === 0; }
  ];
  function apply(mask) { for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (!fn[r][c] && MASKS[mask](r, c)) mod[r][c] = !mod[r][c]; }
  var best = 0, bestScore = Infinity;
  for (var mk = 0; mk < 8; mk++) { apply(mk); format(mk); var s = penalty(mod, n); if (s < bestScore) { bestScore = s; best = mk; } apply(mk); }
  apply(best); format(best);
  return { size: n, version: ver, modules: mod };
}

// SVG markup for a code (dark on light), quiet zone of 2 modules; null-safe (returns '').
export function qrSvg(text, opts) {
  var q = qrEncode(text, opts);
  if (!q) return '';
  var fg = (opts && opts.fg) || '#000', bg = (opts && opts.bg) || '#fff', n = q.size + 4, d = '';
  for (var r = 0; r < q.size; r++) for (var c = 0; c < q.size; c++) if (q.modules[r][c]) d += 'M' + (c + 2) + ' ' + (r + 2) + 'h1v1h-1z';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges"><rect width="' + n + '" height="' + n + '" fill="' + bg + '"/><path d="' + d + '" fill="' + fg + '"/></svg>';
}
