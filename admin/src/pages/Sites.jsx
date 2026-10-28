import React, { useEffect, useState } from 'react';
import { get, post, patch, put, del } from '../api.js';
import { useAsync, Modal, Confirm, Field, Empty, useToast } from '../components/ui.jsx';
import { useSession } from '../App.jsx';

const TIMEZONES = ['America/Barbados', 'America/Port_of_Spain', 'America/St_Vincent', 'America/Guyana', 'America/Jamaica', 'America/New_York', 'America/Toronto', 'Europe/London', 'Africa/Lagos', 'UTC'];
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Superadmin: sites CRUD + membership editor.
export default function Sites() {
  const toast = useToast();
  const session = useSession();
  const sites = useAsync(() => get('/sites'), []);
  const [editing, setEditing] = useState(null);     // null | {} (new) | site
  const [members, setMembers] = useState(null);     // site whose members are being edited
  const [removing, setRemoving] = useState(null);

  async function save(form) {
    try {
      if (form.id) { await patch(`/sites/${form.id}`, { name: form.name, slug: form.slug, timezone: form.timezone }); toast('Site updated'); }
      else { await post('/sites', { name: form.name, slug: form.slug, timezone: form.timezone }); toast(`Site ${form.name} created`); }
      setEditing(null); sites.reload(); session.refreshSites();
    } catch (e) { toast(e.message, 'bad'); }
  }
  async function remove() {
    try { await del(`/sites/${removing.id}`); toast('Site deleted'); setRemoving(null); sites.reload(); session.refreshSites(); } catch (e) { toast(e.message, 'bad'); }
  }
  return (
    <>
      <div className="topbar"><h1>Sites</h1><div className="actions"><button className="primary" onClick={() => setEditing({})}>New site</button></div></div>
      <p className="muted small">A site is one hotel. Every player, layout and media file belongs to exactly one site; users see only the sites they are members of.</p>
      <div className="card" style={{ padding: 0 }}>
        {sites.data && sites.data.length === 0 ? <Empty>No sites yet.</Empty> : (
          <table>
            <thead><tr><th>Name</th><th>Slug</th><th>Time zone</th><th className="num">Players</th><th></th></tr></thead>
            <tbody>{(sites.data || []).map((s) => (
              <tr key={s.id}>
                <td><b>{s.name}</b></td>
                <td className="mono small">{s.slug}</td>
                <td className="muted">{s.timezone || '—'}</td>
                <td className="num muted">{s.player_count ?? s.counts?.players ?? '—'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="sm" onClick={() => setMembers(s)}>Members</button>{' '}
                  <button className="sm" onClick={() => setEditing(s)}>Edit</button>{' '}
                  <button className="sm danger" onClick={() => setRemoving(s)}>Delete</button>
                </td>
              </tr>))}</tbody>
          </table>)}
      </div>
      {editing && <SiteModal site={editing} onSave={save} onClose={() => setEditing(null)} />}
      {members && <MembersModal site={members} onClose={() => setMembers(null)} />}
      {removing && <Confirm title="Delete site" text={`Delete "${removing.name}" with all its players, layouts, schedules and media? This cannot be undone.`} onConfirm={remove} onClose={() => setRemoving(null)} />}
    </>
  );
}

function SiteModal({ site, onSave, onClose }) {
  const [f, setF] = useState({ id: site.id, name: site.name || '', slug: site.slug || '', timezone: site.timezone || 'America/Barbados' });
  const [slugTouched, setSlugTouched] = useState(!!site.id);
  const setName = (name) => setF((x) => ({ ...x, name, slug: slugTouched ? x.slug : slugify(name) }));
  const ok = f.name.trim() && /^[a-z0-9][a-z0-9-]*$/.test(f.slug);
  return (
    <Modal title={site.id ? `Edit ${site.name}` : 'New site'} onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={!ok} onClick={() => onSave({ ...f, name: f.name.trim() })}>{site.id ? 'Save' : 'Create'}</button></>}>
      <Field label="Name"><input value={f.name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="The Nothing Box" aria-label="Site name" /></Field>
      <Field label="Slug" hint="Lowercase letters, digits and dashes. Used in media paths."><input value={f.slug} onChange={(e) => { setSlugTouched(true); setF({ ...f, slug: slugify(e.target.value) }); }} aria-label="Site slug" /></Field>
      <Field label="Time zone" hint="Schedules are evaluated in this zone.">
        <input list="tz-list" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} aria-label="Time zone" />
        <datalist id="tz-list">{TIMEZONES.map((t) => <option key={t} value={t} />)}</datalist>
      </Field>
    </Modal>
  );
}

// Membership editor: every user with a role select (none / editor / admin). The server takes
// one membership per call: PUT /sites/:id/members {user_id, role} upserts, DELETE /members/:user
// removes — Save sends only what changed.
function MembersModal({ site, onClose }) {
  const toast = useToast();
  const users = useAsync(() => get('/users'), []);
  const [orig, setOrig] = useState(null);   // {user_id: role} as loaded
  const [rows, setRows] = useState(null);   // {user_id: role} edited
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get(`/sites/${site.id}/members`).then((ms) => { const m = Object.fromEntries(ms.map((x) => [x.id ?? x.user_id, x.role])); setOrig(m); setRows(m); }, (e) => { toast(e.message, 'bad'); setOrig({}); setRows({}); });
  }, [site.id]); // eslint-disable-line
  const roleOf = (uid) => (rows && rows[uid]) || '';
  const setRole = (uid, role) => setRows((rs) => { const n = { ...rs }; if (role) n[uid] = role; else delete n[uid]; return n; });
  async function save() {
    setBusy(true);
    try {
      const ids = new Set([...Object.keys(orig), ...Object.keys(rows)]);
      for (const id of ids) {
        if (orig[id] === rows[id]) continue;
        if (rows[id]) await put(`/sites/${site.id}/members`, { user_id: Number(id), role: rows[id] });
        else await del(`/sites/${site.id}/members/${id}`);
      }
      toast('Members saved'); onClose();
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Members of ${site.name}`} onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !rows} onClick={save}>Save</button></>}>
      <p className="muted small">Admins manage the site's users, players, layouts and media; editors edit layouts, media and schedules. Superadmins see every site regardless.</p>
      {!users.data || !rows ? <div className="muted">Loading…</div> : users.data.length === 0 ? <Empty>No users yet — create them under Users.</Empty> : (
        <table>
          <thead><tr><th>User</th><th style={{ width: 140 }}>Role</th></tr></thead>
          <tbody>{users.data.map((u) => (
            <tr key={u.id}>
              <td>{u.email}{u.is_superadmin ? <span className="pill accent" style={{ marginLeft: 6 }}>superadmin</span> : null}</td>
              <td><select value={roleOf(u.id)} onChange={(e) => setRole(u.id, e.target.value)} aria-label={`role for ${u.email}`} disabled={!!u.is_superadmin}>
                <option value="">— none —</option><option value="editor">editor</option><option value="admin">admin</option>
              </select></td>
            </tr>))}</tbody>
        </table>)}
    </Modal>
  );
}
