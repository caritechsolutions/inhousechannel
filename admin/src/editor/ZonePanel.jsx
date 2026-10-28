import React, { useState, useRef } from 'react';
import { Field } from '../components/ui.jsx';
import MediaPicker from '../components/MediaPicker.jsx';
import { mediaRef, isMediaRef, useMediaUrl } from '../mediaUrl.js';
import { ZONE_TYPES, VARIABLES, FONTS, SHADOW_OPTIONS, TYPE_LABELS, SINGLETON_TYPES, updateZone, renameZone, pageById, isOnPage, toggleZoneInPage, renamePage, setPageDuration, DEFAULT_PAGE_DURATION_S } from './geometry.js';

const num = (v) => (v === '' || v == null ? undefined : Number(v));

// ---------------------------------------------------------------- typed style controls
export function ColorInput({ value, onChange, label }) {
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : /^#[0-9a-f]{3}$/i.test(value) ? '#' + value.slice(1).split('').map((c) => c + c).join('') : '#ffffff';
  return <div className="inline"><input type="color" value={hex} onChange={(e) => onChange(e.target.value)} style={{ width: 44, padding: 2, flex: 'none' }} aria-label={label ? label + ' swatch' : undefined} /><input value={value || ''} onChange={(e) => onChange(e.target.value)} aria-label={label} placeholder="#rrggbb or rgba(…)" /></div>;
}
function Slider({ value, onChange, min, max, step = 1, label, fallback }) {
  const v = value ?? fallback ?? min;
  return <div className="inline slider"><input type="range" min={min} max={max} step={step} value={v} onChange={(e) => onChange(Number(e.target.value))} aria-label={label + ' slider'} /><input type="number" min={min} max={max} step={step} value={value ?? ''} placeholder={String(fallback ?? '')} onChange={(e) => onChange(num(e.target.value))} aria-label={label} style={{ width: 70, flex: 'none' }} /></div>;
}
function Segmented({ value, onChange, options, label }) {
  return <div className="segmented" role="radiogroup" aria-label={label}>{options.map(([v, text, title]) => <button key={v} type="button" className={value === v ? 'active' : ''} role="radio" aria-checked={value === v} title={title || text} onClick={() => onChange(v)}>{text}</button>)}</div>;
}
export function FontPicker({ value, onChange }) {
  return <select value={value || ''} onChange={(e) => onChange(e.target.value || undefined)} aria-label="Font" style={{ fontFamily: value ? `"${value}", sans-serif` : undefined }}>
    {FONTS.map((f) => <option key={f.family} value={f.family} style={{ fontFamily: f.family ? `"${f.family}", sans-serif` : undefined }}>{f.label}</option>)}
  </select>;
}
function Check({ checked, onChange, label }) {
  return <label className="inline" style={{ color: 'var(--text)', fontSize: 13 }}><input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} /> {label}</label>;
}

