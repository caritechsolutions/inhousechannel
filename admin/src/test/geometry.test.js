import { describe, it, expect } from 'vitest';
import { GRID, snap, clampRect, dragRect, resizeRect, guideSnap, alignZones, distributeZones, newZone, addZone, removeZone, renameZone, toggleZoneInPage, moveZoneOrder, nextZoneId, duplicateZone, errorsByZone, updateZones,
  addPage, renamePage, removePage, duplicatePage, movePage, setPageDuration, isOnPage, editableZoneIds, homePageId, totalCycleSeconds, ensurePages, ZONE_TYPES, PALETTE } from '../editor/geometry.js';
import { validateLayout } from '../layoutSchema.js';

const C = { w: 1920, h: 1080 };
const V2 = (zones, pages) => ({ schema: 2, canvas: C, zones, pages: pages || [{ id: 'page1', name: 'Page 1', zones: zones.map((z) => z.id), duration_s: 15 }] });

describe('geometry', () => {
  it('snaps to the 8 px grid and clamps', () => {
    expect(GRID).toBe(8);
    expect(snap(11)).toBe(8); expect(snap(13)).toBe(16); expect(snap(100)).toBe(104);
    expect(clampRect({ x: -50, y: 1000, w: 300, h: 200 }, C)).toEqual({ x: 0, y: 880, w: 300, h: 200 });
    expect(clampRect({ x: 0, y: 0, w: 5000, h: 10 }, C)).toEqual({ x: 0, y: 0, w: 1920, h: 40 });
  });
  it('drags with snapping and stays on canvas', () => {
    expect(dragRect({ x: 100, y: 100, w: 200, h: 100 }, 13, -7, C)).toEqual({ x: 112, y: 96, w: 200, h: 100 });
    expect(dragRect({ x: 100, y: 100, w: 200, h: 100 }, 13, -7, C, { free: true })).toEqual({ x: 113, y: 93, w: 200, h: 100 });
    expect(dragRect({ x: 1800, y: 0, w: 200, h: 100 }, 500, 0, C).x).toBe(1720);
  });
  it('resizes from each handle keeping the opposite edge', () => {
    const r = { x: 100, y: 100, w: 200, h: 100 };
    expect(resizeRect(r, 'se', 25, 15, C)).toEqual({ x: 100, y: 100, w: 224, h: 112 });
    expect(resizeRect(r, 'nw', 25, 15, C)).toEqual({ x: 128, y: 112, w: 172, h: 88 });
    expect(resizeRect(r, 'e', -500, 0, C)).toEqual({ x: 100, y: 100, w: 40, h: 100 });
    expect(resizeRect(r, 'n', 0, 200, C)).toEqual({ x: 100, y: 160, w: 200, h: 40 });
    const a = resizeRect({ x: 0, y: 0, w: 160, h: 90 }, 'se', 160, 0, C, { aspect: 16 / 9 });
    expect(a).toEqual({ x: 0, y: 0, w: 320, h: 180 });
  });
  it('smart guides snap edges and centres to other zones and the canvas', () => {
    const others = [{ x: 640, y: 120, w: 1200, h: 675 }];
    let g = guideSnap({ x: 336, y: 300, w: 300, h: 100 }, others, C);
    expect(g.rect.x).toBe(340); expect(g.guides).toEqual([{ axis: 'x', pos: 640 }]);
    g = guideSnap({ x: 807, y: 123, w: 300, h: 100 }, others, C);
    expect(g.rect).toEqual({ x: 810, y: 120, w: 300, h: 100 });
    expect(g.guides).toEqual([{ axis: 'x', pos: 960 }, { axis: 'y', pos: 120 }]);
    g = guideSnap({ x: 200, y: 300, w: 300, h: 100 }, others, C);
    expect(g.rect.x).toBe(200); expect(g.guides).toEqual([]);
  });
  it('aligns to the canvas for one zone and to the selection for several; distributes 3+', () => {
    const doc = { canvas: C, zones: [{ id: 'a', type: 'text', x: 100, y: 100, w: 200, h: 100 }, { id: 'b', type: 'text', x: 500, y: 300, w: 100, h: 50 }, { id: 'c', type: 'text', x: 900, y: 50, w: 300, h: 20, locked: true }] };
    expect(alignZones(doc, ['a'], 'right').zones[0].x).toBe(1720);
    expect(alignZones(doc, ['a'], 'center').zones[0].x).toBe(860);
    expect(alignZones(doc, ['a'], 'bottom').zones[0].y).toBe(980);
    let d = alignZones(doc, ['a', 'b'], 'left');
    expect(d.zones.map((z) => z.x)).toEqual([100, 100, 900]);
    d = alignZones(doc, ['a', 'b'], 'middle');
    expect(d.zones.map((z) => z.y)).toEqual([175, 200, 50]);
    d = alignZones(doc, ['a', 'c'], 'top');
    expect(d.zones[2].y).toBe(50);   // locked zones never move
    const three = { canvas: C, zones: [{ id: 'a', x: 0, y: 0, w: 100, h: 10 }, { id: 'b', x: 150, y: 0, w: 100, h: 10 }, { id: 'c', x: 500, y: 0, w: 100, h: 10 }] };
    expect(distributeZones(three, ['a', 'b', 'c'], 'x').zones.map((z) => z.x)).toEqual([0, 250, 500]);
    expect(distributeZones(three, ['a', 'b'], 'x')).toBe(three);
  });
  it('document edits are immutable and keep pages consistent', () => {
    let doc = V2([]);
    const a = addZone(doc, 'text', 'page1');
    expect(a.zone.id).toBe('text'); expect(a.doc.pages[0].zones).toEqual(['text']); expect(doc.zones.length).toBe(0);
    const b = addZone(a.doc, 'text', 'page1');
    expect(b.zone.id).toBe('text2');
    const h = addZone(b.doc, 'html', 'page1');
    expect(h.doc.pages[0].zones).toContain('html');
    doc = renameZone(h.doc, 'text', 'welcome');
    expect(doc.zones[0].id).toBe('welcome'); expect(doc.pages[0].zones[0]).toBe('welcome');
    expect(renameZone(doc, 'welcome', 'text2')).toBe(doc); // collision refused
    doc = toggleZoneInPage(doc, 'page1', 'text2');
    expect(doc.pages[0].zones).toEqual(['welcome', 'html']);
    expect(editableZoneIds(doc, 'page1')).toEqual(['welcome', 'html']);   // text2 is on no page → not drawn there
    doc = moveZoneOrder(doc, 'welcome', 1, 'page1');
    expect(doc.zones.map((z) => z.id)).toEqual(['html', 'text2', 'welcome']);
    doc = moveZoneOrder(doc, 'html', 'front', 'page1');
    expect(doc.zones.map((z) => z.id)).toEqual(['welcome', 'text2', 'html']);
    const d = duplicateZone(doc, ['welcome', 'html'], 'page1');
    expect(d.zones.map((z) => z.id)).toEqual(['text', 'html2']); expect(d.zone.x).toBe(doc.zones[0].x + 16);
    expect(d.doc.pages[0].zones).toEqual(['welcome', 'html', 'text', 'html2']);
    doc = removeZone(d.doc, ['welcome', 'html2']);
    expect(doc.zones.map((z) => z.id)).toEqual(['text2', 'html', 'text']);
    expect(doc.pages[0].zones).toEqual(['html', 'text']);
    expect(nextZoneId({ zones: [{ id: 'clock' }] }, 'clock')).toBe('clock2');
    expect(newZone(doc, 'video')).toMatchObject({ type: 'video', w: 1200, h: 675, playlist: [], loop: true });
    expect(newZone(doc, 'slideshow')).toMatchObject({ type: 'slideshow', images: [], interval_s: 8, fade: true });
    expect(newZone(doc, 'ticker')).toMatchObject({ type: 'ticker', speed: 120 });
    expect(newZone(doc, 'qr')).toMatchObject({ type: 'qr', fg: '#000000', bg: '#ffffff' });
    expect(newZone(doc, 'shape')).toMatchObject({ type: 'shape', shape: 'rect' });
    expect(newZone(doc, 'text', { x: 1000, y: 500 })).toMatchObject({ x: 600, y: 456 });
    expect(updateZones(doc, ['text'], () => ({ locked: true })).zones[2].locked).toBe(true);
  });
  it('the video region is a singleton: not duplicated, shared when a page is duplicated', () => {
    const v = addZone(V2([]), 'video', 'page1');
    expect(duplicateZone(v.doc, ['video'], 'page1').zones).toEqual([]);
    const dp = duplicatePage(v.doc, 'page1');
    expect(dp.page.zones).toEqual(['video']);   // shared, not copied
    expect(dp.doc.zones.length).toBe(1);
    const two = V2([{ id: 'v1', type: 'video', x: 0, y: 0, w: 100, h: 100 }, { id: 'v2', type: 'video', x: 0, y: 0, w: 100, h: 100 }]);
    expect(validateLayout(two).errors.some((e) => /at most one video zone/.test(e))).toBe(true);
  });
  it('pages: add, rename, duration, reorder, duplicate, remove (orphans dropped)', () => {
    let doc = V2([{ id: 'clock', type: 'clock', x: 0, y: 0, w: 100, h: 50 }, { id: 'welcome', type: 'text', x: 0, y: 0, w: 100, h: 50 }]);
    let r = addPage(doc, 'Hotel info', 20);
    doc = r.doc;
    expect(r.page).toEqual({ id: 'hotel-info', name: 'Hotel info', zones: [], duration_s: 20 });
    expect(addPage(doc, 'Hotel info').page.id).toBe('hotel-info-2');
    expect(addPage(doc, 'X').page.duration_s).toBe(15);
    expect(editableZoneIds(doc, 'hotel-info')).toEqual([]);   // nothing is inherited in the signage model
    doc = renamePage(doc, 'hotel-info', 'Info');
    expect(doc.pages[1].name).toBe('Info'); expect(doc.pages[1].id).toBe('hotel-info');
    doc = setPageDuration(doc, 'hotel-info', '7');
    expect(doc.pages[1].duration_s).toBe(7);
    expect(setPageDuration(doc, 'hotel-info', '-3').pages[1].duration_s).toBe(15);   // invalid → default
    expect(totalCycleSeconds(doc)).toBe(22);
    const withText = addZone(doc, 'text', 'hotel-info');
    doc = withText.doc;
    expect(doc.pages[1].zones).toEqual(['text']);
    const dup = duplicatePage(doc, 'hotel-info');
    expect(dup.page).toMatchObject({ id: 'info-copy', zones: ['text2'], duration_s: 7 });
    expect(dup.doc.pages.map((p) => p.id)).toEqual(['page1', 'hotel-info', 'info-copy']);
    doc = movePage(doc, 'hotel-info', 0);
    expect(doc.pages.map((p) => p.id)).toEqual(['hotel-info', 'page1']); expect(homePageId(doc)).toBe('hotel-info');
    doc = removePage(doc, 'hotel-info');
    expect(doc.pages.map((p) => p.id)).toEqual(['page1']);
    expect(doc.zones.map((z) => z.id)).toEqual(['clock', 'welcome']);   // the page's own text is gone
    expect(removePage(doc, 'page1')).toBe(doc);   // the last page stays
    expect(isOnPage(doc, 'page1', 'clock')).toBe(true);
  });
  it('upgrades a coopcentric-style document into timed pages and validates', () => {
    const old = { schema: 2, canvas: C, zones: [{ id: 't', type: 'text', x: 0, y: 0, w: 10, h: 10, action: { type: 'back' } }, { id: 'v', type: 'video', x: 0, y: 0, w: 10, h: 10 }], pages: [{ id: 'home', name: 'Home', zones: ['t'], inherit: true }], home: 'home', keys: {}, focus: {} };
    const d = ensurePages(old);
    expect(d.home).toBeUndefined(); expect(d.keys).toBeUndefined(); expect(d.zones[0].action).toBeUndefined();
    expect(d.pages[0].duration_s).toBe(15);
    expect(d.pages[0].zones).toEqual(['t', 'v']);   // unplaced zones land on the first page
    expect(validateLayout(d).errors).toEqual([]);
    expect(validateLayout({ zones: [{ id: 'm', type: 'menu', x: 0, y: 0, w: 1, h: 1 }] }).errors).toContain('zone "m": unknown type "menu"');
    expect(errorsByZone(['zone "m": unknown type "menu"', 'pages must be an array'])).toEqual({ m: ['zone "m": unknown type "menu"'] });
  });
  it('the palette lists exactly the shared zone types (no TV-only items)', () => {
    const palette = PALETTE.flatMap((g) => g.items.map(([t]) => t)).sort();
    expect(palette).toEqual([...ZONE_TYPES].sort());
    for (const tv of ['menu', 'button', 'channel_list', 'apps', 'app_launcher', 'banner', 'digits', 'popup']) expect(ZONE_TYPES).not.toContain(tv);
  });
});
