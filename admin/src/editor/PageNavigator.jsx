import React, { useState } from 'react';
import { pagesOf, addPage, renamePage, removePage, duplicatePage, movePage, setPageDuration, totalCycleSeconds, DEFAULT_PAGE_DURATION_S } from './geometry.js';

// Left-hand page navigator: list, add, rename (double-click or ✎), duplicate, delete, drag to
// reorder, per-page duration. The channel cycles the pages in order, each for duration_s.
export default function PageNavigator({ doc, pageId, onSelect, onChange }) {
  const pages = pagesOf(doc);
  const [adding, setAdding] = useState(null);      // string while the add input is open
  const [editing, setEditing] = useState(null);    // { id, name }
  const [dragId, setDragId] = useState(null);
  const [over, setOver] = useState(null);

  const add = () => { if (!adding || !adding.trim()) { setAdding(null); return; } const r = addPage(doc, adding); onChange(r.doc); onSelect(r.page.id); setAdding(null); };
  const commitRename = () => { if (editing) { onChange(renamePage(doc, editing.id, editing.name)); setEditing(null); } };
  const drop = (targetId) => {
    if (!dragId || dragId === targetId) { setDragId(null); setOver(null); return; }
    const to = pages.findIndex((p) => p.id === targetId);
    onChange(movePage(doc, dragId, to));
    setDragId(null); setOver(null);
  };
  return (
    <div className="pagenav" aria-label="Pages">
      <div className="pal-title"><span>Pages</span><button className="sm ghost" onClick={() => setAdding('')} aria-label="Add page" title="Add page">＋</button></div>
      {pages.map((p, i) => (
        <div key={p.id} className={'page-row' + (p.id === pageId ? ' active' : '') + (over === p.id ? ' dragover' : '')} role="button" tabIndex={0} aria-label={`page ${p.name || p.id}`} aria-current={p.id === pageId ? 'page' : undefined}
          draggable onDragStart={(e) => { setDragId(p.id); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/page-id', p.id); } catch { /* jsdom */ } }}
          onDragOver={(e) => { e.preventDefault(); if (over !== p.id) setOver(p.id); }} onDragLeave={() => setOver(null)} onDrop={(e) => { e.preventDefault(); drop(p.id); }} onDragEnd={() => { setDragId(null); setOver(null); }}
          onClick={() => onSelect(p.id)} onKeyDown={(e) => { if (e.key === 'Enter') onSelect(p.id); }} onDoubleClick={() => setEditing({ id: p.id, name: p.name || p.id })}>
          <span className="muted small" style={{ width: 16 }}>{i + 1}</span>
          {editing && editing.id === p.id
            ? <input autoFocus value={editing.name} aria-label="Rename page" onClick={(e) => e.stopPropagation()} onChange={(e) => setEditing({ ...editing, name: e.target.value })} onBlur={commitRename}
                onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditing(null); }} style={{ flex: 1, padding: '2px 6px' }} />
            : <span className="pname" title={p.id}>{p.name || p.id}<small>{p.zones.length}</small></span>}
          <span className="pdur" onClick={(e) => e.stopPropagation()} title="Seconds this page stays on screen">
            <input type="number" min={1} step={1} value={p.duration_s ?? DEFAULT_PAGE_DURATION_S} aria-label={`duration of page ${p.name || p.id} (seconds)`} data-testid={`duration-${p.id}`}
              onChange={(e) => onChange(setPageDuration(doc, p.id, e.target.value))} /><small>s</small>
          </span>
          <span className="pact">
            <button title="Rename" aria-label={`rename page ${p.id}`} onClick={(e) => { e.stopPropagation(); setEditing({ id: p.id, name: p.name || p.id }); }}>✎</button>
            <button title="Duplicate" aria-label={`duplicate page ${p.id}`} onClick={(e) => { e.stopPropagation(); const r = duplicatePage(doc, p.id); onChange(r.doc); if (r.page) onSelect(r.page.id); }}>⧉</button>
            {i > 0 && <button title="Move up" aria-label={`move up ${p.id}`} onClick={(e) => { e.stopPropagation(); onChange(movePage(doc, p.id, i - 1)); }}>↑</button>}
            {i < pages.length - 1 && <button title="Move down" aria-label={`move down ${p.id}`} onClick={(e) => { e.stopPropagation(); onChange(movePage(doc, p.id, i + 1)); }}>↓</button>}
            {pages.length > 1 && <button className="danger" title="Delete page" aria-label={`delete page ${p.id}`} onClick={(e) => { e.stopPropagation(); const next = removePage(doc, p.id); onChange(next); if (pageId === p.id) onSelect(next.pages[0].id); }}>✕</button>}
          </span>
        </div>))}
      {adding !== null && <div className="inline" style={{ marginTop: 6 }}>
        <input autoFocus value={adding} placeholder="Page name" aria-label="New page name" onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); if (e.key === 'Escape') setAdding(null); }} style={{ flex: 1 }} />
        <button className="sm" disabled={!adding.trim()} onClick={add}>Add</button>
      </div>}
      <div className="muted small" style={{ padding: '6px 4px 0' }}>{pages.length > 1 ? `The channel cycles these ${pages.length} pages in order; one loop = ${totalCycleSeconds(doc)} s. Drag to reorder.` : 'One page stays on screen; add pages to cycle them.'}</div>
    </div>
  );
}
