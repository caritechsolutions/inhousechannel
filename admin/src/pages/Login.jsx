import React, { useState } from 'react';
import { post } from '../api.js';

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onLogin(await post('/login', { email: email.trim(), password })); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="brand"><div className="logo">i</div><div><b>inhousechannel</b><small>{location.hostname}</small></div></div>
        <div className="field"><label htmlFor="u">Email</label><input id="u" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="username" /></div>
        <div className="field"><label htmlFor="p">Password</label><input id="p" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></div>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="primary" style={{ width: '100%', marginTop: 6 }} disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
