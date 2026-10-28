"""Content sync: pulls the manifest, renderer bundle and media from the server into the local
cache; evaluates the schedule locally; sends heartbeats and thumbnails. Stdlib only.

Cache layout (/var/lib/inhousechannel/cache):
  manifest.json            last manifest (with its ETag in manifest.etag)
  renderer/                unpacked renderer bundle (render.html, zone-draw.js, zones.css, fonts/)
  media/<id>.<ext>         media files, verified by sha256
  layouts/<id>/            one directory per layout: index.html (copy of render.html),
                           layout.json, symlinks to renderer assets and media
The render server points Chrome at layouts/<id>/ for the layout currently scheduled.
"""
import datetime as dt
import hashlib
import io
import json
import logging
import os
import shutil
import ssl
import time
import urllib.error
import urllib.request
import zipfile
import zoneinfo
from typing import Dict, Optional, Tuple

from . import __version__
from .config import STATE_DIR, PlayerConf

log = logging.getLogger("inhousechannel.sync")
CACHE_DIR = os.path.join(STATE_DIR, "cache")


class Server:
    def __init__(self, conf: PlayerConf, timeout: float = 20.0):
        self.base = conf.server.url.rstrip("/")
        self.key = conf.server.player_key
        self.timeout = timeout
        self.ctx = ssl.create_default_context()

    @property
    def configured(self) -> bool:
        return bool(self.base and self.key)

    def _req(self, path: str, method: str = "GET", data: bytes = None, headers: Dict[str, str] = None):
        h = {"Authorization": "Bearer " + self.key, "User-Agent": "inhousechannel-player/" + __version__}
        h.update(headers or {})
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        return urllib.request.urlopen(req, timeout=self.timeout, context=self.ctx)

    def get(self, path: str, etag: Optional[str] = None) -> Tuple[int, bytes, Dict[str, str]]:
        headers = {"If-None-Match": etag} if etag else {}
        try:
            with self._req(path, headers=headers) as r:
                return r.status, r.read(), {k.lower(): v for k, v in r.headers.items()}
        except urllib.error.HTTPError as e:
            if e.code == 304:
                return 304, b"", {}
            raise

    def download(self, path: str, dest: str) -> None:
        tmp = dest + ".part"
        with self._req(path) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f, 1 << 20)
        os.replace(tmp, dest)

    def post_json(self, path: str, obj) -> int:
        body = json.dumps(obj).encode()
        with self._req(path, "POST", body, {"Content-Type": "application/json"}) as r:
            return r.status

    def post_bytes(self, path: str, body: bytes, content_type: str) -> int:
        with self._req(path, "POST", body, {"Content-Type": content_type}) as r:
            return r.status


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class Cache:
    def __init__(self, root: str = CACHE_DIR):
        self.root = root
        for d in ("renderer", "media", "layouts"):
            os.makedirs(os.path.join(root, d), exist_ok=True)

    # -- manifest ---------------------------------------------------------------------
    def load_manifest(self) -> Tuple[Optional[dict], Optional[str]]:
        p = os.path.join(self.root, "manifest.json")
        if not os.path.exists(p):
            return None, None
        try:
            with open(p) as f:
                m = json.load(f)
            return m, m.get("_etag")
        except Exception:
            return None, None

    def save_manifest(self, m: dict, etag: Optional[str]) -> None:
        m = dict(m)
        m["_etag"] = etag
        tmp = os.path.join(self.root, "manifest.json.tmp")
        with open(tmp, "w") as f:
            json.dump(m, f)
        os.replace(tmp, os.path.join(self.root, "manifest.json"))

    # -- media ------------------------------------------------------------------------
    def media_path(self, item: dict) -> str:
        ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg",
               "image/gif": "gif", "video/mp4": "mp4", "audio/mp4": "m4a", "font/woff2": "woff2"}.get(item.get("mime", ""), "bin")
        return os.path.join(self.root, "media", "%s.%s" % (item["id"], ext))

    def media_ok(self, item: dict) -> bool:
        p = self.media_path(item)
        return os.path.exists(p) and os.path.getsize(p) == item.get("size", -1) and (
            not item.get("sha256") or sha256_file(p) == item["sha256"])

    # -- renderer ---------------------------------------------------------------------
    def install_renderer(self, zip_bytes: bytes) -> None:
        target = os.path.join(self.root, "renderer")
        tmp = target + ".new"
        shutil.rmtree(tmp, ignore_errors=True)
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
            for n in z.namelist():         # refuse path traversal
                if n.startswith("/") or ".." in n.split("/"):
                    raise ValueError("bad path in renderer bundle: " + n)
            z.extractall(tmp)
        old = target + ".old"
        shutil.rmtree(old, ignore_errors=True)
        if os.path.exists(target):
            os.rename(target, old)
        os.rename(tmp, target)
        shutil.rmtree(old, ignore_errors=True)

    def renderer_ok(self) -> bool:
        return os.path.exists(os.path.join(self.root, "renderer", "render.html"))

    # -- layouts ----------------------------------------------------------------------
    def build_layout_dir(self, layout: dict, media_by_id: Dict[str, dict]) -> str:
        """Materialise layouts/<id>/ with the renderer, layout.json and media/<id>.<ext> links so
        the page is fully local. Media URLs in the layout JSON point at media/<id>.<ext>."""
        d = os.path.join(self.root, "layouts", str(layout["id"]))
        tmp = d + ".new"
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(os.path.join(tmp, "media"))
        renderer = os.path.join(self.root, "renderer")
        for name in os.listdir(renderer):
            src = os.path.join(renderer, name)
            dst = os.path.join(tmp, "index.html" if name == "render.html" else name)
            if os.path.isdir(src):
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
        doc = json.loads(layout["json"]) if isinstance(layout["json"], str) else layout["json"]
        used = rewrite_media_refs(doc, media_by_id, self)
        for item in used:
            p = self.media_path(item)
            if os.path.exists(p):
                os.link(p, os.path.join(tmp, "media", os.path.basename(p)))
        with open(os.path.join(tmp, "layout.json"), "w") as f:
            json.dump(doc, f)
        shutil.rmtree(d, ignore_errors=True)
        os.rename(tmp, d)
        return d

    def layout_dir(self, layout_id) -> str:
        return os.path.join(self.root, "layouts", str(layout_id))

    def evict(self, keep_media: set, keep_layouts: set, max_age_days: int = 7) -> int:
        n = 0
        cutoff = time.time() - max_age_days * 86400
        for name in os.listdir(os.path.join(self.root, "media")):
            p = os.path.join(self.root, "media", name)
            if name.split(".")[0] not in keep_media and os.path.getmtime(p) < cutoff:
                os.unlink(p); n += 1
        for name in os.listdir(os.path.join(self.root, "layouts")):
            if name not in keep_layouts:
                shutil.rmtree(os.path.join(self.root, "layouts", name), ignore_errors=True); n += 1
        return n

    def size_bytes(self) -> int:
        total = 0
        for dp, _, files in os.walk(self.root):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(dp, f))
                except OSError:
                    pass
        return total


