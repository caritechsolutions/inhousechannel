// Layout JSON references library media as `media:<id>` (the server's manifest, delete
// protection and the player's cache all key on that token; the player's renderer maps it to its
// cache through env.mediaUrl). The admin stores the token and resolves it only for display.
import { useSession } from './App.jsx';

export const MEDIA_RE = /^media:(\d+)$/;
export const isMediaRef = (s) => MEDIA_RE.test(String(s || ''));
export const mediaRef = (item) => (item && item.id != null ? `media:${item.id}` : (item && item.url) || '');

export function mediaUrl(src, siteId, { thumb = false } = {}) {
  const m = MEDIA_RE.exec(String(src || ''));
  if (!m) return src || '';
  if (!siteId) return '';
  return `/api/admin/sites/${siteId}/media/${m[1]}/${thumb ? 'thumb' : 'file'}`;
}

// Hook: resolver bound to the selected site (tolerates a missing session in unit tests).
export function useMediaUrl() {
  const s = useSession();
  const siteId = s && s.site ? s.site.id : null;
  return (src, opts) => mediaUrl(src, siteId, opts);
}
