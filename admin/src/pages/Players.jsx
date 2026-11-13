import { cpuText } from '../util';
import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, post, put, patch, del } from '../api.js';
import { playingName } from './Dashboard.jsx';
import { useAsync, Modal, Confirm, Field, Empty, useToast, Drawer, Status, CopyButton } from '../components/ui.jsx';
import { useSession, NeedSite } from '../App.jsx';
import { timeAgo, fmtUptime, DAY_LABELS, ALL_DAYS, dayOn, toggleDay, daysText } from '../util.js';

const RESOLUTIONS = ['1280x720', '1920x1080'];

// Players (screens) of the selected site: list, create (shows the key once), edit, rotate key,
// per-player schedule rules.
export default function Players() {
  const session = useSession();
  if (!session.site) return <><div className="topbar"><h1>Players</h1></div><NeedSite /></>;
  return <PlayerList key={session.site.id} siteId={session.site.id} site={session.site} />;
}

function PlayerList({ siteId, site }) {
  const toast = useToast();
  const nav = useNavigate();
  const { id } = useParams();
  const players = useAsync(() => get(`/sites/${siteId}/players`), [siteId]);
  const layouts = useAsync(() => get(`/sites/${siteId}/layouts`), [siteId]);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);   // {player, key, pair_command}
  const [removing, setRemoving] = useState(null);
  useEffect(() => { const t = setInterval(players.reload, 15000); return () => clearInterval(t); }, [players.reload]);

  const selected = id ? (players.data || []).find((p) => String(p.id) === String(id)) : null;
  async function create(form) {
    // Server answers { ...player, key, pair }; an older shape { player, key, pair_command } is accepted too.
    try { const r = await post(`/sites/${siteId}/players`, form); setCreating(false); setCreated(r); if (form.default_layout_id) await patch(`/sites/${siteId}/players/${(r.player || r).id}`, { default_layout_id: form.default_layout_id }).catch(() => {}); players.reload(); } catch (e) { toast(e.message, 'bad'); }
  }
  async function remove() {
    try { await del(`/sites/${siteId}/players/${removing.id}`); toast('Player deleted'); setRemoving(null); if (selected && selected.id === removing.id) nav('/players'); players.reload(); } catch (e) { toast(e.message, 'bad'); }
  }
  const layoutName = (lid) => { const l = (layouts.data || []).find((x) => x.id === lid); return l ? l.name : null; };
  return (
    <>
      <div className="topbar"><h1>Players <span className="muted small">· {site.name}</span></h1><div className="actions"><button className="primary" onClick={() => setCreating(true)}>New player</button></div></div>
      <p className="muted small">A player is one hotel box producing one TV channel. Create it here, then run the pairing command on the box. Its default layout plays whenever no schedule rule matches.</p>
      <div className="card" style={{ padding: 0 }}>
        {players.data && players.data.length === 0 ? <Empty>No players yet. Create one and pair the box.</Empty> : (
          <table>
            <thead><tr><th>Name</th><th>Status</th><th>Default layout</th><th>Playing</th><th>Output</th><th>Health</th><th>Last seen</th><th></th></tr></thead>
            <tbody>{(players.data || []).map((p) => {
              const st = p.status || {};
              return (
                <tr key={p.id} className={'clickable' + (selected && selected.id === p.id ? ' selected' : '')} onClick={() => nav(`/players/${p.id}`)}>
                  <td><b>{p.name}</b>{p.version ? <div className="muted small">v{p.version}</div> : null}</td>
                  <td><Status online={!!p.online} /></td>
                  <td>{layoutName(p.default_layout_id) || <span className="muted">—</span>}</td>
                  <td className="muted">{playingName(p) || '—'}</td>
                  <td className="muted small">{p.resolution || '—'}{p.output ? <div>{p.output.address}:{p.output.port}</div> : null}</td>
                  <td className="muted small">{st.fps != null ? `${Math.round(st.fps)} fps` : ''}{cpuText(st) ? ` · ${cpuText(st)}` : ''}{st.restarts_last_hour ? <span className="warn"> · {st.restarts_last_hour} restarts/h</span> : null}</td>
                  <td className="muted small">{timeAgo(p.last_seen_at)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}><button className="sm" onClick={() => nav(`/players/${p.id}`)}>Open</button> <button className="sm danger" onClick={() => setRemoving(p)}>Delete</button></td>
                </tr>);
            })}</tbody>
          </table>)}
      </div>
      {creating && <PlayerModal layouts={layouts.data || []} onSave={create} onClose={() => setCreating(false)} />}
      {created && <KeyModal title={`${(created.player || created).name || 'Player'} created`} result={created} onClose={() => setCreated(null)} />}
      {removing && <Confirm title="Delete player" text={`Delete "${removing.name}"? The box keeps running its last content until re-paired.`} onConfirm={remove} onClose={() => setRemoving(null)} />}
      {selected && <PlayerDrawer siteId={siteId} player={selected} layouts={layouts.data || []} onClose={() => nav('/players')} onChanged={players.reload} />}
    </>
  );
}

