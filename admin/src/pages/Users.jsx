import React, { useState } from 'react';
import { get, post, patch, del } from '../api.js';
import { useAsync, Modal, Confirm, Field, Empty, useToast } from '../components/ui.jsx';
import { fmtDate } from '../util.js';
import { useSession } from '../App.jsx';

// Server rows carry memberships: [{site_id, role, site_name}] (an older shape used sites: [{name, role}]).
function membershipsText(u) {
  const ms = u.memberships || u.sites || [];
  return ms.length ? ms.map((m) => `${m.site_name || m.name} (${m.role})`).join(', ') : '—';
}

// Superadmin: users CRUD, reset password, superadmin flag. Site roles are set per site (Sites → Members).
export default function Users() {
  const toast = useToast();
  const session = useSession();
  const users = useAsync(() => get('/users'), []);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState(null);
  const [removing, setRemoving] = useState(null);

  async function create(form) {
    try { await post('/users', form); toast(`User ${form.email} created`); setCreating(false); users.reload(); } catch (e) { toast(e.message, 'bad'); }
  }
  async function reset(u, password) {
    try { await patch(`/users/${u.id}`, { password }); toast(`Password for ${u.email} changed`); setResetting(null); } catch (e) { toast(e.message, 'bad'); }
  }
  async function setSuper(u, is_superadmin) {
    try { await patch(`/users/${u.id}`, { is_superadmin }); users.reload(); toast(is_superadmin ? `${u.email} is now a superadmin` : `${u.email} is no longer a superadmin`); } catch (e) { toast(e.message, 'bad'); }
  }
  async function remove() {
    try { await del(`/users/${removing.id}`); toast('User deleted'); setRemoving(null); users.reload(); } catch (e) { toast(e.message, 'bad'); }
  }
  return (
    <>
      <div className="topbar"><h1>Users</h1><div className="actions"><button className="primary" onClick={() => setCreating(true)}>New user</button></div></div>
      <p className="muted small">Site roles (admin / editor) are assigned under Sites → Members. A superadmin sees every site.</p>
      <div className="card" style={{ padding: 0 }}>
        {users.data && users.data.length === 0 ? <Empty>No users.</Empty> : (
          <table>
            <thead><tr><th>Email</th><th>Superadmin</th><th>Sites</th><th>Created</th><th></th></tr></thead>
            <tbody>{(users.data || []).map((u) => (
              <tr key={u.id}>
                <td><b>{u.email}</b>{u.id === session.user.id && <span className="pill accent" style={{ marginLeft: 6 }}>you</span>}</td>
                <td><label className="inline" style={{ color: 'var(--text)', margin: 0 }}><input type="checkbox" checked={!!u.is_superadmin} disabled={u.id === session.user.id} onChange={(e) => setSuper(u, e.target.checked)} aria-label={`superadmin ${u.email}`} /> {u.is_superadmin ? 'yes' : 'no'}</label></td>
                <td className="muted small">{u.is_superadmin ? 'all sites' : membershipsText(u)}</td>
                <td className="muted small">{fmtDate(u.created_at)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}><button className="sm" onClick={() => setResetting(u)}>Reset password</button> {u.id !== session.user.id && <button className="sm danger" onClick={() => setRemoving(u)}>Delete</button>}</td>
              </tr>))}</tbody>
          </table>)}
      </div>
      {creating && <UserModal onSave={create} onClose={() => setCreating(false)} />}
      {resetting && <PasswordModal user={resetting} onSave={(p) => reset(resetting, p)} onClose={() => setResetting(null)} />}
      {removing && <Confirm title="Delete user" text={`Delete ${removing.email}? Their site memberships are removed too.`} onConfirm={remove} onClose={() => setRemoving(null)} />}
    </>
  );
}

function UserModal({ onSave, onClose }) {
  const [f, setF] = useState({ email: '', password: '', is_superadmin: false });
  const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email) && f.password.length >= 8;
  return (
    <Modal title="New user" onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={!ok} onClick={() => onSave({ ...f, email: f.email.trim().toLowerCase() })}>Create</button></>}>
      <Field label="Email"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoFocus aria-label="Email" /></Field>
      <Field label="Password (8+ characters)"><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} aria-label="Password" /></Field>
      <label className="inline" style={{ color: 'var(--text)' }}><input type="checkbox" checked={f.is_superadmin} onChange={(e) => setF({ ...f, is_superadmin: e.target.checked })} aria-label="Superadmin" /> superadmin (sees and manages every site)</label>
    </Modal>
  );
}
function PasswordModal({ user, onSave, onClose }) {
  const [p, setP] = useState('');
  return <Modal title={`Reset password for ${user.email}`} onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={p.length < 8} onClick={() => onSave(p)}>Save</button></>}>
    <Field label="New password (8+ characters)"><input type="password" value={p} onChange={(e) => setP(e.target.value)} autoFocus aria-label="New password" /></Field>
    <p className="muted small">Their other sessions are signed out.</p>
  </Modal>;
}
