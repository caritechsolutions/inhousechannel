import React from 'react';
import { upgradeLayout, pageById, firstPageId } from '../../../shared/layout-model.js';
// Tiny read-only preview of a layout's first page for lists.
export default function LayoutThumb({ doc, width = 160, pageId }) {
  const c = (doc && doc.canvas) || { w: 1920, h: 1080 };
  const k = width / c.w;
  const d = doc ? upgradeLayout(doc) : null;
  const page = d ? pageById(d, pageId) || pageById(d, firstPageId(d)) : null;
  const ids = new Set((page && page.zones) || []);
  return (
    <div className="thumb" style={{ width, background: c.background || '#0b1a2a' }} aria-hidden>
      {((d && d.zones) || []).filter((z) => ids.has(z.id)).map((z) => (
        <div key={z.id} className={`t-${z.type}`} style={{ left: z.x * k, top: z.y * k, width: z.w * k, height: z.h * k,
          background: z.type === 'video' ? undefined : z.type === 'shape' ? (z.fill || 'rgba(255,255,255,.15)') : (z.style && z.style.background) || 'rgba(255,255,255,.08)',
          borderRadius: z.type === 'shape' && z.shape === 'ellipse' ? '50%' : undefined }} />))}
    </div>
  );
}