export function StyleFields({ style = {}, onChange, fields }) {
  const set = (k, v) => onChange({ ...style, [k]: v === '' || v === undefined ? undefined : v });
  const has = (k) => fields.includes(k);
  return (
    <div className="stylefields">
      {(has('fontFamily') || has('fontSize')) && <div className="grid2">
        {has('fontFamily') && <Field label="Font"><FontPicker value={style.fontFamily} onChange={(v) => set('fontFamily', v)} /></Field>}
        {has('fontSize') && <Field label="Size"><Slider value={style.fontSize} onChange={(v) => set('fontSize', v)} min={12} max={240} label="Font size" fallback={28} /></Field>}
      </div>}
      {(has('fontWeight') || has('align') || has('valign')) && <div className="inline" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        {has('fontWeight') && <div className="segmented" role="group" aria-label="Emphasis">
          <button type="button" className={style.fontWeight === 'bold' ? 'active' : ''} aria-pressed={style.fontWeight === 'bold'} title="Bold" aria-label="Bold" onClick={() => set('fontWeight', style.fontWeight === 'bold' ? undefined : 'bold')}><b>B</b></button>
          <button type="button" className={style.fontStyle === 'italic' ? 'active' : ''} aria-pressed={style.fontStyle === 'italic'} title="Italic" aria-label="Italic" onClick={() => set('fontStyle', style.fontStyle === 'italic' ? undefined : 'italic')}><i>I</i></button>
        </div>}
        {has('align') && <Segmented label="Text alignment" value={style.align || 'left'} onChange={(v) => set('align', v === 'left' ? undefined : v)} options={[['left', '⫷', 'Align left'], ['center', '☰', 'Centre'], ['right', '⫸', 'Align right']]} />}
        {has('valign') && <Segmented label="Vertical alignment" value={style.valign || 'top'} onChange={(v) => set('valign', v === 'top' ? undefined : v)} options={[['top', '⤒', 'Top'], ['middle', '⇳', 'Middle'], ['bottom', '⤓', 'Bottom']]} />}
      </div>}
      <div className="grid2">
        {has('color') && <Field label="Colour"><ColorInput label="Colour" value={style.color || '#ffffff'} onChange={(v) => set('color', v)} /></Field>}
        {has('background') && <Field label="Background"><ColorInput label="Background" value={style.background || ''} onChange={(v) => set('background', v)} /></Field>}
        {has('padding') && <Field label="Padding"><Slider value={style.padding} onChange={(v) => set('padding', v)} min={0} max={120} label="Padding" fallback={0} /></Field>}
        {has('borderRadius') && <Field label="Corner radius"><Slider value={style.borderRadius} onChange={(v) => set('borderRadius', v)} min={0} max={200} label="Corner radius" fallback={0} /></Field>}
        {has('opacity') && <Field label="Opacity"><Slider value={style.opacity} onChange={(v) => set('opacity', v)} min={0} max={1} step={0.05} label="Opacity" fallback={1} /></Field>}
        {has('shadow') && <Field label="Text shadow"><select value={style.shadow || ''} onChange={(e) => set('shadow', e.target.value || undefined)} aria-label="Text shadow">{SHADOW_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>}
      </div>
    </div>
  );
}

// Text editor with a variables menu; Enter is a line break (the renderer keeps white-space).
function TextEditor({ zone, setZ, field = 'text', label = 'Text', rows = 4 }) {
  const ref = useRef(null);
  const insert = (v) => {
    const el = ref.current; const text = zone[field] || '';
    const s = el ? el.selectionStart : text.length, e = el ? el.selectionEnd : text.length;
    const next = text.slice(0, s) + `{{${v}}}` + text.slice(e);
    setZ({ [field]: next });
    if (el) requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = s + v.length + 4; });
  };
  return (
    <Field label={label} hint="Enter = new line. {{site}} is the site name, {{time}} and {{date}} tick every minute.">
      <div className="inline" style={{ marginBottom: 6 }}>
        <select value="" onChange={(e) => { if (e.target.value) insert(e.target.value); }} aria-label="Insert variable" style={{ flex: 'none' }}>
          <option value="">Insert variable…</option>{VARIABLES.filter((v) => v !== 'logo').map((v) => <option key={v} value={v}>{`{{${v}}}`}</option>)}
        </select>
      </div>
      <textarea ref={ref} value={zone[field] || ''} onChange={(e) => setZ({ [field]: e.target.value })} rows={rows} aria-label={label} style={{ fontFamily: zone.style && zone.style.fontFamily ? `"${zone.style.fontFamily}", sans-serif` : undefined, fontWeight: (zone.style && zone.style.fontWeight) || undefined, fontStyle: (zone.style && zone.style.fontStyle) || undefined }} />
    </Field>
  );
}

// Ordered list of strings (ticker lines).
function LinesEditor({ items, onChange, addLabel = 'Add line', placeholder = 'Line' }) {
  const set = (i, v) => onChange(items.map((it, j) => (j === i ? v : it)));
  const move = (i, d) => { const a = items.slice(); const [x] = a.splice(i, 1); a.splice(i + d, 0, x); onChange(a); };
  return (
    <div>
      {items.map((it, i) => (
        <div key={i} className="list-row">
          <input value={it || ''} placeholder={placeholder} onChange={(e) => set(i, e.target.value)} aria-label={`${placeholder} ${i + 1}`} />
          <button className="sm ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="up">↑</button>
          <button className="sm ghost" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="down">↓</button>
          <button className="sm ghost danger" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="remove">✕</button>
        </div>))}
      <button className="sm" onClick={() => onChange([...items, ''])}>{addLabel}</button>
    </div>
  );
}