def rewrite_media_refs(doc: dict, media_by_id: Dict[str, dict], cache: Cache) -> list:
    """Walk the layout JSON; every string of the form media:<id> or /api/player/media/<id>
    becomes media/<id>.<ext>. Returns the media items referenced."""
    used = {}

    def fix(s: str) -> str:
        mid = None
        if s.startswith("media:"):
            mid = s[6:]
        elif "/api/player/media/" in s:
            mid = s.split("/api/player/media/")[1].split("?")[0].split("/")[0]
        elif "/api/admin/media/" in s:           # editor-saved URLs: .../media/<id>/file
            mid = s.split("/api/admin/media/")[1].split("/")[0]
        if mid and mid in media_by_id:
            used[mid] = media_by_id[mid]
            return "media/" + os.path.basename(cache.media_path(media_by_id[mid]))
        return s

    def walk(x):
        if isinstance(x, dict):
            return {k: walk(v) for k, v in x.items()}
        if isinstance(x, list):
            return [walk(v) for v in x]
        if isinstance(x, str):
            return fix(x)
        return x

    doc.update(walk(doc))
    return list(used.values())


# -- schedule ---------------------------------------------------------------------------
def resolve_layout_id(manifest: dict, now: Optional[dt.datetime] = None) -> Optional[int]:
    """Same rule as the server: highest priority enabled schedule whose date range, weekday
    (bit0 = Monday) and time window (overnight allowed) contain `now` in the site timezone;
    else the player's default layout."""
    tzname = (manifest.get("player") or {}).get("site_tz") or "UTC"
    try:
        tz = zoneinfo.ZoneInfo(tzname)
    except Exception:
        tz = dt.timezone.utc
    now = (now or dt.datetime.now(dt.timezone.utc)).astimezone(tz)
    today = now.date().isoformat()
    hhmm = now.strftime("%H:%M")
    best = None
    for s in manifest.get("schedule") or []:
        if not s.get("enabled", True):
            continue
        if s.get("start_date") and today < s["start_date"]:
            continue
        if s.get("end_date") and today > s["end_date"]:
            continue
        start, end = s.get("start_time") or "00:00", s.get("end_time") or "24:00"
        mask = s.get("days_mask", 127)
        if start <= end:
            if not (start <= hhmm < end) or not (mask >> now.weekday()) & 1:
                continue
        else:  # overnight window: today's evening part or yesterday's morning part
            if hhmm >= start:
                if not (mask >> now.weekday()) & 1:
                    continue
            elif hhmm < end:
                if not (mask >> ((now.weekday() - 1) % 7)) & 1:
                    continue
            else:
                continue
        if best is None or s.get("priority", 0) > best.get("priority", 0):
            best = s
    if best:
        return best["layout_id"]
    return manifest.get("default_layout_id")


