import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, put } from '../api.js';
import { useAsync, Field, useToast } from '../components/ui.jsx';
import { validateLayoutText, validateLayout } from '../layoutSchema.js';
import CanvasEditor from '../editor/CanvasEditor.jsx';
import ZonePanel from '../editor/ZonePanel.jsx';
import Palette from '../editor/Palette.jsx';
import EditorToolbar from '../editor/EditorToolbar.jsx';
import LayoutPreview from '../editor/LayoutPreview.jsx';
import PageNavigator from '../editor/PageNavigator.jsx';
import { addZone, ensurePages, duplicateZone, removeZone, errorsByZone, pagesOf, homePageId, pageById, editableZoneIds, totalCycleSeconds } from '../editor/geometry.js';
import { useSession, NeedSite } from '../App.jsx';

const HISTORY = 50;

// Layout editor: pages + palette | canvas (or preview / advanced JSON) | property panel.
export default function LayoutEdit() {
  const session = useSession();
  const { id } = useParams();
  if (!session.site) return <><div className="topbar"><h1>Layout</h1></div><NeedSite /></>;
  return <Editor key={`${session.site.id}/${id}`} siteId={session.site.id} site={session.site} id={id} />;
}

export function Editor({ siteId, site, id }) {
  const toast = useToast();
  const layout = useAsync(() => get(`/sites/${siteId}/layouts/${id}`), [siteId, id]);
  const [name, setName] = useState('');
  const [doc, setDoc] = useState(null);           // current document (source of truth, schema 2)
  const [text, setText] = useState('');           // Advanced (JSON) view text
  const [tab, setTab] = useState('canvas');
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [pageId, setPageId] = useState(null);
  const [savedJson, setSavedJson] = useState('');
  const past = useRef([]); const future = useRef([]);
  const [, bump] = useState(0);
  const [canvasWidth, setCanvasWidth] = useState(960);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!layout.data) return;
    const d = ensurePages(layout.data.json);
    setName(layout.data.name); setDoc(d); setText(JSON.stringify(d, null, 2)); setErrors(validateLayout(d).errors);
    setSavedJson(JSON.stringify(d)); setPageId(homePageId(d));
    past.current = []; future.current = []; setSelectedIds([]);
  }, [layout.data]);
  useEffect(() => {
    const el = wrapRef.current; if (!el) return undefined;
    const fit = () => setCanvasWidth(Math.max(420, Math.min(1400, Math.floor(el.clientWidth - 2))));
    fit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    if (ro) ro.observe(el); else window.addEventListener('resize', fit);
    return () => { if (ro) ro.disconnect(); else window.removeEventListener('resize', fit); };
  }, [doc, tab]);
  // keep the selected page valid after deletes / JSON edits
  useEffect(() => { if (doc && !pageById(doc, pageId)) setPageId(homePageId(doc)); }, [doc, pageId]);

  const change = useCallback((next) => {
    setDoc((prev) => { if (prev) { past.current.push(prev); if (past.current.length > HISTORY) past.current.shift(); } return next; });
    future.current = [];
    setText(JSON.stringify(next, null, 2));
    setErrors(validateLayout(next).errors);
    bump((n) => n + 1);
  }, []);
  const undo = () => { const prev = past.current.pop(); if (!prev) return; setDoc((cur) => { future.current.push(cur); return prev; }); setText(JSON.stringify(prev, null, 2)); setErrors(validateLayout(prev).errors); bump((n) => n + 1); };
  const redo = () => { const next = future.current.pop(); if (!next) return; setDoc((cur) => { past.current.push(cur); return next; }); setText(JSON.stringify(next, null, 2)); setErrors(validateLayout(next).errors); bump((n) => n + 1); };
  function onText(v) {
    setText(v);
    const r = validateLayoutText(v);
    setErrors(r.errors);
    if (r.doc) { const d = r.doc; setDoc((prev) => { if (prev) { past.current.push(prev); if (past.current.length > HISTORY) past.current.shift(); } return d; }); future.current = []; bump((n) => n + 1); }
  }
  useEffect(() => {
    const onKey = (e) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undo(); }
      else if (mod && ((e.shiftKey && e.key.toLowerCase() === 'z') || e.key.toLowerCase() === 'y') && !typing) { e.preventDefault(); redo(); }
      else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (dirty && !errors.length) save(); }
      else if (mod && e.key.toLowerCase() === 'd' && tab === 'canvas' && selectedIds.length && !typing) { e.preventDefault(); const r = duplicateZone(doc, selectedIds, pageId); change(r.doc); setSelectedIds(r.zones.map((z) => z.id)); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length && tab === 'canvas' && !typing) { e.preventDefault(); change(removeZone(doc, selectedIds)); setSelectedIds([]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function save() {
    const r = validateLayout(doc);
    if (!r.doc) { setErrors(r.errors); return; }
    setSaving(true);
    try {
      const saved = await put(`/sites/${siteId}/layouts/${id}`, { name, json: doc });
      const d = saved && saved.json ? ensurePages(saved.json) : doc;
      layout.setData(saved && saved.json ? saved : { ...layout.data, name, json: doc });
      setSavedJson(JSON.stringify(d));
      toast('Saved & published — players pick it up on their next sync');
    } catch (e) { setErrors(e.errors || [e.message]); toast(e.message, 'bad'); } finally { setSaving(false); }
  }
  // The selection can only hold zones on the current page.
  useEffect(() => {
    if (!doc || !selectedIds.length) return;
    const ok = new Set(editableZoneIds(doc, pageId));
    if (selectedIds.some((sid) => !ok.has(sid))) setSelectedIds(selectedIds.filter((sid) => ok.has(sid)));
  }, [doc, pageId, selectedIds]);
  const add = (type, at) => { const r = addZone(doc, type, pageId, at); change(r.doc); setSelectedIds([r.zone.id]); setTab('canvas'); };
  const selectPage = (pid) => { setPageId(pid); setSelectedIds([]); };

  if (layout.error) return <div className="error">{layout.error.message} · <Link to="/layouts">back to layouts</Link></div>;
  if (!layout.data || !doc) return <div className="muted">Loading…</div>;
  const dirty = JSON.stringify(doc) !== savedJson || name !== layout.data.name;
  const byZone = errorsByZone(errors);
  const generalErrors = errors.filter((e) => !/zone "/.test(e));
  const page = pageById(doc, pageId);
  return (
    <>
      <div className="topbar">
        <h1><Link to="/layouts" className="muted">Layouts</Link> / <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Layout name" style={{ width: 260, display: 'inline-block', fontSize: 18, padding: '3px 8px' }} /> <span className="muted small">{pagesOf(doc).length} page(s) · {totalCycleSeconds(doc)} s loop</span></h1>
        <div className="actions">
          <div className="editor-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'canvas'} className={tab === 'canvas' ? 'active' : ''} onClick={() => setTab('canvas')}>Canvas</button>
            <button role="tab" aria-selected={tab === 'preview'} className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>Preview</button>
            <button role="tab" aria-selected={tab === 'json'} className={tab === 'json' ? 'active' : ''} onClick={() => setTab('json')}>Advanced</button>
          </div>
          <button className="primary" disabled={!dirty || saving || errors.length > 0} onClick={save}>{saving ? 'Saving…' : 'Save & publish'}</button>
        </div>
      </div>
      {generalErrors.length > 0 && <ul className="error" role="status">{generalErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
      <div className={'editor-grid' + (tab !== 'json' ? ' with-palette' : '')}>
        {tab !== 'json' && <div>
          <PageNavigator doc={doc} pageId={pageId} onSelect={selectPage} onChange={change} />
          {tab === 'canvas' && <Palette doc={doc} onAdd={(t) => add(t)} />}
        </div>}
        <div>
          {tab === 'canvas' && (
            <div className="card" ref={wrapRef}>
              <EditorToolbar doc={doc} selectedIds={selectedIds} onChange={change} onSelect={setSelectedIds} pageId={pageId} canUndo={past.current.length > 0} canRedo={future.current.length > 0} onUndo={undo} onRedo={redo} />
              <CanvasEditor doc={doc} onChange={change} selectedIds={selectedIds} onSelect={setSelectedIds} pageId={pageId} width={canvasWidth - 32} errorsByZone={byZone} onDropType={(t, at) => add(t, at)} />
            </div>)}
          {tab === 'preview' && (
            <div className="card" ref={wrapRef}>
              <div className="inline" style={{ marginBottom: 8, gap: 12 }}>
                <span className="small">Page <b>{page ? page.name || page.id : '—'}</b>{page ? <span className="muted"> · {page.duration_s} s</span> : null}</span>
              </div>
              <LayoutPreview doc={doc} pageId={pageId} width={canvasWidth - 32} site={site} />
              <div className="muted small" style={{ marginTop: 6 }}>Drawn by the player's own renderer code with sample weather. The video region is a hatched hole here — on the box ffmpeg composites the clips into it. Pick another page on the left to preview it.</div>
            </div>)}
          {tab === 'json' && (
            <div className="card">
              <Field label="Layout JSON (schema 2) — advanced"><textarea className="code" value={text} onChange={(e) => onText(e.target.value)} spellCheck={false} aria-label="Layout JSON" style={{ minHeight: 560 }} /></Field>
              {errors.length > 0 && <ul className="error small">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
              {errors.length === 0 && dirty && <div className="muted small">Unsaved changes.</div>}
            </div>)}
        </div>
        <div>
          <div className="card"><ZonePanel doc={doc} selectedIds={selectedIds} onChange={change} onSelect={setSelectedIds} pageId={pageId} errorsByZone={byZone} /></div>
        </div>
      </div>
    </>
  );
}