// Ordered list of media picks ({src: "media:<id>" | url, name}) with thumbnails; slideshow + video.
function MediaList({ items, onChange, kind, addLabel }) {
  const [picking, setPicking] = useState(false);
  const resolve = useMediaUrl();
  const move = (i, d) => { const a = items.slice(); const [x] = a.splice(i, 1); a.splice(i + d, 0, x); onChange(a); };
  const label = (it) => it.name || (isMediaRef(it.src) ? it.src : (it.src || '').split('/').pop()) || 'media';
  return (
    <div>
      {items.map((it, i) => (
        <div key={i} className="list-row media-row">
          <span className="media-mini">{kind === 'image' && it.src ? <img src={resolve(it.src, { thumb: isMediaRef(it.src) })} alt="" /> : <span className="media-glyph" style={{ fontSize: 16 }}>▶</span>}</span>
          <span className="media-name" style={{ flex: 1 }} title={it.src}>{label(it)}</span>
          <button className="sm ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="up">↑</button>
          <button className="sm ghost" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="down">↓</button>
          <button className="sm ghost danger" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="remove">✕</button>
        </div>))}
      <button className="sm" onClick={() => setPicking(true)} aria-label={addLabel}>{addLabel}</button>
      {picking && <MediaPicker kind={kind} multiple onClose={() => setPicking(false)} onPick={(ms) => { onChange([...items, ...ms.map((m) => ({ src: mediaRef(m), name: m.name }))]); setPicking(false); }} />}
    </div>
  );
}