# -- the sync loop -------------------------------------------------------------------------
class Syncer:
    def __init__(self, conf: PlayerConf, cache: Optional[Cache] = None, interval_s: int = 60):
        self.conf = conf
        self.server = Server(conf)
        self.cache = cache or Cache()
        self.interval_s = interval_s
        self.manifest, self.etag = self.cache.load_manifest()
        self.last_sync_at: Optional[float] = None
        self.last_error: Optional[str] = None
        self.ready_layouts: set = set()
        if self.manifest:
            self.ready_layouts = {str(l["id"]) for l in self.manifest.get("layouts", [])
                                  if os.path.exists(os.path.join(self.cache.layout_dir(l["id"]), "index.html"))}

    def sync_once(self) -> bool:
        """Returns True when anything changed."""
        if not self.server.configured:
            return False
        try:
            status, body, headers = self.server.get("/api/player/manifest", self.etag)
        except Exception as e:
            self.last_error = "manifest: %s" % e
            log.warning(self.last_error)
            return False
        self.last_sync_at = time.time()
        self.last_error = None
        if status == 304:
            return False
        m = json.loads(body.decode())
        etag = headers.get("etag")
        changed = False
        # renderer bundle (ETag of its own, stored inside the manifest we save)
        r_etag = (self.manifest or {}).get("_renderer_etag") if self.cache.renderer_ok() else None
        try:
            st, zb, zh = self.server.get("/api/player/renderer", r_etag)
            if st == 200:
                self.cache.install_renderer(zb)
                m["_renderer_etag"] = zh.get("etag")
                changed = True
                log.info("renderer bundle updated")
            else:
                m["_renderer_etag"] = r_etag
        except Exception as e:
            self.last_error = "renderer: %s" % e
            log.warning(self.last_error)
            if not self.cache.renderer_ok():
                return False
        media_by_id = {str(i["id"]): i for i in m.get("media", [])}
        for item in m.get("media", []):
            if self.cache.media_ok(item):
                continue
            try:
                self.server.download(item["url"], self.cache.media_path(item))
                if not self.cache.media_ok(item):
                    raise ValueError("checksum mismatch")
                changed = True
                log.info("downloaded media %s (%s, %d bytes)", item["id"], item.get("name"), item.get("size", 0))
            except Exception as e:
                self.last_error = "media %s: %s" % (item["id"], e)
                log.warning(self.last_error)
                try:
                    os.unlink(self.cache.media_path(item))
                except OSError:
                    pass
        self.ready_layouts = set()
        for layout in m.get("layouts", []):
            try:
                self.cache.build_layout_dir(layout, media_by_id)
                self.ready_layouts.add(str(layout["id"]))
                changed = True
            except Exception as e:
                self.last_error = "layout %s: %s" % (layout.get("id"), e)
                log.warning(self.last_error)
        self.manifest, self.etag = m, etag
        self.cache.save_manifest(m, etag)
        self.cache.evict(set(media_by_id), self.ready_layouts)
        return changed

    def current_layout_dir(self) -> Optional[str]:
        if not self.manifest:
            return None
        lid = resolve_layout_id(self.manifest)
        if lid is None or str(lid) not in self.ready_layouts:
            return None
        return self.cache.layout_dir(lid)

    def current_layout_id(self) -> Optional[int]:
        return resolve_layout_id(self.manifest) if self.manifest else None

    def heartbeat(self, status: dict) -> None:
        if not self.server.configured:
            return
        try:
            self.server.post_json("/api/player/heartbeat", status)
        except Exception as e:
            log.debug("heartbeat failed: %s", e)

    def thumbnail(self, jpeg: bytes) -> None:
        if not self.server.configured:
            return
        try:
            self.server.post_bytes("/api/player/thumbnail", jpeg, "image/jpeg")
        except Exception as e:
            log.debug("thumbnail failed: %s", e)
