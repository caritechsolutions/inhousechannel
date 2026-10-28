import React, { useEffect, useRef, useState } from 'react';
import '../../../shared/zones.css';
import '../../../shared/fonts/fonts.css';
import * as draw from '../../../shared/zone-draw.js';
import { mediaUrl } from '../mediaUrl.js';

// In-editor preview drawn by the player's own zone code (shared/zone-draw.js) with sample
// weather. What you see here is what the channel shows, minus the video region (ffmpeg
// composites that on the box; here it is a hatched placeholder).
export const FAKE_WEATHER = { ok: true, icon: '⛅', temp_c: 29, temp_f: 84, text: 'Partly cloudy' };
export function fakeContext(site) {
  // the server hands the player `logo: "media:<id>"`; env.mediaUrl resolves it, same as here
  return { site: (site && site.name) || 'Hotel', logo: site && site.logo_media_id ? `media:${site.logo_media_id}` : '' };
}

export default function LayoutPreview({ doc, pageId, width = 960, site }) {
  const canvas = doc.canvas || { w: 1920, h: 1080 };
  const scale = width / canvas.w;
  const stageRef = useRef(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const stage = stageRef.current; if (!stage) return;
    const base = fakeContext(site);
    const ctx = { ...(draw.liveContext ? draw.liveContext(base, now) : base), __preview: true, __now: now };
    const env = { weather: FAKE_WEATHER, units: 'metric', preview: true, mediaUrl: (src) => mediaUrl(src, site && site.id) };
    draw.renderStage(stage, doc, ctx, env, pageId);
  }, [doc, pageId, site]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (stageRef.current && draw.tick) draw.tick(stageRef.current, doc, fakeContext(site), now); }, [now]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="tvpreview" style={{ width, height: canvas.h * scale }} data-testid="tvpreview">
      <div ref={stageRef} className="tvstage" style={{ width: canvas.w, height: canvas.h, transform: `scale(${scale})` }} />
    </div>
  );
}
