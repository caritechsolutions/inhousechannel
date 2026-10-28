import React, { useEffect, useRef, useState, useCallback } from 'react';
import { HANDLES, dragRect, resizeRect, guideSnap, zoneLabel, snap, editableZoneIds } from './geometry.js';
import { useMediaUrl } from '../mediaUrl.js';

// 16:9 canvas that draws the *current page's* zones as boxes you can select (shift/ctrl for
// several, or drag a marquee on empty canvas), drag and resize. Snap to an 8 px grid plus smart
// guides to other zones on the page and the canvas (Alt = free). Palette items are dropped onto
// it. Coordinates convert between screen pixels and canvas pixels via `scale`.
// Zones of other pages are not drawn.
export default function CanvasEditor({ doc, onChange, selectedIds = [], onSelect, pageId, width = 960, errorsByZone = {}, onDropType }) {
  const canvas = doc.canvas || { w: 1920, h: 1080 };
  const scale = width / canvas.w;
  const height = canvas.h * scale;
  const ref = useRef(null);
  const resolve = useMediaUrl();                 // media:<id> → admin URL for display only
  const [drag, setDrag] = useState(null);       // { ids, primary, mode, start, rects, shift, alt }
  const [ghost, setGhost] = useState(null);      // { [id]: rect } during a drag
  const [guides, setGuides] = useState([]);
  const [marquee, setMarquee] = useState(null);  // { start:{x,y}, cur:{x,y} } canvas px
  const [over, setOver] = useState(false);
  const editable = editableZoneIds(doc, pageId);
  const editableSet = new Set(editable);
  const pageZones = doc.zones.filter((z) => editableSet.has(z.id));
  const isSel = (id) => selectedIds.includes(id);
  const select = (ids) => onSelect(ids.filter((id) => editableSet.has(id)));

  const toCanvas = (e) => { const b = ref.current.getBoundingClientRect(); return { x: (e.clientX - b.left) / scale, y: (e.clientY - b.top) / scale }; };
  const onPointerDown = (e, z, mode) => {
    e.preventDefault(); e.stopPropagation();
    if (!editableSet.has(z.id)) return;
    let ids;
    if (mode === 'move' && (e.shiftKey || e.ctrlKey || e.metaKey)) ids = isSel(z.id) ? selectedIds.filter((i) => i !== z.id) : [...selectedIds, z.id];
    else ids = isSel(z.id) ? selectedIds : [z.id];
    select(ids);
    if (!ids.includes(z.id) || z.locked || !Number.isFinite(e.clientX)) return;
    ref.current.setPointerCapture && ref.current.setPointerCapture(e.pointerId);
    const movable = mode === 'move' ? ids.filter((id) => { const x = doc.zones.find((q) => q.id === id); return x && !x.locked && editableSet.has(id); }) : [z.id];
    const rects = {};
    for (const id of movable) { const x = doc.zones.find((q) => q.id === id); rects[id] = { x: x.x, y: x.y, w: x.w, h: x.h }; }
    setDrag({ ids: movable, primary: z.id, mode, start: { x: e.clientX, y: e.clientY }, rects, shift: e.shiftKey, alt: e.altKey });
    setGhost({ ...rects });
  };
  // Empty canvas: click clears the selection, drag draws a marquee over this page's zones.
  const onCanvasPointerDown = (e) => {
    if (e.target !== e.currentTarget && !(e.target.classList && e.target.classList.contains('grid'))) return;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (!additive) onSelect([]);
    if (!Number.isFinite(e.clientX)) return;
    const p = toCanvas(e);
    setMarquee({ start: p, cur: p, additive });
  };
  const compute = useCallback((e) => {
    if (!drag) return null;
    const dx = (e.clientX - drag.start.x) / scale, dy = (e.clientY - drag.start.y) / scale;
    const free = e.altKey || drag.alt;
    const out = {}; let lines = [];
    if (drag.mode === 'move') {
      const p = drag.rects[drag.primary];
      let pr = dragRect(p, dx, dy, canvas, { free });
      if (!free) { const g = guideSnap(pr, pageZones.filter((z) => !drag.ids.includes(z.id)), canvas); pr = g.rect; lines = g.guides; }
      const ddx = pr.x - p.x, ddy = pr.y - p.y;
      for (const id of drag.ids) { const r = drag.rects[id]; out[id] = id === drag.primary ? pr : dragRect(r, ddx, ddy, canvas, { free: true }); }
    } else {
      const z = doc.zones.find((x) => x.id === drag.primary);
      const r = drag.rects[drag.primary];
      const aspect = e.shiftKey || drag.shift ? r.w / r.h : (z && z.type === 'video' && !free ? 16 / 9 : null);
      out[drag.primary] = resizeRect(r, drag.mode, dx, dy, canvas, { free, aspect });
    }
    return { rects: out, lines };
  }, [drag, scale, canvas, doc.zones, pageId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!drag) return undefined;
    const move = (e) => { const r = compute(e); if (r) { setGhost(r.rects); setGuides(r.lines); } };
    const up = (e) => {
      const moved = Math.abs(e.clientX - drag.start.x) + Math.abs(e.clientY - drag.start.y) >= 3;   // a plain click changes nothing
      const r = moved ? compute(e) : null;
      if (r) {
        const changed = Object.keys(r.rects).some((id) => { const z = doc.zones.find((q) => q.id === id); return z && (z.x !== r.rects[id].x || z.y !== r.rects[id].y || z.w !== r.rects[id].w || z.h !== r.rects[id].h); });
        if (changed) onChange({ ...doc, zones: doc.zones.map((z) => (r.rects[z.id] ? { ...z, ...r.rects[z.id] } : z)) });
      }
      setDrag(null); setGhost(null); setGuides([]);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [drag, compute, doc, onChange]);
  useEffect(() => {
    if (!marquee) return undefined;
    const move = (e) => { if (Number.isFinite(e.clientX)) setMarquee((m) => (m ? { ...m, cur: toCanvas(e) } : m)); };
    const up = (e) => {
      const cur = Number.isFinite(e.clientX) ? toCanvas(e) : marquee.cur;
      const r = rectOf(marquee.start, cur);
      if (r.w * scale + r.h * scale >= 3) {
        const hit = pageZones.filter((z) => !(z.x + z.w < r.x || z.x > r.x + r.w || z.y + z.h < r.y || z.y > r.y + r.h)).map((z) => z.id);
        select(marquee.additive ? [...new Set([...selectedIds, ...hit])] : hit);
      }
      setMarquee(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [marquee, pageZones, selectedIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard: arrows nudge the selection (shift = one grid step) — current page only.
  const onKeyDown = (e) => {
    if (!selectedIds.length) return;
    const step = e.shiftKey ? 8 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    onChange({ ...doc, zones: doc.zones.map((z) => (isSel(z.id) && editableSet.has(z.id) && !z.locked ? { ...z, ...dragRect(z, d[0], d[1], canvas, { free: true }) } : z)) });
  };
  // Palette drop
  const onDrop = (e) => {
    e.preventDefault(); setOver(false);
    const type = e.dataTransfer && e.dataTransfer.getData('text/zone-type');
    if (type && onDropType) { const p = toCanvas(e); onDropType(type, { x: snap(p.x), y: snap(p.y) }); }
  };

  const px = (v) => v * scale;
  const box = (z) => {
    const sel = isSel(z.id);
    const r = ghost && ghost[z.id] ? ghost[z.id] : z;
    const errs = errorsByZone[z.id];
    const st = z.style || {};
    const bg = z.type === 'video' ? undefined : z.type === 'shape' ? (z.fill || st.background) : st.background;
    const radius = z.type === 'shape' ? (z.shape === 'ellipse' ? '50%' : z.radius ? px(z.radius) : undefined) : st.borderRadius ? px(st.borderRadius) : undefined;
    return (
      <div key={z.id} className={`czone t-${z.type}${sel ? ' sel' : ''}${z.locked ? ' locked' : ''}${errs ? ' err' : ''}`}
        style={{ left: px(r.x), top: px(r.y), width: px(r.w), height: px(r.h),
          fontSize: Math.max(9, (st.fontSize || 28) * scale), color: st.color || '#fff',
          fontFamily: st.fontFamily ? `"${st.fontFamily}", sans-serif` : undefined,
          fontStyle: st.fontStyle || undefined, opacity: st.opacity != null ? st.opacity : undefined,
          background: bg || undefined, textAlign: st.align || 'left', borderRadius: radius,
          border: z.type === 'shape' && z.border ? z.border : undefined }}
        onPointerDown={(e) => onPointerDown(e, z, 'move')} data-zone={z.id} data-selected={sel ? '1' : '0'}
        title={`${z.id} (${z.type}) ${z.x},${z.y} ${z.w}×${z.h}${z.locked ? ' · locked' : ''}`}>
        <div className="czone-label"><span className="czone-id">{z.id}</span> {zoneLabel(z)}{z.locked ? ' 🔒' : ''}</div>
        {errs && <div className="czone-err" title={errs.join('\n')} aria-label={`errors on ${z.id}`}>!</div>}
        {z.type === 'video' && <div className="tvglyph">▶ video region (ffmpeg)</div>}
        {z.type === 'text' && <div className="ctext" style={{ fontWeight: st.fontWeight || 'normal' }}>{z.text}</div>}
        {z.type === 'ticker' && <div className="ctext" style={{ whiteSpace: 'nowrap' }}>{(Array.isArray(z.items) && z.items.length ? z.items : [z.text || 'ticker']).join('   •   ')}</div>}
        {z.type === 'clock' && <div className="ctext">{/ss/.test(z.format || '') ? '20:15:30' : /a/.test(z.format || '') ? '08:15 PM' : '20:15'}</div>}
        {z.type === 'date' && <div className="ctext">{/dddd/.test(z.format || 'dddd') ? 'Wednesday 28 October 2026' : '28/10/2026'}</div>}
        {z.type === 'image' && (z.src && !/\{\{/.test(z.src) ? <img src={resolve(z.src)} alt="" draggable={false} style={{ objectFit: z.fit || 'contain' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} /> : <div className="tvglyph">{z.src ? 'logo' : 'image'}</div>)}
        {z.type === 'slideshow' && ((z.images || [])[0] ? <img src={resolve(z.images[0])} alt="" draggable={false} style={{ objectFit: z.fit || 'cover' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} /> : <div className="tvglyph">slideshow</div>)}
        {z.type === 'weather' && <div className="ctext">⛅ 29°{z.units === 'imperial' ? 'F' : 'C'}</div>}
        {z.type === 'qr' && <div className="tvglyph" style={{ color: z.fg || '#000', background: z.bg || '#fff', fontSize: '0.8em' }}>▦ QR</div>}
        {z.type === 'html' && <div className="ctext muted">{z.url || 'web page'}</div>}
        {sel && selectedIds.length === 1 && !z.locked && HANDLES.map((h) => <div key={h} className={`handle h-${h}`} onPointerDown={(e) => onPointerDown(e, z, h)} />)}
      </div>
    );
  };
  const mq = marquee ? rectOf(marquee.start, marquee.cur) : null;
  return (
    <div className="canvas-wrap">
      <div ref={ref} className={'canvas' + (over ? ' drop' : '')} tabIndex={0} onKeyDown={onKeyDown} role="application" aria-label="Layout canvas"
        style={{ width, height, background: canvas.background || '#0b1a2a', backgroundImage: canvas.backgroundImage ? `url(${resolve(canvas.backgroundImage)})` : undefined, backgroundSize: 'cover' }}
        onPointerDown={onCanvasPointerDown}
        onDragOver={(e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('text/zone-type')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!over) setOver(true); } }}
        onDragLeave={() => setOver(false)} onDrop={onDrop}>
        <div className="grid" style={{ backgroundSize: `${px(8 * 5)}px ${px(8 * 5)}px` }} />
        {pageZones.map((z) => box(z))}
        {guides.map((g, i) => <div key={i} className={'guide guide-' + g.axis} style={g.axis === 'x' ? { left: px(g.pos) } : { top: px(g.pos) }} />)}
        {mq && <div className="marquee" data-testid="marquee" style={{ left: px(mq.x), top: px(mq.y), width: px(mq.w), height: px(mq.h) }} />}
        {ghost && drag && ghost[drag.primary] && <div className="coords">{Math.round(ghost[drag.primary].x)}, {Math.round(ghost[drag.primary].y)} · {Math.round(ghost[drag.primary].w)} × {Math.round(ghost[drag.primary].h)}</div>}
      </div>
      <div className="muted small" style={{ marginTop: 6 }}>Drag to move (8 px grid + guides; Alt = free), handles to resize (Shift keeps aspect; the video region keeps 16:9). Shift-click or drag on empty canvas selects several. Arrows nudge, Shift+arrows by 8. Ctrl-D duplicates, Delete removes. Only this page's zones are shown.</div>
    </div>
  );
}
function rectOf(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }; }
