'use strict';
// Server-side weather (Open-Meteo, no API key), cached per location for 15 minutes. The fetcher
// is injectable so tests never touch the network.
const TTL_MS = 15 * 60 * 1000;
const WMO = {
  0: ['Clear', '☀'], 1: ['Mostly clear', '🌤'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁'],
  45: ['Fog', '🌫'], 48: ['Rime fog', '🌫'], 51: ['Light drizzle', '🌦'], 53: ['Drizzle', '🌦'], 55: ['Heavy drizzle', '🌧'],
  56: ['Freezing drizzle', '🌧'], 57: ['Freezing drizzle', '🌧'], 61: ['Light rain', '🌦'], 63: ['Rain', '🌧'], 65: ['Heavy rain', '🌧'],
  66: ['Freezing rain', '🌧'], 67: ['Freezing rain', '🌧'], 71: ['Light snow', '🌨'], 73: ['Snow', '🌨'], 75: ['Heavy snow', '❄'],
  77: ['Snow grains', '🌨'], 80: ['Showers', '🌦'], 81: ['Showers', '🌧'], 82: ['Violent showers', '⛈'], 85: ['Snow showers', '🌨'],
  86: ['Snow showers', '❄'], 95: ['Thunderstorm', '⛈'], 96: ['Thunderstorm, hail', '⛈'], 99: ['Thunderstorm, hail', '⛈'],
};

function createWeather({ fetcher = defaultFetch, log = () => {} } = {}) {
  const cache = new Map(); // key -> { at, data }
  async function get(settings) {
    const w = (settings && settings.weather) || {};
    const lat = Number(w.lat), lon = Number(w.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false, reason: 'no location configured' };
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    const c = cache.get(key);
    if (c && Date.now() - c.at < TTL_MS) return c.data;
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m&timezone=auto`;
      const j = await fetcher(url);
      const cur = j && j.current;
      if (!cur) throw new Error('no current block');
      const code = Number(cur.weather_code);
      const [text, icon] = WMO[code] || ['—', '•'];
      const data = { ok: true, temp_c: Math.round(cur.temperature_2m), temp_f: Math.round(cur.temperature_2m * 9 / 5 + 32), code, text, icon,
        wind_kmh: Math.round(cur.wind_speed_10m), humidity: cur.relative_humidity_2m, updated_at: new Date().toISOString(), lat, lon };
      cache.set(key, { at: Date.now(), data });
      return data;
    } catch (e) {
      log(`weather fetch failed for ${key}: ${e.message}`);
      if (c) return c.data;      // stale beats nothing
      return { ok: false, reason: 'weather service unavailable' };
    }
  }
  return { get, _cache: cache };
}

async function defaultFetch(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'inhousechannel' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

module.exports = { createWeather, WMO };
