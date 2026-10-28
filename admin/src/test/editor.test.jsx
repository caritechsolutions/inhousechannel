import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TEMPLATES from '../../../shared/layout-templates.json';
import { ToastProvider } from '../components/ui.jsx';
import { SessionCtx } from '../App.jsx';
import { Editor } from '../pages/LayoutEdit.jsx';
import PageNavigator from '../editor/PageNavigator.jsx';
import ZonePanel from '../editor/ZonePanel.jsx';
import { ensurePages } from '../editor/geometry.js';

const site = { id: 1, name: 'The Nothing Box', slug: 'nothingbox', role: 'admin' };
const session = { user: { id: 1, email: 'r@x', is_superadmin: true }, sites: [site], site, setSite() {}, isSuper: true, refresh() {}, refreshSites() {}, logout() {} };

function fakeApi(layout) {
  const calls = [];
  const json = (status, body) => Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)) });
  global.fetch = vi.fn((url, init = {}) => {
    const path = url.replace(/^\/api\/admin/, ''); const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push([method, path, body]);
    if (path === '/sites/1/layouts/5' && method === 'GET') return json(200, layout);
    if (path === '/sites/1/layouts/5' && method === 'PUT') { Object.assign(layout, body); return json(200, { ...layout, players: [] }); }
    if (path === '/sites/1/media') return json(200, []);
    return json(404, { error: 'not found ' + path });
  });
  return calls;
}
const renderEditor = () => render(<MemoryRouter><SessionCtx.Provider value={session}><ToastProvider><Editor siteId={1} site={site} id="5" /></ToastProvider></SessionCtx.Provider></MemoryRouter>);

describe('layout editor', () => {
  let layout, calls;
  beforeEach(() => {
    const tpl = TEMPLATES[0];
    layout = { id: 5, name: 'Lobby', json: JSON.parse(JSON.stringify(tpl.json)), updated_at: '2026-10-28 12:00:00' };
    calls = fakeApi(layout);
  });

  it('renders a template: pages with durations, palette without TV items, zones on the canvas', async () => {
    renderEditor();
    expect(await screen.findByLabelText('Layout canvas')).toBeTruthy();
    const d = ensurePages(layout.json);
    // every page is listed with its duration field
    for (const p of d.pages) {
      expect(screen.getByLabelText(`page ${p.name || p.id}`)).toBeTruthy();
      expect(screen.getByTestId(`duration-${p.id}`).value).toBe(String(p.duration_s));
    }
    // first page's zones are drawn
    const first = d.pages[0];
    for (const zid of first.zones) expect(document.querySelector(`[data-zone="${zid}"]`)).toBeTruthy();
    // palette = signage types only
    const pal = screen.getByLabelText('Zone palette');
    expect(within(pal).getByLabelText('add Ticker')).toBeTruthy();
    expect(within(pal).getByLabelText('add Slideshow')).toBeTruthy();
    expect(within(pal).getByLabelText('add QR code')).toBeTruthy();
    expect(within(pal).queryByText(/Menu|Button|Channel list|Live TV|INFO banner|App/)).toBeNull();
    // the layout panel has no focus ring / remote keys
    expect(screen.queryByText('Focus ring')).toBeNull(); expect(screen.queryByText('Remote keys')).toBeNull();
    expect(screen.getByLabelText('Page duration')).toBeTruthy();
  });

  it('changing a page duration marks the document dirty and is saved with PUT', async () => {
    renderEditor();
    await screen.findByLabelText('Layout canvas');
    const d = ensurePages(layout.json);
    const pid = d.pages[0].id;
    fireEvent.change(screen.getByTestId(`duration-${pid}`), { target: { value: '42' } });
    expect(screen.getByTestId(`duration-${pid}`).value).toBe('42');
    expect(screen.getByText(/42 s loop|s loop/).textContent).toContain('s loop');
    const save = screen.getByText('Save & publish');
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(calls.some(([m, p, b]) => m === 'PUT' && p === '/sites/1/layouts/5' && b.json.pages[0].duration_s === 42)).toBe(true));
  });

  it('adds a ticker from the palette, edits it in the typed panel, Ctrl-D duplicates, Delete removes, undo restores', async () => {
    renderEditor();
    await screen.findByLabelText('Layout canvas');
    const before = document.querySelectorAll('.czone').length;
    fireEvent.click(screen.getByLabelText('add Ticker'));
    // a new ticker is selected → the ticker panel shows speed
    expect(screen.getByLabelText('Speed')).toBeTruthy();
    expect(document.querySelectorAll('.czone').length).toBe(before + 1);
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
    expect(document.querySelectorAll('.czone').length).toBe(before + 2);
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(document.querySelectorAll('.czone').length).toBe(before + 1);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(document.querySelectorAll('.czone').length).toBe(before + 2);
  });

  it('only one video zone: the palette item is disabled once one exists and the panel warns', async () => {
    renderEditor();
    await screen.findByLabelText('Layout canvas');
    const item = screen.getByLabelText('add Video clips');
    fireEvent.click(item);
    expect(document.querySelector('.panel .warn-box').textContent).toMatch(/one video zone is allowed/i);
    expect(screen.getByLabelText('add Video clips').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByLabelText('add Video clips'));
    expect(document.querySelectorAll('.czone.t-video').length).toBe(1);
  });
});

