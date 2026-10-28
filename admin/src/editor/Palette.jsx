import React from 'react';
import { PALETTE, SINGLETON_TYPES } from './geometry.js';

const GLYPH = { video: '▶', text: 'T', ticker: '⇠', image: '▨', slideshow: '▧', shape: '▭', clock: '◷', date: '▦', weather: '☀', qr: '▩', html: '</>' };

// Left-hand zone palette: click adds at the default spot, drag onto the canvas adds where dropped.
export default function Palette({ onAdd, doc }) {
  const has = (type) => !!(doc && (doc.zones || []).some((z) => z.type === type));
  return (
    <div className="palette" aria-label="Zone palette">
      {PALETTE.map((g) => (
        <div key={g.group} className="pal-group">
          <div className="pal-title">{g.group}</div>
          {g.items.map(([type, label]) => {
            const disabled = SINGLETON_TYPES.includes(type) && has(type);
            return (
              <div key={type} className={'pal-item' + (disabled ? ' disabled' : '')} draggable={!disabled} role="button" tabIndex={0} aria-label={`add ${label}`} aria-disabled={disabled || undefined} data-type={type}
                title={disabled ? 'A layout has at most one video region' : undefined}
                onClick={() => !disabled && onAdd(type)} onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onAdd(type); } }}
                onDragStart={(e) => { if (disabled) { e.preventDefault(); return; } e.dataTransfer.setData('text/zone-type', type); e.dataTransfer.effectAllowed = 'copy'; }}>
                <span className="pal-glyph" aria-hidden>{GLYPH[type] || '▢'}</span><span>{label}</span>
              </div>);
          })}
        </div>))}
      <div className="muted small" style={{ padding: '6px 8px' }}>Click to add, or drag onto the canvas.</div>
    </div>
  );
}