export default function ZonePanel({ doc, selectedIds = [], onChange, onSelect, pageId, errorsByZone = {} }) {
  const zone = selectedIds.length === 1 ? doc.zones.find((z) => z.id === selectedIds[0]) : null;
  const [picker, setPicker] = useState(null);   // 'image' | 'background'
  const resolve = useMediaUrl();
  const canvas = doc.canvas || {};
  const setZ = (patch) => onChange(updateZone(doc, zone.id, patch));
  const setStyle = (style) => setZ({ style });
  const page = pageById(doc, pageId);

  if (selectedIds.length > 1) {
    return <div className="panel"><h3>{selectedIds.length} zones selected</h3><p className="muted small">Use the toolbar to align, distribute, lock or delete them. Select one zone to edit its properties.</p></div>;
  }
  if (!zone) {
    return (
      <div className="panel">
        <h3>Layout</h3>
        <div className="grid2">
          <Field label="Background"><ColorInput label="Canvas background" value={canvas.background || '#0b1a2a'} onChange={(v) => onChange({ ...doc, canvas: { ...canvas, background: v } })} /></Field>
          <Field label="Background image" hint="media:<id> from the library, or a URL"><div className="inline"><input value={canvas.backgroundImage || ''} onChange={(e) => onChange({ ...doc, canvas: { ...canvas, backgroundImage: e.target.value || null } })} placeholder="none" aria-label="Background image URL" style={{ flex: 1 }} /><button className="sm" onClick={() => setPicker('background')} aria-label="Choose background image">Library…</button></div></Field>
        </div>
        {picker === 'background' && <MediaPicker title="Choose a background image" onClose={() => setPicker(null)} onPick={(m) => { onChange({ ...doc, canvas: { ...canvas, backgroundImage: mediaRef(m) || null } }); setPicker(null); }} />}
        <p className="muted small">Canvas is 1920×1080; a 720p player scales the whole page. Select a zone to edit it, or click the canvas background to come back here.</p>
        {page && <>
          <h3>This page</h3>
          <div className="grid2">
            <Field label="Page name"><input value={page.name || ''} onChange={(e) => onChange(renamePage(doc, page.id, e.target.value))} aria-label="Page name" /></Field>
            <Field label="Duration (seconds)" hint="How long this page stays on screen before the next one."><input type="number" min={1} value={page.duration_s ?? DEFAULT_PAGE_DURATION_S} onChange={(e) => onChange(setPageDuration(doc, page.id, e.target.value))} aria-label="Page duration" /></Field>
          </div>
          <p className="muted small">Page id <code>{page.id}</code> · {page.zones.length} zone(s). Pages play in order and loop.</p>
        </>}
      </div>
    );
  }

  const errs = errorsByZone[zone.id];
  const onThisPage = pageId ? isOnPage(doc, pageId, zone.id) : true;
  const typeChoices = ZONE_TYPES.filter((t) => t === zone.type || !(SINGLETON_TYPES.includes(t) && doc.zones.some((z) => z.type === t)));
  return (
    <div className="panel">
      <div className="inline" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>{TYPE_LABELS[zone.type] || zone.type}</h3>
        {zone.locked && <span className="pill">locked</span>}
      </div>
      {errs && <ul className="error small" role="status">{errs.map((e, i) => <li key={i}>{e}</li>)}</ul>}
      <div className="grid2">
        <Field label="Zone id"><input value={zone.id} onChange={(e) => { const nid = e.target.value.replace(/[^\w-]/g, ''); const d = renameZone(doc, zone.id, nid); if (d !== doc) { onChange(d); onSelect([nid]); } }} aria-label="Zone id" /></Field>
        <Field label="Type"><select value={zone.type} onChange={(e) => setZ({ type: e.target.value })} aria-label="Zone type">{typeChoices.map((t) => <option key={t} value={t}>{TYPE_LABELS[t] || t}</option>)}</select></Field>
      </div>
      <div className="grid4">
        {['x', 'y', 'w', 'h'].map((k) => <Field key={k} label={k.toUpperCase()}><input type="number" value={zone[k]} disabled={!!zone.locked} onChange={(e) => setZ({ [k]: Number(e.target.value) })} aria-label={k.toUpperCase()} /></Field>)}
      </div>
      <div className="inline" style={{ flexWrap: 'wrap', gap: 14, marginBottom: 10 }}>
        {pageId && <Check checked={onThisPage} onChange={() => onChange(toggleZoneInPage(doc, pageId, zone.id))} label={`on page "${page ? page.name || page.id : pageId}"`} />}
        <Check checked={!!zone.locked} onChange={(v) => setZ({ locked: v || undefined })} label="locked" />
      </div>

      {zone.type === 'text' && <>
        <TextEditor zone={zone} setZ={setZ} />
        <StyleFields style={zone.style} onChange={setStyle} fields={['fontFamily', 'fontSize', 'fontWeight', 'align', 'valign', 'color', 'background', 'padding', 'borderRadius', 'opacity', 'shadow']} />
      </>}

      {zone.type === 'image' && <>
        <Field label="Image" hint="Pick from the Media library (stored as media:<id>) or paste a URL. {{logo}} = the site logo."><div className="inline"><input value={zone.src || ''} onChange={(e) => setZ({ src: e.target.value })} aria-label="Image URL" style={{ flex: 1 }} /><button className="sm" onClick={() => setPicker('image')} aria-label="Choose image">Library…</button></div></Field>
        {zone.src && !/\{\{/.test(zone.src) && <div className="media-inline-preview"><img src={resolve(zone.src)} alt="" /></div>}
        {picker === 'image' && <MediaPicker allowUrl onClose={() => setPicker(null)} onPick={(m) => { setZ({ src: mediaRef(m) }); setPicker(null); }} />}
        <Field label="Fit"><Segmented label="Fit" value={zone.fit || 'contain'} onChange={(v) => setZ({ fit: v })} options={[['contain', 'contain'], ['cover', 'cover'], ['fill', 'stretch']]} /></Field>
        <StyleFields style={zone.style} onChange={setStyle} fields={['background', 'borderRadius', 'opacity']} />
      </>}

      {zone.type === 'slideshow' && <>
        <Field label="Images" hint="Shown in this order, looping.">
          <MediaList kind="image" addLabel="Add images…" items={(zone.images || []).map((src) => ({ src }))}
            onChange={(items) => setZ({ images: items.map((it) => it.src) })} />
        </Field>
        <div className="grid2">
          <Field label="Interval (seconds)"><Slider value={zone.interval_s} onChange={(v) => setZ({ interval_s: v })} min={1} max={120} label="Interval" fallback={8} /></Field>
          <Field label="Fit"><Segmented label="Slideshow fit" value={zone.fit || 'cover'} onChange={(v) => setZ({ fit: v })} options={[['contain', 'contain'], ['cover', 'cover'], ['fill', 'stretch']]} /></Field>
        </div>
        <div style={{ marginBottom: 10 }}><Check checked={zone.fade !== false} onChange={(v) => setZ({ fade: v })} label="fade between images (0.5 s, 30 fps stepped)" /></div>
        <StyleFields style={zone.style} onChange={setStyle} fields={['background', 'borderRadius', 'opacity']} />
      </>}

      {zone.type === 'video' && <>
        <p className="warn-box small">Only <b>one</b> video zone is allowed per layout. The page leaves this rectangle transparent: the player's ffmpeg decodes the clips and overlays them here, so the preview shows a hatched hole, not the video. Resizing keeps 16:9 (Alt = free).</p>
        <Field label="Clips" hint="Played in order from the Media library (videos must be “ready”, i.e. normalised).">
          <MediaList kind="video" addLabel="Add clips…" items={zone.playlist || []} onChange={(playlist) => setZ({ playlist: playlist.map(({ src, name }) => ({ src, name })) })} />
        </Field>
        <div className="inline" style={{ gap: 14, marginBottom: 10 }}>
          <Check checked={zone.loop !== false} onChange={(v) => setZ({ loop: v })} label="loop the playlist" />
          <Check checked={!!zone.mute} onChange={(v) => setZ({ mute: v })} label="mute (silent audio track instead of the clips' sound)" />
        </div>
      </>}

      {zone.type === 'ticker' && <>
        <Field label="Lines" hint="Scroll right-to-left, joined by the separator, looping. Variables work here too.">
          <LinesEditor items={Array.isArray(zone.items) && zone.items.length ? zone.items : zone.text ? [zone.text] : []} onChange={(items) => setZ({ items, text: undefined })} />
        </Field>
        <div className="grid2">
          <Field label="Speed (px/s)"><Slider value={zone.speed} onChange={(v) => setZ({ speed: v })} min={20} max={600} step={10} label="Speed" fallback={120} /></Field>
          <Field label="Separator"><input value={zone.separator ?? '   •   '} onChange={(e) => setZ({ separator: e.target.value })} aria-label="Separator" /></Field>
        </div>
        <StyleFields style={zone.style} onChange={setStyle} fields={['fontFamily', 'fontSize', 'fontWeight', 'color', 'background', 'padding', 'opacity', 'shadow']} />
      </>}

      {zone.type === 'clock' && <>
        <Field label="Format" hint="HH:mm, HH:mm:ss, hh:mm a. Literal text in [brackets]."><input value={zone.format || 'HH:mm'} onChange={(e) => setZ({ format: e.target.value })} aria-label="Clock format" /></Field>
        <StyleFields style={zone.style} onChange={setStyle} fields={['fontFamily', 'fontSize', 'fontWeight', 'align', 'valign', 'color', 'background', 'padding', 'borderRadius', 'shadow']} />
      </>}

      {zone.type === 'date' && <>
        <Field label="Format" hint="dddd D MMMM YYYY, ddd D MMM, DD/MM/YYYY. Literal text in [brackets]."><input value={zone.format || 'dddd D MMMM YYYY'} onChange={(e) => setZ({ format: e.target.value })} aria-label="Date format" /></Field>
        <StyleFields style={zone.style} onChange={setStyle} fields={['fontFamily', 'fontSize', 'fontWeight', 'align', 'valign', 'color', 'background', 'padding', 'borderRadius', 'shadow']} />
      </>}

      {zone.type === 'weather' && <>
        <div className="grid2">
          <Field label="Latitude"><input type="number" step="0.0001" value={zone.lat ?? ''} onChange={(e) => setZ({ lat: num(e.target.value) })} aria-label="Latitude" placeholder="13.1" /></Field>
          <Field label="Longitude"><input type="number" step="0.0001" value={zone.lon ?? ''} onChange={(e) => setZ({ lon: num(e.target.value) })} aria-label="Longitude" placeholder="-59.6" /></Field>
        </div>
        <div className="grid2">
          <Field label="Units"><Segmented label="Units" value={zone.units || 'metric'} onChange={(v) => setZ({ units: v })} options={[['metric', '°C'], ['imperial', '°F']]} /></Field>
          <Field label="Description"><Check checked={zone.showText !== false} onChange={(v) => setZ({ showText: v })} label="show “Partly cloudy” text" /></Field>
        </div>
        <p className="muted small">Weather comes from Open-Meteo via the server and is cached on the player; the preview shows sample data.</p>
        <StyleFields style={zone.style} onChange={setStyle} fields={['fontFamily', 'fontSize', 'align', 'color', 'background', 'padding', 'borderRadius']} />
      </>}

      {zone.type === 'qr' && <>
        <Field label="URL / text" hint="What the code encodes. Variables work."><input value={zone.data || ''} onChange={(e) => setZ({ data: e.target.value })} aria-label="QR data" placeholder="https://" /></Field>
        <div className="grid2">
          <Field label="Foreground"><ColorInput label="QR foreground" value={zone.fg || '#000000'} onChange={(v) => setZ({ fg: v })} /></Field>
          <Field label="Background"><ColorInput label="QR background" value={zone.bg || '#ffffff'} onChange={(v) => setZ({ bg: v })} /></Field>
        </div>
        <div className="grid2">
          <Field label="Caption (optional)"><input value={zone.caption || ''} onChange={(e) => setZ({ caption: e.target.value || undefined })} aria-label="QR caption" /></Field>
          <Field label="Error correction"><select value={zone.ecl || 'M'} onChange={(e) => setZ({ ecl: e.target.value })} aria-label="QR error correction"><option value="L">L (7 %)</option><option value="M">M (15 %)</option><option value="Q">Q (25 %)</option><option value="H">H (30 %)</option></select></Field>
        </div>
        <StyleFields style={zone.style} onChange={setStyle} fields={['fontSize', 'color', 'background', 'padding', 'borderRadius']} />
      </>}

      {zone.type === 'html' && <>
        <Field label="Web page URL" hint="Shown in an iframe. The player box must be able to reach it (and it must allow framing)."><input value={zone.url || ''} onChange={(e) => setZ({ url: e.target.value })} aria-label="Web page URL" placeholder="https://" /></Field>
        <StyleFields style={zone.style} onChange={setStyle} fields={['background', 'borderRadius', 'opacity']} />
      </>}

      {zone.type === 'shape' && <>
        <Field label="Shape"><Segmented label="Shape kind" value={zone.shape || 'rect'} onChange={(v) => setZ({ shape: v })} options={[['rect', 'rectangle'], ['ellipse', 'ellipse']]} /></Field>
        <div className="grid2">
          <Field label="Fill"><ColorInput label="Fill" value={zone.fill || 'rgba(255,255,255,0.15)'} onChange={(v) => setZ({ fill: v })} /></Field>
          <Field label="Border" hint="CSS, e.g. 4px solid #ffd166"><input value={zone.border || ''} onChange={(e) => setZ({ border: e.target.value || undefined })} aria-label="Border" placeholder="none" /></Field>
        </div>
        {zone.shape !== 'ellipse' && <Field label="Corner radius"><Slider value={zone.radius} onChange={(v) => setZ({ radius: v })} min={0} max={300} label="Shape radius" fallback={0} /></Field>}
        <StyleFields style={zone.style} onChange={setStyle} fields={['opacity']} />
      </>}
    </div>
  );
}