const OUTPUT_DEFAULTS = { address: '239.1.1.10', port: 1234, ttl: 4, fps: 30, video_codec: 'mpeg2', video_bitrate_kbps: 8000, audio_codec: 'mp2', audio_bitrate_kbps: 192, mux_rate_kbps: 10000, service_name: 'In-House' };

function PlayerModal({ player, layouts, onSave, onClose }) {
  const [f, setF] = useState({ name: (player && player.name) || '', resolution: (player && player.resolution) || '1280x720', default_layout_id: (player && player.default_layout_id) || null });
  // Output settings: empty = not managed by the CMS (the box keeps its own player.conf).
  const [managed, setManaged] = useState(!!(player && player.settings && Object.keys(player.settings).length));
  const [o, setO] = useState({ ...OUTPUT_DEFAULTS, ...((player && player.output) || {}), ...((player && player.settings) || {}) });
  const num = (k) => (e) => setO({ ...o, [k]: e.target.value === '' ? '' : Number(e.target.value) });
  const str = (k) => (e) => setO({ ...o, [k]: e.target.value });
  const muxLow = Number(o.mux_rate_kbps) <= Number(o.video_bitrate_kbps) + Number(o.audio_bitrate_kbps || 192);
  const save = () => {
    const body = { ...f, name: f.name.trim() };
    if (managed) { const { resolution, ...rest } = o; body.settings = rest; } else if (player && player.settings) body.settings = null;
    onSave(body);
  };
  return (
    <Modal title={player ? `Edit ${player.name}` : 'New player'} onClose={onClose} wide footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={!f.name.trim() || (managed && muxLow)} onClick={save}>{player ? 'Save' : 'Create'}</button></>}>
      <Field label="Name" hint="e.g. “test modulator”, “Lobby channel”"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus aria-label="Player name" /></Field>
      <div className="row">
        <Field label="Resolution" hint="720p is the measured default for a busy box; 1080p needs headroom."><select value={f.resolution} onChange={(e) => setF({ ...f, resolution: e.target.value })} aria-label="Resolution">{RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>
        <Field label="Default layout"><select value={f.default_layout_id || ''} onChange={(e) => setF({ ...f, default_layout_id: e.target.value ? Number(e.target.value) : null })} aria-label="Default layout"><option value="">— none (built-in slate) —</option>{layouts.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
      </div>
      <h4 style={{ margin: '16px 0 4px' }}>Output</h4>
      <label className="inline" style={{ gap: 8, marginBottom: 8 }}><input type="checkbox" checked={managed} onChange={(e) => setManaged(e.target.checked)} aria-label="Manage output settings from the CMS" /> Manage output settings from here <span className="muted small">(otherwise the box keeps its own player.conf). A change restarts the encoder for a few seconds.</span></label>
      {managed && <>
        <div className="row">
          <Field label="Multicast address"><input value={o.address} onChange={str('address')} aria-label="Multicast address" /></Field>
          <Field label="UDP port"><input type="number" min="1" max="65535" value={o.port} onChange={num('port')} aria-label="UDP port" /></Field>
          <Field label="TTL"><input type="number" min="1" max="64" value={o.ttl} onChange={num('ttl')} aria-label="TTL" /></Field>
        </div>
        <div className="row">
          <Field label="Video codec"><select value={o.video_codec} onChange={str('video_codec')} aria-label="Video codec"><option value="mpeg2">MPEG-2 (universal)</option><option value="h264">H.264 (libx264, more CPU)</option></select></Field>
          <Field label="Video bitrate (kb/s)" hint="MPEG-2 CBR: 8000 at 720p, 12000 at 1080p"><input type="number" min="1000" max="30000" step="500" value={o.video_bitrate_kbps} onChange={num('video_bitrate_kbps')} aria-label="Video bitrate" /></Field>
          <Field label="Frame rate"><select value={o.fps} onChange={num('fps')} aria-label="Frame rate"><option value={30}>30</option><option value={25}>25</option></select></Field>
        </div>
        <div className="row">
          <Field label="Audio codec"><select value={o.audio_codec} onChange={str('audio_codec')} aria-label="Audio codec"><option value="mp2">MP2</option><option value="aac">AAC</option></select></Field>
          <Field label="Audio bitrate (kb/s)"><input type="number" min="64" max="384" step="32" value={o.audio_bitrate_kbps} onChange={num('audio_bitrate_kbps')} aria-label="Audio bitrate" /></Field>
          <Field label="Mux rate (kb/s)" hint={muxLow ? 'must exceed video + audio bitrate' : 'total TS rate the modulator sees (CBR with null padding)'}><input type="number" min="1500" max="40000" step="500" value={o.mux_rate_kbps} onChange={num('mux_rate_kbps')} aria-label="Mux rate" style={muxLow ? { borderColor: '#e55' } : undefined} /></Field>
        </div>
        <Field label="Service name" hint="shown by STBs / modulators in the channel list"><input maxLength={32} value={o.service_name} onChange={str('service_name')} aria-label="Service name" /></Field>
      </>}
    </Modal>
  );
}

// The key is shown exactly once (the server stores only a hash).
export function KeyModal({ title, result, onClose }) {
  const key = result.key;
  const pair = result.pair || result.pair_command || `inhousechannel-player pair ${location.origin} ${key}`;
  return (
    <Modal title={title} onClose={onClose} wide footer={<button className="primary" onClick={onClose}>Done</button>}>
      <p className="warn-box">This key is shown <b>once</b>. Copy it now — if it is lost, rotate the key to get a new one.</p>
      <Field label="Player key"><div className="inline"><code className="keybox" data-testid="player-key">{key}</code><CopyButton text={key} label="Copy key" /></div></Field>
      <Field label="Pair the box" hint="Run this as root on the hotel box; it writes the [server] section of player.conf and restarts the service."><div className="inline"><code className="keybox">{pair}</code><CopyButton text={pair} label="Copy command" /></div></Field>
    </Modal>
  );
}

function PlayerDrawer({ siteId, player, layouts, onClose, onChanged }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [rotated, setRotated] = useState(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const st = player.status || {};
  async function save(form) {
    try { await patch(`/sites/${siteId}/players/${player.id}`, form); toast('Saved'); setEditing(false); onChanged(); } catch (e) { toast(e.message, 'bad'); }
  }
  async function rotate() {
    try { const r = await post(`/sites/${siteId}/players/${player.id}/rotate-key`); setConfirmRotate(false); setRotated(r); } catch (e) { toast(e.message, 'bad'); setConfirmRotate(false); }
  }
  const layoutName = (lid) => { const l = layouts.find((x) => x.id === lid); return l ? l.name : '—'; };
  return (
    <Drawer title={player.name} subtitle={<Status online={!!player.online} />} onClose={onClose} width="min(760px, 96vw)">
      <div className="inline" style={{ gap: 16, alignItems: 'flex-start' }}>
        <div className="player-thumb drawer-thumb">{player.thumbnail_url ? <img src={player.thumbnail_url} alt="now playing" /> : <div className="muted small">no thumbnail yet</div>}</div>
        <dl className="kv" style={{ margin: 0, flex: 1 }}>
          <dt>Default layout</dt><dd>{layoutName(player.default_layout_id)}</dd>
          <dt>Playing now</dt><dd>{playingName(player) || <span className="muted">—</span>}</dd>
          <dt>Resolution</dt><dd>{player.resolution || '—'}</dd>
          <dt>Version</dt><dd>{player.version || '—'}</dd>
          <dt>Output</dt><dd>{player.output ? `${player.output.address}:${player.output.port} · ${player.output.resolution || ''} ${player.output.video_codec || ''} ${player.output.video_bitrate_kbps ? player.output.video_bitrate_kbps + ' kb/s' : ''} · mux ${player.output.mux_rate_kbps || '?'} kb/s` : <span className="muted">not reported yet</span>}{player.settings && Object.keys(player.settings).length ? <div className="muted small">managed from the CMS{player.output && Object.keys(player.settings).some((k) => String(player.settings[k]) !== String(player.output[k])) ? ' — box has not applied the latest settings yet' : ' — applied'}</div> : <div className="muted small">as set in the box's player.conf</div>}</dd>
          <dt>Health</dt><dd>{st.fps != null ? `${Math.round(st.fps)} fps` : '—'}{cpuText(st) ? ` · CPU ${cpuText(st)}` : ''}{st.bitrate_kbps != null ? ` · ${(st.bitrate_kbps / 1000).toFixed(1)} Mb/s` : ''}{st.uptime_s != null ? ` · up ${fmtUptime(st.uptime_s)}` : ''}{st.restarts_last_hour ? ` · ${st.restarts_last_hour} restarts in the last hour` : ''}</dd>
          <dt>Last heartbeat</dt><dd>{timeAgo(player.last_seen_at)}</dd>
        </dl>
      </div>
      <div className="actions" style={{ marginTop: 12 }}>
        <button onClick={() => setEditing(true)}>Edit</button>
        <button onClick={() => setConfirmRotate(true)}>Rotate key</button>
      </div>
      <div className="section">
        <Schedules siteId={siteId} player={player} layouts={layouts} />
      </div>
      {editing && <PlayerModal player={player} layouts={layouts} onSave={save} onClose={() => setEditing(false)} />}
      {confirmRotate && <Confirm title="Rotate key" danger={false} confirmLabel="Rotate" text="The old key stops working immediately; the box must be paired again with the new one." onConfirm={rotate} onClose={() => setConfirmRotate(false)} />}
      {rotated && <KeyModal title="New key" result={rotated} onClose={() => setRotated(null)} />}
    </Drawer>
  );
}

// ---------------------------------------------------------------- schedules
const EMPTY_RULE = { layout_id: null, priority: 10, days_mask: ALL_DAYS, start_time: '00:00', end_time: '23:59', start_date: null, end_date: null, enabled: true };

export function Schedules({ siteId, player, layouts }) {
  const toast = useToast();
  const base = `/sites/${siteId}/players/${player.id}/schedules`;
  const rules = useAsync(() => get(base), [base]);
  const [editing, setEditing] = useState(null);   // {} new | rule
  const [removing, setRemoving] = useState(null);
  async function save(rule) {
    try {
      if (rule.id) await put(`${base}/${rule.id}`, rule); else await post(base, rule);
      toast('Schedule saved'); setEditing(null); rules.reload();
    } catch (e) { toast(e.message, 'bad'); }
  }
  async function toggle(r) { try { await put(`${base}/${r.id}`, { enabled: !r.enabled }); rules.reload(); } catch (e) { toast(e.message, 'bad'); } }
  async function remove() { try { await del(`${base}/${removing.id}`); setRemoving(null); rules.reload(); } catch (e) { toast(e.message, 'bad'); } }
  const layoutName = (lid) => { const l = layouts.find((x) => x.id === lid); return l ? l.name : `layout ${lid}`; };
  const sorted = (rules.data || []).slice().sort((a, b) => (b.priority - a.priority) || (a.id - b.id));
  return (
    <>
      <div className="inline" style={{ justifyContent: 'space-between', width: '100%' }}><h2 style={{ margin: 0 }}>Schedule</h2><button className="sm primary" onClick={() => setEditing({ ...EMPTY_RULE, layout_id: layouts[0] ? layouts[0].id : null })} disabled={!layouts.length}>Add rule</button></div>
      <p className="muted small">The highest-priority enabled rule whose days, time window and date range match plays; otherwise the default layout. Times are in the site's time zone, evaluated on the box so it keeps scheduling offline.</p>
      {rules.data && rules.data.length === 0 ? <Empty>No rules — the default layout plays all day.</Empty> : (
        <table className="small">
          <thead><tr><th>On</th><th>Layout</th><th>Days</th><th>Time</th><th>Dates</th><th className="num">Priority</th><th></th></tr></thead>
          <tbody>{sorted.map((r) => (
            <tr key={r.id} className={r.enabled ? '' : 'disabled-row'}>
              <td><input type="checkbox" checked={!!r.enabled} onChange={() => toggle(r)} aria-label={`enable rule ${r.id}`} /></td>
              <td><b>{layoutName(r.layout_id)}</b></td>
              <td>{daysText(r.days_mask)}</td>
              <td className="mono">{r.start_time}–{r.end_time}</td>
              <td className="muted">{r.start_date || r.end_date ? `${r.start_date || '…'} → ${r.end_date || '…'}` : 'always'}</td>
              <td className="num">{r.priority}</td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}><button className="sm" onClick={() => setEditing(r)}>Edit</button> <button className="sm danger" onClick={() => setRemoving(r)}>Delete</button></td>
            </tr>))}</tbody>
        </table>)}
      {editing && <RuleModal rule={editing} layouts={layouts} onSave={save} onClose={() => setEditing(null)} />}
      {removing && <Confirm title="Delete rule" text="Delete this schedule rule?" onConfirm={remove} onClose={() => setRemoving(null)} />}
    </>
  );
}

function RuleModal({ rule, layouts, onSave, onClose }) {
  const [f, setF] = useState({ ...EMPTY_RULE, ...rule, days_mask: rule.days_mask ?? ALL_DAYS });
  const ok = f.layout_id && /^\d\d:\d\d$/.test(f.start_time) && /^\d\d:\d\d$/.test(f.end_time) && f.days_mask > 0;
  const out = () => ({ id: f.id, layout_id: Number(f.layout_id), priority: Number(f.priority) || 0, days_mask: f.days_mask, start_time: f.start_time, end_time: f.end_time, start_date: f.start_date || null, end_date: f.end_date || null, enabled: !!f.enabled });
  return (
    <Modal title={rule.id ? 'Edit schedule rule' : 'New schedule rule'} onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={!ok} onClick={() => onSave(out())}>Save</button></>}>
      <Field label="Layout"><select value={f.layout_id || ''} onChange={(e) => setF({ ...f, layout_id: Number(e.target.value) })} aria-label="Rule layout">{layouts.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
      <Field label="Days">
        <div className="daypick" role="group" aria-label="Days">
          {DAY_LABELS.map((d, i) => <label key={d} className={dayOn(f.days_mask, i) ? 'on' : ''}><input type="checkbox" checked={!!dayOn(f.days_mask, i)} onChange={() => setF({ ...f, days_mask: toggleDay(f.days_mask, i) })} aria-label={d} />{d}</label>)}
          <button type="button" className="sm ghost" onClick={() => setF({ ...f, days_mask: ALL_DAYS })}>all</button>
          <button type="button" className="sm ghost" onClick={() => setF({ ...f, days_mask: 31 })}>weekdays</button>
        </div>
      </Field>
      <div className="row">
        <Field label="From"><input type="time" value={f.start_time} onChange={(e) => setF({ ...f, start_time: e.target.value })} aria-label="Start time" /></Field>
        <Field label="Until"><input type="time" value={f.end_time} onChange={(e) => setF({ ...f, end_time: e.target.value })} aria-label="End time" /></Field>
        <Field label="Priority" hint="higher wins"><input type="number" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} aria-label="Priority" /></Field>
      </div>
      <div className="row">
        <Field label="Start date (optional)"><input type="date" value={f.start_date || ''} onChange={(e) => setF({ ...f, start_date: e.target.value || null })} aria-label="Start date" /></Field>
        <Field label="End date (optional)"><input type="date" value={f.end_date || ''} onChange={(e) => setF({ ...f, end_date: e.target.value || null })} aria-label="End date" /></Field>
      </div>
      <label className="inline" style={{ color: 'var(--text)' }}><input type="checkbox" checked={!!f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} aria-label="Enabled" /> enabled</label>
    </Modal>
  );
}
