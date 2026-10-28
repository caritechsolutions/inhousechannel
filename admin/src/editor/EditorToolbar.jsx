import React from 'react';
import { alignZones, distributeZones, moveZoneOrder, zoneOrderIndex, updateZones, duplicateZone, removeZone, SINGLETON_TYPES } from './geometry.js';

// Toolbar above the canvas: undo/redo, alignment, distribute, z-order, lock, duplicate, delete.
// Everything acts on the current selection.
export default function EditorToolbar({ doc, selectedIds, onChange, onSelect, pageId, canUndo, canRedo, onUndo, onRedo }) {
  const sel = doc.zones.filter((z) => selectedIds.includes(z.id));
  const n = sel.length;
  const one = n === 1 ? sel[0] : null;
  const anyLocked = sel.some((z) => z.locked);
  const dupable = sel.some((z) => !SINGLETON_TYPES.includes(z.type));
  const B = ({ label, title, on, disabled, active }) => <button className={'sm tb' + (active ? ' active' : '')} title={title} aria-label={title} onClick={on} disabled={disabled}>{label}</button>;
  const align = (how) => onChange(alignZones(doc, selectedIds, how));
  const order = (dir) => { if (one) onChange(moveZoneOrder(doc, one.id, dir, pageId)); };
  const oi = one ? zoneOrderIndex(doc, one.id, pageId) : { index: -1, count: 0 };
  const idx = oi.index, last = oi.count - 1;
  return (
    <div className="etoolbar" role="toolbar" aria-label="Editor toolbar">
      <div className="tb-group">
        <B label="↶" title="Undo (Ctrl+Z)" on={onUndo} disabled={!canUndo} />
        <B label="↷" title="Redo (Ctrl+Shift+Z)" on={onRedo} disabled={!canRedo} />
      </div>
      <div className="tb-group">
        <B label="⇤" title={n > 1 ? 'Align left edges' : 'Align to canvas left'} on={() => align('left')} disabled={!n} />
        <B label="⇹" title={n > 1 ? 'Align horizontal centres' : 'Centre horizontally on canvas'} on={() => align('center')} disabled={!n} />
        <B label="⇥" title={n > 1 ? 'Align right edges' : 'Align to canvas right'} on={() => align('right')} disabled={!n} />
        <B label="⤒" title={n > 1 ? 'Align top edges' : 'Align to canvas top'} on={() => align('top')} disabled={!n} />
        <B label="⇳" title={n > 1 ? 'Align vertical middles' : 'Centre vertically on canvas'} on={() => align('middle')} disabled={!n} />
        <B label="⤓" title={n > 1 ? 'Align bottom edges' : 'Align to canvas bottom'} on={() => align('bottom')} disabled={!n} />
      </div>
      <div className="tb-group">
        <B label="⫶" title="Distribute horizontally (3+)" on={() => onChange(distributeZones(doc, selectedIds, 'x'))} disabled={n < 3} />
        <B label="⫼" title="Distribute vertically (3+)" on={() => onChange(distributeZones(doc, selectedIds, 'y'))} disabled={n < 3} />
      </div>
      <div className="tb-group">
        <B label="⇈" title="Bring to front" on={() => order('front')} disabled={!one || idx === last} />
        <B label="↥" title="Bring forward" on={() => order(1)} disabled={!one || idx === last} />
        <B label="↧" title="Send backward" on={() => order(-1)} disabled={!one || idx === 0} />
        <B label="⇊" title="Send to back" on={() => order('back')} disabled={!one || idx === 0} />
      </div>
      <div className="tb-group">
        <B label={anyLocked ? '🔓' : '🔒'} title={anyLocked ? 'Unlock' : 'Lock (no move/resize)'} active={anyLocked} on={() => onChange(updateZones(doc, selectedIds, () => ({ locked: anyLocked ? undefined : true })))} disabled={!n} />
      </div>
      <div className="tb-group">
        <B label="⧉" title="Duplicate (Ctrl+D)" on={() => { const r = duplicateZone(doc, selectedIds, pageId); onChange(r.doc); onSelect(r.zones.map((z) => z.id)); }} disabled={!dupable} />
        <button className="sm tb danger" title="Delete (Del)" aria-label="Delete (Del)" onClick={() => { onChange(removeZone(doc, selectedIds)); onSelect([]); }} disabled={!n}>✕</button>
      </div>
      <span className="muted small" style={{ marginLeft: 'auto' }}>{n === 0 ? 'Nothing selected' : n === 1 ? `${one.id} · ${one.type} · ${one.x},${one.y} ${one.w}×${one.h}` : `${n} selected`}</span>
    </div>
  );
}
