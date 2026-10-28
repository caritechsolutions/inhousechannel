import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, post, del } from '../api.js';
import { useAsync, Modal, Confirm, Field, Empty, useToast } from '../components/ui.jsx';
import { fmtDate } from '../util.js';
import { useSession, NeedSite } from '../App.jsx';
import LayoutThumb from '../editor/LayoutThumb.jsx';
import { pagesOf } from '../editor/geometry.js';

export default function Layouts() {
  const session = useSession();
  if (!session.site) return <><div className="topbar"><h1>Layouts</h1></div><NeedSite /></>;
  return <LayoutList key={session.site.id} siteId={session.site.id} site={session.site} />;
}

function LayoutList({ siteId, site }) {
  const toast = useToast();
  const nav = useNavigate();
  const layouts = useAsync(() => get(`/sites/${siteId}/layouts`), [siteId]);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState(null);

  async function create(name, template) {
    try { const l = await post(`/sites/${siteId}/layouts`, { name, json: template.json }); setCreating(false); nav(`/layouts/${l.id}`); } catch (e) { toast(e.message, 'bad'); }
  }
  async function duplicate(l) {
    try { const c = await post(`/sites/${siteId}/layouts/${l.id}/duplicate`); toast(`Created "${c.name}"`); layouts.reload(); } catch (e) { toast(e.message, 'bad'); }
  }
  async function remove() {
    try { await del(`/sites/${siteId}/layouts/${removing.id}`); toast('Layout deleted'); setRemoving(null); layouts.reload(); } catch (e) {
      const used = (e.body && e.body.players || []).map((p) => p.name).join(', ');
      toast(e.status === 409 ? `${removing.name} is still used by ${used || 'a player or schedule'} — reassign first` : e.message, 'bad');
    }
  }
  return (
    <>
      <div className="topbar"><h1>Layouts <span className="muted small">· {site.name}</span></h1><div className="actions"><button className="primary" onClick={() => setCreating(true)}>New layout</button></div></div>
      <p className="muted small">A layout is what the channel shows: timed pages of zones (text, images, slideshow, ticker, clock, one video region, …) on a 1920×1080 canvas. Saving publishes it; players pick it up on their next sync (≤ 60 s).</p>
      <div className="card" style={{ padding: 0 }}>
        {layouts.data && layouts.data.length === 0 ? <Empty>No layouts yet. Players without a layout show the built-in slate.</Empty> : (
          <table>
            <thead><tr><th></th><th>Name</th><th className="num">Pages</th><th>Used by</th><th>Updated</th><th></th></tr></thead>
            <tbody>{(layouts.data || []).map((l) => (
              <tr key={l.id}>
                <td style={{ width: 130 }}><Link to={`/layouts/${l.id}`}><LayoutThumb doc={l.json} width={120} /></Link></td>
                <td><Link to={`/layouts/${l.id}`}><b>{l.name}</b></Link></td>
                <td className="num muted">{l.json ? pagesOf(l.json).length || 1 : '—'}</td>
                <td className="muted">{Array.isArray(l.players) ? (l.players.length ? l.players.map((p) => p.name).join(', ') : '—') : l.player_count != null ? `${l.player_count} player(s)` : ''}</td>
                <td className="muted">{fmtDate(l.updated_at)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="sm" onClick={() => nav(`/layouts/${l.id}`)}>Edit</button>{' '}
                  <button className="sm" onClick={() => duplicate(l)}>Duplicate</button>{' '}
                  <button className="sm danger" onClick={() => setRemoving(l)}>Delete</button>
                </td>
              </tr>))}</tbody>
          </table>)}
      </div>
      {creating && <NewLayoutModal onCreate={create} onClose={() => setCreating(false)} />}
      {removing && <Confirm title="Delete layout" text={`Delete "${removing.name}"? Players using it as default fall back to the built-in slate.`} onConfirm={remove} onClose={() => setRemoving(null)} />}
    </>
  );
}

export const BLANK_TEMPLATE = { id: 'blank', name: 'Blank', description: 'An empty 1920×1080 page.', json: { schema: 2, canvas: { w: 1920, h: 1080, background: '#0b1a2a', backgroundImage: null }, zones: [], pages: [{ id: 'page1', name: 'Page 1', zones: [], duration_s: 15 }] } };

function NewLayoutModal({ onCreate, onClose }) {
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('blank');
  const templates = useAsync(() => get('/layout-templates').catch(() => []), []);
  const all = [BLANK_TEMPLATE, ...(templates.data || [])];
  const chosen = all.find((t) => t.id === template) || BLANK_TEMPLATE;
  return (
    <Modal title="New layout" onClose={onClose} wide footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={!name.trim()} onClick={() => onCreate(name.trim(), chosen)}>Create</button></>}>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Lobby channel" aria-label="Layout name" /></Field>
      <Field label="Start from a template">
        <div className="template-grid" role="radiogroup" aria-label="Template">
          {all.map((t) => (
            <label key={t.id} className={'template-card' + (template === t.id ? ' active' : '')}>
              <input type="radio" name="template" value={t.id} checked={template === t.id} onChange={() => setTemplate(t.id)} aria-label={t.name} />
              <LayoutThumb doc={t.json} width={150} />
              <b>{t.name}</b><span className="muted small">{t.description}</span>
            </label>))}
        </div>
      </Field>
    </Modal>
  );
}