describe('PageNavigator', () => {
  it('shows each page with its duration_s and edits it', () => {
    const doc = { schema: 2, canvas: { w: 1920, h: 1080 }, zones: [], pages: [{ id: 'a', name: 'Welcome', zones: [], duration_s: 10 }, { id: 'b', name: 'Dining', zones: [], duration_s: 25 }] };
    const onChange = vi.fn();
    render(<PageNavigator doc={doc} pageId="a" onSelect={() => {}} onChange={onChange} />);
    expect(screen.getByTestId('duration-a').value).toBe('10');
    expect(screen.getByTestId('duration-b').value).toBe('25');
    expect(screen.getByText(/one loop = 35 s/)).toBeTruthy();
    fireEvent.change(screen.getByTestId('duration-b'), { target: { value: '5' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ pages: [doc.pages[0], { ...doc.pages[1], duration_s: 5 }] }));
  });
});

describe('ZonePanel', () => {
  const base = { schema: 2, canvas: { w: 1920, h: 1080 }, pages: [{ id: 'p', name: 'P', zones: ['z'], duration_s: 15 }] };
  const panel = (zone) => {
    const doc = { ...base, zones: [zone] };
    const onChange = vi.fn();
    render(<MemoryRouter><SessionCtx.Provider value={session}><ToastProvider><ZonePanel doc={doc} selectedIds={['z']} onChange={onChange} onSelect={() => {}} pageId="p" /></ToastProvider></SessionCtx.Provider></MemoryRouter>);
    return onChange;
  };
  it('has typed fields per signage type', () => {
    panel({ id: 'z', type: 'text', x: 0, y: 0, w: 10, h: 10, text: 'hi' });
    expect(screen.getByLabelText('Insert variable')).toBeTruthy(); expect(screen.getByLabelText('Font')).toBeTruthy();
    document.body.innerHTML = '';
    panel({ id: 'z', type: 'weather', x: 0, y: 0, w: 10, h: 10 });
    expect(screen.getByLabelText('Latitude')).toBeTruthy(); expect(screen.getByLabelText('Longitude')).toBeTruthy(); expect(screen.getByLabelText('Units')).toBeTruthy();
    document.body.innerHTML = '';
    panel({ id: 'z', type: 'qr', x: 0, y: 0, w: 10, h: 10 });
    expect(screen.getByLabelText('QR data')).toBeTruthy(); expect(screen.getByLabelText('QR foreground')).toBeTruthy();
    document.body.innerHTML = '';
    panel({ id: 'z', type: 'shape', x: 0, y: 0, w: 10, h: 10, shape: 'rect' });
    expect(screen.getByLabelText('Shape kind')).toBeTruthy(); expect(screen.getByLabelText('Fill')).toBeTruthy(); expect(screen.getByLabelText('Shape radius')).toBeTruthy();
    document.body.innerHTML = '';
    panel({ id: 'z', type: 'html', x: 0, y: 0, w: 10, h: 10 });
    expect(screen.getByLabelText('Web page URL')).toBeTruthy();
    document.body.innerHTML = '';
    panel({ id: 'z', type: 'slideshow', x: 0, y: 0, w: 10, h: 10, images: [] });
    expect(screen.getByLabelText('Interval')).toBeTruthy(); expect(screen.getByLabelText('Add images…')).toBeTruthy();
    document.body.innerHTML = '';
    panel({ id: 'z', type: 'date', x: 0, y: 0, w: 10, h: 10 });
    expect(screen.getByLabelText('Date format')).toBeTruthy();
  });
  it('ticker lines are stored as items and the variable menu inserts {{site}}', () => {
    const onChange = panel({ id: 'z', type: 'ticker', x: 0, y: 0, w: 10, h: 10, items: ['a'] });
    fireEvent.click(screen.getByText('Add line'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ zones: [expect.objectContaining({ items: ['a', ''] })] }));
    document.body.innerHTML = '';
    const onChange2 = panel({ id: 'z', type: 'text', x: 0, y: 0, w: 10, h: 10, text: '' });
    fireEvent.change(screen.getByLabelText('Insert variable'), { target: { value: 'site' } });
    expect(onChange2).toHaveBeenCalledWith(expect.objectContaining({ zones: [expect.objectContaining({ text: '{{site}}' })] }));
  });
});

describe('media references', () => {
  it('stores library picks as media:<id> and resolves them to admin URLs only for display', async () => {
    const { mediaRef, mediaUrl, isMediaRef } = await import('../mediaUrl.js');
    expect(mediaRef({ id: 7, url: '/api/admin/sites/1/media/7/file' })).toBe('media:7');
    expect(mediaRef({ id: null, url: 'https://x/y.png' })).toBe('https://x/y.png');
    expect(isMediaRef('media:7')).toBe(true); expect(isMediaRef('https://x')).toBe(false);
    expect(mediaUrl('media:7', 1)).toBe('/api/admin/sites/1/media/7/file');
    expect(mediaUrl('media:7', 1, { thumb: true })).toBe('/api/admin/sites/1/media/7/thumb');
    expect(mediaUrl('https://x/y.png', 1)).toBe('https://x/y.png');
    expect(mediaUrl('{{logo}}', 1)).toBe('{{logo}}');
  });
});
