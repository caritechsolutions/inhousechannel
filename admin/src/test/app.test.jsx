import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../App.jsx';

const SITES = [{ id: 1, name: 'The Nothing Box', slug: 'nothingbox', timezone: 'America/Barbados', role: 'admin' }, { id: 2, name: 'Blue Monkey', slug: 'bluemonkey', timezone: 'America/Barbados', role: 'admin' }];
const MY_SITES = [{ id: 1, name: 'The Nothing Box', slug: 'nothingbox', timezone: 'America/Barbados', role: 'editor' }];

// Fake /api/admin backend mirroring server/src/routes/admin.js: /me and /login answer
// { user, sites } (a superadmin's /login has sites: null), /dashboard groups players by site,
// POST /players answers { ...player, key, pair }.
export function fakeApi({ superadmin = true } = {}) {
  const user = superadmin
    ? { id: 1, email: 'richard@example.com', is_superadmin: true }
    : { id: 2, email: 'editor@example.com', is_superadmin: false };
  const sites = superadmin ? SITES : MY_SITES;
  const state = {
    me: null,
    sites,
    players: [{ id: 7, site_id: 1, name: 'test modulator', online: true, last_seen_at: new Date().toISOString(), version: '0.1.0', resolution: '1280x720', current_layout_id: 3, current_layout_name: 'Lobby', thumbnail_url: null, default_layout_id: 3, status: { cpu_pct: 61, fps: 30, bitrate_kbps: 10000, restarts_last_hour: 0, uptime_s: 86400 * 2 + 3600 } }],
    layouts: [{ id: 3, name: 'Lobby', updated_at: '2026-10-28 12:00:00', json: { schema: 2, canvas: { w: 1920, h: 1080 }, zones: [], pages: [{ id: 'page1', name: 'Page 1', zones: [], duration_s: 15 }] } }],
    schedules: [],
    calls: [],
  };
  const json = (status, body) => Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)) });
  global.fetch = vi.fn((url, init = {}) => {
    const path = url.replace(/^\/api\/admin/, '');
    const method = init.method || 'GET';
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    state.calls.push([method, path, body]);
    if (path === '/me') return state.me ? json(200, state.me) : json(401, { error: 'not logged in' });
    if (path === '/login') {
      if (body.password !== 'secret') return json(401, { error: 'invalid email or password' });
      state.me = { user, sites }; return json(200, { user, sites: superadmin ? null : sites });
    }
    if (path === '/logout') { state.me = null; return json(200, { ok: true }); }
    if (path === '/sites' && method === 'GET') return json(200, sites);
    if (path === '/dashboard') return json(200, { sites: sites.map((s) => ({ ...s, players: state.players.filter((p) => p.site_id === s.id), counts: {} })), time: new Date().toISOString() });
    if (path === '/sites/1/players' && method === 'GET') return json(200, state.players);
    if (path === '/sites/1/players' && method === 'POST') {
      const p = { id: 8, site_id: 1, name: body.name, resolution: body.resolution, default_layout_id: null, online: false, last_seen_at: null, status: null };
      state.players.push(p);
      return json(201, { ...p, key: 'k_0123456789abcdef', pair: 'inhousechannel-player pair https://signage.caritech.net k_0123456789abcdef' });
    }
    if (path === '/sites/1/layouts' && method === 'GET') return json(200, state.layouts);
    if (path === '/sites/1/players/7/schedules') return json(200, state.schedules);
    if (path === '/sites/1/media') return json(200, []);
    return json(404, { error: 'not found ' + path });
  });
  return state;
}

function renderApp(path = '/') {
  return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
}

describe('admin app', () => {
  let state;
  beforeEach(() => { state = fakeApi(); try { localStorage.clear(); } catch { /* jsdom */ } });

  it('shows login when logged out, rejects a bad password, then logs in to the dashboard', async () => {
    renderApp('/');
    await screen.findByLabelText('Email');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'richard@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByText('Sign in'));
    expect((await screen.findByRole('alert')).textContent).toContain('invalid email or password');
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByText('Sign in'));
    expect(await screen.findByText('players')).toBeTruthy();
    // player card
    const card = await screen.findByTestId('player-card');
    expect(within(card).getByText('test modulator')).toBeTruthy();
    expect(within(card).getByText('30 fps')).toBeTruthy();
    expect(within(card).getByText('61 % CPU')).toBeTruthy();
    expect(within(card).getByText('Lobby')).toBeTruthy();
    // superadmin sees the site switcher with every site, and the superadmin nav
    const sw = await screen.findByLabelText('Site');
    expect(within(sw).getAllByRole('option').map((o) => o.textContent)).toEqual(['The Nothing Box', 'Blue Monkey']);
    expect(screen.getByText('Sites')).toBeTruthy(); expect(screen.getByText('Users')).toBeTruthy();
    expect(state.calls.some(([m, p, b]) => m === 'POST' && p === '/login' && b.email === 'richard@example.com')).toBe(true);
  });

  it('non-superadmin never sees Sites/Users and gets only their own sites', async () => {
    state = fakeApi({ superadmin: false });
    state.me = { user: { id: 2, email: 'editor@example.com', is_superadmin: false }, sites: MY_SITES };
    renderApp('/');
    await screen.findByTestId('player-card');
    expect(screen.queryByText('Sites')).toBeNull(); expect(screen.queryByText('Users')).toBeNull();
    expect(within(screen.getByLabelText('Site')).getAllByRole('option').map((o) => o.textContent)).toEqual(['The Nothing Box']);
    expect(screen.getByText(/editor · The Nothing Box/)).toBeTruthy();
  });

  it('creates a player and shows the key once with the pair command', async () => {
    state.me = { user: { id: 1, email: 'richard@example.com', is_superadmin: true }, sites: SITES };
    renderApp('/players');
    expect(await screen.findByText('test modulator')).toBeTruthy();
    fireEvent.click(screen.getByText('New player'));
    fireEvent.change(await screen.findByLabelText('Player name'), { target: { value: 'Lobby channel' } });
    fireEvent.click(screen.getByText('Create'));
    expect((await screen.findByTestId('player-key')).textContent).toBe('k_0123456789abcdef');
    expect(screen.getByText(/inhousechannel-player pair/)).toBeTruthy();
    expect(screen.getByLabelText('Copy key')).toBeTruthy();
    expect(screen.getByText(/shown/).textContent).toMatch(/once/);
    await waitFor(() => expect(state.calls.some(([m, p, b]) => m === 'POST' && p === '/sites/1/players' && b.name === 'Lobby channel' && b.resolution === '1280x720')).toBe(true));
  });
});
