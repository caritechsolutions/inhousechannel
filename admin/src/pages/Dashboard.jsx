import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api.js';
import { useAsync, Empty } from '../components/ui.jsx';
import { timeAgo, fmtUptime } from '../util.js';
import { useSession } from '../App.jsx';

// Player cards across every site the user can see. Refreshes every 15 s.
export default function Dashboard() {
  const session = useSession();
  const { data, error, reload } = useAsync(() => get('/dashboard'), []);
  useEffect(() => { const t = setInterval(reload, 15000); return () => clearInterval(t); }, [reload]);
  if (error) return <div className="error">{error.message}</div>;
  if (!data) return <div className="muted">Loading…</div>;
  // Server shape: { sites: [{ id, name, players: [...], counts }] }. A flat { players } list
  // (each with site_name) is accepted too.
  const players = Array.isArray(data.sites)
    ? data.sites.flatMap((s) => (s.players || []).map((p) => ({ ...p, site_name: p.site_name || s.name })))
    : (data.players || []);
  const online = players.filter((p) => p.online).length;
  const sites = new Set(players.map((p) => p.site_id));
  return (
    <>
      <div className="topbar"><h1>Dashboard</h1><span className="muted small">refreshes every 15 s</span></div>
      <div className="cards">
        <div className="stat"><div className="n">{players.length}</div><div className="l">players</div></div>
        <div className="stat ok"><div className="n">{online}</div><div className="l">online (heartbeat in the last 3 min)</div></div>
        <div className={'stat ' + (players.length - online ? 'bad' : '')}><div className="n">{players.length - online}</div><div className="l">offline</div></div>
        <div className="stat"><div className="n">{sites.size}</div><div className="l">sites with players</div></div>
      </div>
      {players.length === 0 ? <Empty>No players yet. {session.site ? <Link to="/players">Create one</Link> : 'Select a site to create one.'}</Empty> : (
        <div className="player-grid">
          {players.map((p) => <PlayerCard key={p.id} p={p} onOpen={() => session.setSite(p.site_id)} />)}
        </div>)}
    </>
  );
}

export const playingName = (p) => p.current_layout_name || p.layout_name || null;

export function PlayerCard({ p, onOpen }) {
  const st = p.status || {};
  const layoutName = playingName(p);
  return (
    <div className={'player-card' + (p.online ? '' : ' offline')} data-testid="player-card">
      <div className="player-thumb">
        {p.thumbnail_url ? <img src={p.thumbnail_url} alt="" /> : <div className="muted small">no thumbnail yet</div>}
        <span className={'dot ' + (p.online ? 'on' : 'off')} title={p.online ? 'online' : 'offline'} />
      </div>
      <div className="player-body">
        <div className="inline" style={{ justifyContent: 'space-between' }}>
          <Link to={`/players/${p.id}`} onClick={onOpen}><b>{p.name}</b></Link>
          <span className="muted small">{p.site_name}</span>
        </div>
        <div className="small">{layoutName ? <>Playing <b>{layoutName}</b></> : <span className="muted">no layout assigned</span>}</div>
        <div className="muted small player-stats">
          <span title="encode fps">{st.fps != null ? `${Math.round(st.fps)} fps` : '— fps'}</span>
          <span title="CPU">{st.cpu_pct != null ? `${Math.round(st.cpu_pct)} % CPU` : '— CPU'}</span>
          <span title="TS bitrate">{st.bitrate_kbps != null ? `${(st.bitrate_kbps / 1000).toFixed(1)} Mb/s` : ''}</span>
          {st.restarts_last_hour ? <span className="warn" title="restarts in the last hour">{st.restarts_last_hour} restart{st.restarts_last_hour === 1 ? '' : 's'}/h</span> : null}
        </div>
        <div className="muted small">{p.resolution || ''}{p.version ? ` · v${p.version}` : ''}{st.uptime_s != null ? ` · up ${fmtUptime(st.uptime_s)}` : ''} · seen {timeAgo(p.last_seen_at)}</div>
      </div>
    </div>
  );
}
