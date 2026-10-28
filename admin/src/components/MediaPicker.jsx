import React, { useEffect, useRef, useState } from 'react';
import { get, upload } from '../api.js';
import { Modal, useToast } from './ui.jsx';
import { useSession } from '../App.jsx';
import { fmtBytes, fmtDuration } from '../util.js';

export const ACCEPT_IMAGES = 'image/png,image/jpeg,image/webp,image/svg+xml';
export const ACCEPT_VIDEOS = 'video/*,.mp4,.mov,.mkv,.webm,.ts';
export const ACCEPT_AUDIO = 'audio/*,.mp3,.aac,.m4a';
export const ACCEPT_ALL = ACCEPT_IMAGES + ',' + ACCEPT_VIDEOS + ',' + ACCEPT_AUDIO + ',.woff2,.woff,.ttf,.otf';

// Upload one file to the site's media library (multipart field `file`, optional `name`).
export function uploadMedia(siteId, file, onProgress) {
  const fd = new FormData();
  fd.append('file', file, file.name);
  fd.append('name', file.name.replace(/\.[^.]+$/, ''));
  return upload(`/sites/${siteId}/media`, fd, onProgress);
}

export function StatusBadge({ status, error }) {
  if (status === 'ready') return <span className="pill ok">ready</span>;
  if (status === 'failed') return <span className="pill bad" title={error || ''}>failed</span>;
  return <span className="pill warn">processing…</span>;
}

const GLYPH = { video: '▶', audio: '♪', font: 'Aa' };

// One tile of the library grid.
export function MediaTile({ item, selected, onClick, children, showStatus = true }) {
  const img = item.kind === 'image' || (item.kind === 'video' && item.thumb_url);
  return (
    <div className={'media-tile' + (selected ? ' selected' : '') + (item.status && item.status !== 'ready' ? ' not-ready' : '')} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined} aria-label={item.name} data-testid="media-tile">
      <div className="media-thumb">
        {img ? <img src={item.thumb_url || item.url} alt="" loading="lazy" /> : <span className="media-glyph" aria-hidden>{GLYPH[item.kind] || '▢'}</span>}
        {item.kind === 'video' && item.duration_s != null && <span className="media-dur">{fmtDuration(item.duration_s)}</span>}
      </div>
      <div className="media-meta">
        <div className="media-name" title={item.name}>{item.name}</div>
        <div className="muted small">{item.kind}{item.width ? ` · ${item.width}×${item.height}` : ''}{item.size != null ? ` · ${fmtBytes(item.size)}` : ''}</div>
        {showStatus && item.status && item.status !== 'ready' && <div style={{ marginTop: 4 }}><StatusBadge status={item.status} error={item.error} /></div>}
      </div>
      {children}
    </div>
  );
}

// Modal picker. kind = 'image' | 'video' | 'audio' | 'all'. onPick(item) (or onPick(items) when
// multiple). Only `ready` media can be picked; upload straight from the picker.
export default function MediaPicker({ kind = 'image', title, onPick, onClose, multiple = false, allowUrl = false }) {
  const toast = useToast();
  const session = useSession();
  const siteId = session && session.site && session.site.id;
  const [items, setItems] = useState(null);
  const [q, setQ] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(null);
  const [chosen, setChosen] = useState([]);
  const fileRef = useRef(null);
  const load = () => (siteId ? get(`/sites/${siteId}/media`).then(setItems, () => setItems([])) : setItems([]));
  useEffect(() => { load(); }, [siteId]); // eslint-disable-line
  // poll while something is processing
  useEffect(() => {
    if (!items || !items.some((m) => m.status === 'processing')) return undefined;
    const t = setInterval(load, 3000); return () => clearInterval(t);
  }, [items]); // eslint-disable-line
  const visible = (items || []).filter((m) => (kind === 'all' || m.kind === kind) && (!q || m.name.toLowerCase().includes(q.toLowerCase())));
  const accept = kind === 'video' ? ACCEPT_VIDEOS : kind === 'audio' ? ACCEPT_AUDIO : kind === 'image' ? ACCEPT_IMAGES : ACCEPT_ALL;
  async function doUpload(e) {
    const files = Array.from(e.target.files || []); e.target.value = '';
    if (!files.length) return;
    try {
      let last = null;
      for (let i = 0; i < files.length; i++) { setBusy(`${i + 1}/${files.length}`); last = await uploadMedia(siteId, files[i]); }
      await load();
      if (files.length === 1 && last && last.status === 'ready' && !multiple) onPick(last);
      else toast(`Uploaded ${files.length} file${files.length === 1 ? '' : 's'}${last && last.status !== 'ready' ? ' — processing, pick it when it is ready' : ''}`);
    } catch (err) { toast(err.message, 'bad'); } finally { setBusy(null); }
  }
  const pick = (m) => {
    if (m.status && m.status !== 'ready') { toast('That file is still processing', 'bad'); return; }
    if (!multiple) return onPick(m);
    setChosen((c) => (c.some((x) => x.id === m.id) ? c.filter((x) => x.id !== m.id) : [...c, m]));
  };
  return (
    <Modal title={title || (kind === 'video' ? 'Choose a video' : kind === 'audio' ? 'Choose audio' : multiple ? 'Choose images' : 'Choose an image')} onClose={onClose} wide footer={<>
      {allowUrl && <div className="inline" style={{ flex: 1 }}><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="…or paste a URL" aria-label="Media URL" style={{ flex: 1 }} />
        <button disabled={!url.trim()} onClick={() => onPick({ id: null, url: url.trim(), name: url.trim(), kind })}>Use URL</button></div>}
      {multiple && <button className="primary" disabled={!chosen.length} onClick={() => onPick(chosen)}>Add {chosen.length || ''} selected</button>}
      <button onClick={onClose}>Cancel</button>
    </>}>
      <div className="media-picker">
        <div className="inline" style={{ marginBottom: 10 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the library" aria-label="Search media" style={{ flex: 1 }} />
          <label className={'btn' + (busy ? ' disabled' : '')}>{busy ? `Uploading ${busy}` : 'Upload'}<input ref={fileRef} type="file" multiple accept={accept} style={{ display: 'none' }} onChange={doUpload} disabled={!!busy || !siteId} aria-label="Upload file" /></label>
        </div>
        {items === null ? <div className="muted">Loading…</div> : (
          <div className="media-grid picker">
            {visible.map((m) => <MediaTile key={m.id} item={m} selected={chosen.some((x) => x.id === m.id)} onClick={() => pick(m)} />)}
            {visible.length === 0 && <div className="muted small" style={{ gridColumn: '1 / -1' }}>{items.length ? 'Nothing matches.' : 'The library is empty — upload a file.'}</div>}
          </div>)}
      </div>
    </Modal>
  );
}
