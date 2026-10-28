import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Routes, Route, NavLink, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { get, post } from './api.js';
import { ToastProvider } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Sites from './pages/Sites.jsx';
import Users from './pages/Users.jsx';
import Players from './pages/Players.jsx';
import Media from './pages/Media.jsx';
import Layouts from './pages/Layouts.jsx';
import LayoutEdit from './pages/LayoutEdit.jsx';

// { user, sites, site (selected), setSite, isSuper, refresh, refreshSites, logout }
// The server's /me and /login answer { user, sites }: every site the caller may see, each
// with its role (superadmins get every site as 'admin'). Older shapes with user.sites are
// accepted too.
export const SessionCtx = React.createContext(null);
export const useSession = () => React.useContext(SessionCtx);

const NAV = [
  ['/', 'Dashboard', '▦'],
  ['/players', 'Players', '▶'],
  ['/layouts', 'Layouts', '▤'],
  ['/media', 'Media', '▣'],
];
const SUPER_NAV = [['/sites', 'Sites', '⌂'], ['/users', 'Users', '☺']];
const SITE_KEY = 'ihc.site';

function readStoredSite() { try { return Number(localStorage.getItem(SITE_KEY)) || null; } catch { return null; } }
function storeSite(id) { try { if (id) localStorage.setItem(SITE_KEY, String(id)); else localStorage.removeItem(SITE_KEY); } catch { /* private window */ } }

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = loading, null = logged out
  const [siteId, setSiteId] = useState(readStoredSite);
  const nav = useNavigate();
  const loc = useLocation();

  const load = useCallback(() => get('/me').then((s) => { setSession(s); return s; }, () => { setSession(null); return null; }), []);
  useEffect(() => {
    load();
    const onUnauth = () => setSession(null);
    window.addEventListener('ihc:unauthorized', onUnauth);
    return () => window.removeEventListener('ihc:unauthorized', onUnauth);
  }, [load]);
  const user = session && session.user;
  const isSuper = !!(user && user.is_superadmin);

  const sites = useMemo(() => {
    if (!user) return [];
    const list = Array.isArray(session.sites) ? session.sites : Array.isArray(user.sites) ? user.sites : [];
    return list.map((s) => ({ ...s, role: s.role || (isSuper ? 'admin' : 'editor') }));
  }, [session, user, isSuper]);
  // keep the selected site valid
  useEffect(() => {
    if (!user) return;
    if (sites.length && !sites.some((s) => s.id === siteId)) { setSiteId(sites[0].id); storeSite(sites[0].id); }
    if (!sites.length && siteId) { setSiteId(null); storeSite(null); }
  }, [user, sites, siteId]);
  const site = sites.find((s) => s.id === siteId) || null;
  const setSite = (id) => { setSiteId(id); storeSite(id); };

  if (session === undefined) return <div className="login"><div className="muted">Loading…</div></div>;
  if (!session) {
    if (loc.pathname !== '/login') return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
    // /login answers { user, sites } but a superadmin's sites come back null there; /me lists them all.
    return <ToastProvider><Login onLogin={(s) => { setSession(s); if (!Array.isArray(s.sites)) load(); nav((loc.state && loc.state.from) || '/', { replace: true }); }} /></ToastProvider>;
  }
  if (loc.pathname === '/login') return <Navigate to="/" replace />;

  const logout = async () => { try { await post('/logout'); } finally { setSession(null); } };
  const ctx = { user, sites, site, setSite, isSuper, refresh: load, refreshSites: load, logout };

  return (
    <SessionCtx.Provider value={ctx}>
      <ToastProvider>
        <div className="shell">
          <nav className="sidebar">
            <div className="brand"><div className="logo">i</div><div><b>inhousechannel</b><small>digital signage</small></div></div>
            <div className="site-switch">
              <label htmlFor="site-select">Site</label>
              {sites.length ? (
                <select id="site-select" value={siteId || ''} onChange={(e) => setSite(Number(e.target.value))} aria-label="Site">
                  {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              ) : <div className="muted small">{isSuper ? 'No sites yet — create one under Sites.' : 'You are not a member of any site.'}</div>}
            </div>
            <div className="nav">
              {NAV.map(([to, label, icon]) => <NavLink key={to} to={to} end={to === '/'}><span aria-hidden>{icon}</span>{label}</NavLink>)}
              {isSuper && <><div className="sep" /><div className="label">Superadmin</div>{SUPER_NAV.map(([to, label, icon]) => <NavLink key={to} to={to}><span aria-hidden>{icon}</span>{label}</NavLink>)}</>}
            </div>
            <div className="me"><b>{user.email}</b>{isSuper ? 'superadmin' : site ? `${site.role} · ${site.name}` : 'no site'}<div style={{ marginTop: 8 }}><button className="sm" onClick={logout}>Log out</button></div></div>
          </nav>
          <main className="main">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/players" element={<Players />} />
              <Route path="/players/:id" element={<Players />} />
              <Route path="/layouts" element={<Layouts />} />
              <Route path="/layouts/:id" element={<LayoutEdit />} />
              <Route path="/media" element={<Media />} />
              {isSuper && <Route path="/sites" element={<Sites />} />}
              {isSuper && <Route path="/users" element={<Users />} />}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
      </ToastProvider>
    </SessionCtx.Provider>
  );
}

// Shown by site-scoped pages when no site is selected.
export function NeedSite() {
  const s = useSession();
  return <div className="empty">{s.isSuper ? 'Create a site first (Superadmin → Sites), then pick it in the sidebar.' : 'You are not a member of any site yet. Ask an administrator to add you.'}</div>;
}
