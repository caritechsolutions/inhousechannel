import React, { useEffect, useRef, useState } from 'react';
import { get, post, patch, del } from '../api.js';
import { useAsync, useToast, Confirm, Empty } from '../components/ui.jsx';
import { uploadMedia, MediaTile, StatusBadge, ACCEPT_ALL } from '../components/MediaPicker.jsx';
import { useSession, NeedSite } from '../App.jsx';
import { timeAgo, fmtBytes, fmtDuration } from '../util.js';

// Media library of the selected site: drag-and-drop upload with progress, grid with status
// badges (videos/audio are normalised server-side before they can be used), rename, delete, preview.
export default function Media() {
  const session = useSession();
  if (!session.site) return <><div className="topbar"><h1>Media</h1></div><NeedSite /></>;
  return <MediaLibrary key={session.site.id} siteId={session.site.id} />;
}

function MediaLibrary({ siteId }) {
  const toast = useToast();
  const media = useAsync(() => get(`/sites/${siteId}/media`), [siteId]);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [drag, setDrag] = useState(false);
  const [uploads, setUploads] = useState([]);   // [{name, pct, error}]
  const [sel, setSel] = useState(null);
  const [rename, setRename] = useState('');
  const [removing, setRemoving] = useState(null);
  const fileRef = useRef(null);

  // poll while anything is processing
  const processing = (media.data || []).some((m) => m.status === 'processing');
  useEffect(() => {
    if (!processing) return undefined;
    const t = setInterval(media.reload, 3000); return () => clearInterval(t);
  }, [processing, media.reload]);
  // keep the detail panel in sync with the latest row
  useEffect(() => { if (sel && media.data) { const m = media.data.find((x) => x.id === sel.id); if (m && m !== sel) setSel(m); } }, [media.data]); // eslint-disable-line

  async function uploadFiles(files) {
    const list = Array.from(files || []).filter((f) => f.size);
    if (!list.length) return;
    const rows = list.map((f) => ({ name: f.name, pct: 0, error: null }));
    setUploads(rows);
    let ok = 0;
    for (let i = 0; i < list.length; i++) {
      try {
        await uploadMedia(siteId, list[i], (p) => setUploads((u) => u.map((r, j) => (j === i ? { ...r, pct: p } : r))));
        setUploads((u) => u.map((r, j) => (j === i ? { ...r, pct: 1 } : r))); ok++;
      } catch (err) { setUploads((u) => u.map((r, j) => (j === i ? { ...r, error: err.message } : r))); toast(`${list[i].name}: ${err.message}`, 'bad'); }
      media.reload();
    }
    if (ok) toast(`Uploaded ${ok} file${ok === 1 ? '' : 's'}`);
    setTimeout(() => setUploads((u) => u.filter((r) => r.error)), 1500);
  }
  function onDrop(e) { e.preventDefault(); setDrag(false); uploadFiles(e.dataTransfer.files); }
  function select(m) { setSel(m); setRename(m ? m.name : ''); }
  async function saveName() {
    if (!sel || !rename.trim() || rename.trim() === sel.name) return;
    try { const r = await patch(`/sites/${siteId}/media/${sel.id}`, { name: rename.trim() }); setSel(r || { ...sel, name: rename.trim() }); media.reload(); toast('Renamed'); } catch (err) { toast(err.message, 'bad'); }
  }
  async function remove() {
    const m = removing;
    try { await del(`/sites/${siteId}/media/${m.id}`); toast(`Deleted ${m.name}`); if (sel && sel.id === m.id) select(null); setRemoving(null); media.reload(); } catch (err) {
      setRemoving(null);
      if (err.status === 409) toast(`${m.name} is used by ${[...((err.body && err.body.layouts) || []).map((l) => `layout "${l.name}"`), ...(err.body && err.body.logo ? ['the site logo'] : [])].join(', ') || 'a layout'} — remove it there first`, 'bad');
      else toast(err.message, 'bad');
    }
  }
  async function retry(m) {
    try { await post(`/sites/${siteId}/media/${m.id}/retry`); toast('Normalisation restarted'); media.reload(); } catch (err) { toast(err.message, 'bad'); }
  }
  const items = (media.data || []).filter((m) => (filter === 'all' || m.kind === filter) && (!q || m.name.toLowerCase().includes(q.toLowerCase())));
  const total = (media.data || []).reduce((a, m) => a + (m.size || 0), 0);

  return (
    <>
      <div className="topbar"><h1>Media</h1>
        <span className="muted small">{(media.data || []).length} files · {fmtBytes(total)}</span>
        <span style={{ flex: 1 }} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search media" style={{ width: 200 }} />
        <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Kind"><option value="all">All</option><option value="image">Images</option><option value="video">Videos</option><option value="audio">Audio</option><option value="font">Fonts</option></select>
        <label className="btn primary">Upload<input ref={fileRef} type="file" multiple accept={ACCEPT_ALL} style={{ display: 'none' }} onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }} aria-label="Upload files" /></label>
      </div>
      {uploads.length > 0 && <div className="card" style={{ marginBottom: 12 }} aria-label="Uploads">
        {uploads.map((u, i) => <div key={i} className="upload-row"><span className="media-name" style={{ flex: 1 }}>{u.name}</span>
          {u.error ? <span className="error small">{u.error}</span> : <progress value={u.pct} max={1} aria-label={`upload ${u.name}`} />}<span className="muted small" style={{ width: 40, textAlign: 'right' }}>{u.error ? '' : `${Math.round(u.pct * 100)}%`}</span></div>)}
      </div>}
      <div className={'dropzone' + (drag ? ' drag' : '')} onDragOver={(e) => { e.preventDefault(); if (!drag) setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop} data-testid="dropzone">
        <div className="muted small" style={{ textAlign: 'center', padding: '10px 0' }}>Drop images (PNG, JPG, WebP, SVG), video clips, music (MP3/AAC) or fonts here. Videos and audio are normalised for the player before they can be used in a layout.</div>
        {media.loading && !media.data ? <div className="muted">Loading…</div> : items.length === 0 ? <Empty>{(media.data || []).length ? 'Nothing matches.' : 'No media yet. Drop a file above or click Upload.'}</Empty> : (
          <div className="media-grid">
            {items.map((m) => <MediaTile key={m.id} item={m} selected={sel && sel.id === m.id} onClick={() => select(m)} />)}
          </div>)}
      </div>

      {sel && (
        <div className="card media-detail" role="region" aria-label="Media details">
          <div className="inline" style={{ alignItems: 'flex-start', gap: 16 }}>
            <div className="media-preview">
              {sel.kind === 'video' ? (sel.status === 'ready' ? <video src={sel.url} poster={sel.thumb_url || undefined} controls muted style={{ width: '100%' }} /> : <StatusBadge status={sel.status} error={sel.error} />)
                : sel.kind === 'audio' ? (sel.status === 'ready' ? <audio src={sel.url} controls style={{ width: '100%' }} /> : <StatusBadge status={sel.status} error={sel.error} />)
                : sel.kind === 'image' ? <img src={sel.url} alt="" /> : <span className="media-glyph">Aa</span>}
            </div>
            <div style={{ flex: 1 }}>
              <div className="field"><label>Name</label>
                <div className="inline"><input value={rename} onChange={(e) => setRename(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveName(); }} aria-label="Media name" style={{ flex: 1 }} /><button onClick={saveName} disabled={!rename.trim() || rename.trim() === sel.name}>Rename</button></div></div>
              <table className="kv small"><tbody>
                <tr><td className="muted">Status</td><td><StatusBadge status={sel.status || 'ready'} error={sel.error} />{sel.status === 'failed' && sel.error ? <span className="error small" style={{ marginLeft: 8 }}>{sel.error}</span> : null}</td></tr>
                <tr><td className="muted">Type</td><td>{sel.mime}{sel.width ? ` · ${sel.width}×${sel.height}` : ''}{sel.duration_s != null ? ` · ${fmtDuration(sel.duration_s)}` : ''} · {fmtBytes(sel.size)}</td></tr>
                <tr><td className="muted">Reference</td><td><code className="small">{sel.ref || `media:${sel.id}`}</code> <span className="muted small">— how layouts refer to this file</span></td></tr>
                <tr><td className="muted">Uploaded</td><td>{timeAgo(sel.created_at)}</td></tr>
              </tbody></table>
              <div className="actions" style={{ marginTop: 10 }}>
                {sel.status === 'failed' && <button onClick={() => retry(sel)}>Retry normalisation</button>}
                <button className="danger" onClick={() => setRemoving(sel)}>Delete</button>
                <button className="ghost" onClick={() => select(null)}>Close</button>
              </div>
            </div>
          </div>
        </div>)}
      {removing && <Confirm title="Delete media" text={`Delete "${removing.name}"? Layouts that still use it will show an empty zone.`} onConfirm={remove} onClose={() => setRemoving(null)} />}
    </>
  );
}
