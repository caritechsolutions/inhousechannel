"""Supervises Xvfb, Chrome and ffmpeg; keeps the TS flowing; writes /run/inhousechannel/status.json."""
import json
import logging
import os
import shutil
import signal
import subprocess
import threading
import time
from typing import Dict, List, Optional

from . import __version__
from .config import RUN_DIR, PlayerConf
from .pipeline import chrome_command, ffmpeg_command, snapshot_command, udp_url, xvfb_command
from .renderserver import RenderServer, hostname
from .sync import Cache, Syncer

log = logging.getLogger("inhousechannel")


class Proc:
    """One supervised child with restart counting and exponential backoff."""

    def __init__(self, name: str, cmd_fn, env: Optional[Dict[str, str]] = None, stderr_tail: int = 20):
        self.name = name
        self.cmd_fn = cmd_fn
        self.env = env
        self.p: Optional[subprocess.Popen] = None
        self.started_at = 0.0
        self.restarts: List[float] = []        # timestamps of restarts
        self.last_exit: Optional[int] = None
        self.last_reason = ""
        self.backoff = 1.0
        self.tail: List[str] = []
        self._tail_n = stderr_tail
        self._reader: Optional[threading.Thread] = None

    def start(self, reason: str) -> None:
        cmd = self.cmd_fn()
        env = dict(os.environ)
        if self.env:
            env.update(self.env)
        self.p = subprocess.Popen(cmd, env=env, stdin=subprocess.DEVNULL,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                  start_new_session=True)
        self.started_at = time.time()
        self.last_reason = reason
        if reason != "initial start":
            self.restarts.append(self.started_at)
        self.tail = []
        self._reader = threading.Thread(target=self._read_stderr, daemon=True)
        self._reader.start()
        log.info("%s started (pid %d): %s", self.name, self.p.pid, reason)

    def _read_stderr(self) -> None:
        p = self.p
        try:
            for raw in p.stderr:
                line = raw.decode("utf-8", "replace").rstrip()
                if not line:
                    continue
                self.tail.append(line)
                del self.tail[:-self._tail_n]
                if self.name == "ffmpeg":
                    log.warning("ffmpeg: %s", line)
        except Exception:
            pass

    def alive(self) -> bool:
        return self.p is not None and self.p.poll() is None

    def stop(self, timeout: float = 5.0) -> None:
        if not self.p:
            return
        if self.p.poll() is None:
            try:
                os.killpg(self.p.pid, signal.SIGTERM)
                self.p.wait(timeout)
            except (subprocess.TimeoutExpired, ProcessLookupError):
                try:
                    os.killpg(self.p.pid, signal.SIGKILL)
                    self.p.wait(5)
                except Exception:
                    pass
        self.last_exit = self.p.returncode
        log.info("%s stopped (exit %s)", self.name, self.last_exit)
        self.p = None

    def restarts_last_hour(self) -> int:
        cutoff = time.time() - 3600
        self.restarts = [t for t in self.restarts if t >= cutoff]
        return len(self.restarts)

    def uptime(self) -> float:
        return time.time() - self.started_at if self.alive() else 0.0


class Supervisor:
    def __init__(self, conf: PlayerConf):
        self.conf = conf
        self.stop_requested = False
        self.started_at = time.time()
        self.cache = Cache()
        self.syncer = Syncer(conf, self.cache)
        self.render = RenderServer(conf.render.render_port, self.status,
                                   layouts_dir=os.path.join(self.cache.root, "layouts"),
                                   resolution=conf.output.resolution)
        self.xvfb = Proc("Xvfb", lambda: xvfb_command(conf))
        self.chrome = Proc("chrome", lambda: chrome_command(conf, self.render.url),
                           env={"DISPLAY": conf.render.display, "HOME": "/var/lib/inhousechannel"})
        self.video = None                     # current overlay spec (None = graphics only)
        self.ffmpeg = Proc("ffmpeg", lambda: ffmpeg_command(conf, video=self.video), env={"DISPLAY": conf.render.display})
        self.events: List[str] = []

    # -- status -------------------------------------------------------------------------
    def note(self, msg: str) -> None:
        log.warning(msg)
        self.events.append("%s %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
        del self.events[:-50]

    def status(self) -> Dict:
        return {
            "version": __version__,
            "hostname": hostname(),
            "uptime_s": int(time.time() - self.started_at),
            "output": udp_url(self.conf).split("?")[0].replace("udp://", ""),
            "resolution": self.conf.output.resolution,
            "fps": self.conf.output.fps,
            "ffmpeg_binary": self.conf.ffmpeg,
            "server": self.conf.server.url or None,
            "paired": self.syncer.server.configured,
            "layout_id": self.render.current_layout_id,
            "render_url": self.render.current_url,
            "video": {k: v for k, v in (self.video or {}).items() if k != "playlist"} or None,
            "last_sync_at": self.syncer.last_sync_at,
            "sync_error": self.syncer.last_error,
            "cache_bytes": self.cache.size_bytes(),
            "procs": {
                p.name: {"alive": p.alive(), "pid": p.p.pid if p.alive() else None,
                         "uptime_s": int(p.uptime()), "restarts_last_hour": p.restarts_last_hour(),
                         "last_reason": p.last_reason, "last_exit": p.last_exit,
                         "stderr_tail": p.tail[-5:]}
                for p in (self.xvfb, self.chrome, self.ffmpeg)
            },
            "events": self.events[-10:],
        }

    def write_status(self) -> None:
        try:
            os.makedirs(RUN_DIR, exist_ok=True)
            tmp = os.path.join(RUN_DIR, "status.json.tmp")
            with open(tmp, "w") as f:
                json.dump(self.status(), f, indent=1)
            os.replace(tmp, os.path.join(RUN_DIR, "status.json"))
        except Exception as e:  # never let status reporting take the player down
            log.debug("status write failed: %s", e)

    # -- lifecycle ----------------------------------------------------------------------
    def _wait_display(self, timeout: float = 10.0) -> bool:
        sock = "/tmp/.X11-unix/X%s" % self.conf.render.display.lstrip(":")
        deadline = time.time() + timeout
        while time.time() < deadline:
            if os.path.exists(sock) and self.xvfb.alive():
                return True
            if not self.xvfb.alive():
                return False
            time.sleep(0.2)
        return False

    def start_all(self, reason: str) -> None:
        os.makedirs(self.conf.render.chrome_profile, exist_ok=True)
        # a stale lock from an unclean shutdown stops Chrome from starting
        for f in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
            try:
                os.unlink(os.path.join(self.conf.render.chrome_profile, f))
            except FileNotFoundError:
                pass
        self.xvfb.start(reason)
        if not self._wait_display():
            raise RuntimeError("Xvfb did not come up on %s: %s" % (self.conf.render.display, self.xvfb.tail[-3:]))
        self.chrome.start(reason)
        time.sleep(1.5)                       # let the window map before the first grab
        self.ffmpeg.start(reason)

    def stop_all(self) -> None:
        self.ffmpeg.stop()
        self.chrome.stop()
        self.xvfb.stop()

    def run(self) -> int:
        signal.signal(signal.SIGTERM, self._on_signal)
        signal.signal(signal.SIGINT, self._on_signal)
        self.render.start()
        log.info("inhousechannel player %s: display %s, render %s, ffmpeg %s, output %s",
                 __version__, self.conf.render.display, self.render.url, self.conf.ffmpeg, udp_url(self.conf))
        try:
            self._apply_schedule()                # show a cached layout before Chrome starts
            self.start_all("initial start")
            threading.Thread(target=self._sync_loop, name="sync", daemon=True).start()
            last_status = last_sched = 0.0
            while not self.stop_requested:
                time.sleep(0.5)
                self._check()
                if time.time() - last_sched > 5:
                    self._apply_schedule()
                    last_sched = time.time()
                if time.time() - last_status > 10:
                    self.write_status()
                    last_status = time.time()
        finally:
            self.stop_all()
            self.render.stop()
            self.write_status()
        return 0

    def _apply_schedule(self) -> None:
        lid = self.syncer.current_layout_id()
        d = self.syncer.current_layout_dir()
        if self.render.set_current(lid, d):
            self.note("now showing %s" % ("layout %s" % lid if d else "slate"))
        video = self.syncer.current_video(self.conf.output.resolution) if d else None
        key = lambda v: None if not v else (v["x"], v["y"], v["w"], v["h"], v["loop"], v["mute"], tuple(v["files"]))
        if key(video) != key(self.video):
            self.video = video
            if self.ffmpeg.alive():          # geometry/playlist change: the one case that restarts the encoder
                self.ffmpeg.stop()
                self.ffmpeg.start("video region changed: %s" % ("%dx%d@%d,%d, %d clip(s)" % (
                    video["w"], video["h"], video["x"], video["y"], len(video["files"])) if video else "removed"))

    def _sync_loop(self) -> None:
        last_thumb = 0.0
        while not self.stop_requested:
            try:
                if self.syncer.sync_once():
                    self._apply_schedule()
            except Exception as e:
                log.warning("sync: %s", e)
            self.syncer.heartbeat(self._heartbeat_body())
            if time.time() - last_thumb > 300 and self.xvfb.alive():
                try:
                    self.syncer.thumbnail(self._thumbnail_jpeg())
                    last_thumb = time.time()
                except Exception as e:
                    log.debug("thumbnail: %s", e)
            for _ in range(self.syncer.interval_s * 2):
                if self.stop_requested:
                    return
                time.sleep(0.5)

    def _heartbeat_body(self) -> Dict:
        return {
            "version": __version__, "hostname": hostname(), "uptime_s": int(time.time() - self.started_at),
            "layout_id": self.render.current_layout_id, "resolution": self.conf.output.resolution,
            "fps": self.conf.output.fps, "output": udp_url(self.conf).split("?")[0].replace("udp://", ""),
            "video_codec": self.conf.output.video_codec, "bitrate_kbps": self.conf.output.video_bitrate_kbps,
            "cpu_pct": cpu_percent(), "load_avg": os.getloadavg()[0],
            "restarts_last_hour": sum(p.restarts_last_hour() for p in (self.xvfb, self.chrome, self.ffmpeg)),
            "procs_alive": {p.name: p.alive() for p in (self.xvfb, self.chrome, self.ffmpeg)},
            "cache_bytes": self.cache.size_bytes(), "last_sync_at": self.syncer.last_sync_at,
            "sync_error": self.syncer.last_error, "events": self.events[-3:],
        }

    def _thumbnail_jpeg(self) -> bytes:
        cmd = snapshot_command(self.conf, "-")
        cmd[cmd.index("-frames:v") + 2:] = ["-vf", "scale=480:-2", "-q:v", "6", "-f", "mjpeg", "-"]
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15,
                           env=dict(os.environ, DISPLAY=self.conf.render.display))
        return r.stdout

    def _on_signal(self, signum, frame) -> None:
        log.info("signal %d: stopping", signum)
        self.stop_requested = True

    def _restart(self, proc: Proc, reason: str) -> None:
        # exponential backoff per process so a crash loop doesn't burn the CPU the channel needs
        if proc.restarts_last_hour() >= 3:
            proc.backoff = min(proc.backoff * 2, 30.0)
        else:
            proc.backoff = 1.0
        self.note("%s restarting in %.0fs: %s (exit %s; last stderr: %s)" %
                  (proc.name, proc.backoff, reason, proc.last_exit, " | ".join(proc.tail[-2:])))
        time.sleep(proc.backoff)
        proc.start(reason)

    def _check(self) -> None:
        if not self.xvfb.alive():
            self.xvfb.stop()
            self.stop_all()
            self.note("Xvfb died; restarting the whole chain")
            time.sleep(1)
            self.start_all("Xvfb died")
            return
        if not self.chrome.alive():
            self.chrome.stop()
            self._restart(self.chrome, "chrome exited")       # ffmpeg keeps grabbing: TS continues
        if not self.ffmpeg.alive():
            self.ffmpeg.stop()
            self._restart(self.ffmpeg, "ffmpeg exited")


_cpu_prev = None


def cpu_percent() -> float:
    """Whole-box CPU % since the previous call (0–100 × cores), from /proc/stat."""
    global _cpu_prev
    try:
        with open("/proc/stat") as f:
            parts = [float(x) for x in f.readline().split()[1:8]]
    except Exception:
        return 0.0
    total, idle = sum(parts), parts[3] + parts[4]
    prev, _cpu_prev = _cpu_prev, (total, idle)
    if not prev or total == prev[0]:
        return 0.0
    return round(100.0 * (1 - (idle - prev[1]) / (total - prev[0])) * os.cpu_count(), 1)


def snapshot(conf: PlayerConf, out_png: str) -> None:
    subprocess.run(snapshot_command(conf, out_png), check=True, env=dict(os.environ, DISPLAY=conf.render.display))


def selftest(conf: PlayerConf, seconds: int = 10) -> Dict:
    """Run the real pipeline for `seconds` to /dev/null with -benchmark against whatever is on the
    display (the daemon's Xvfb if running, else a temporary one) and report fps and CPU."""
    own_xvfb = None
    sock = "/tmp/.X11-unix/X%s" % conf.render.display.lstrip(":")
    if not os.path.exists(sock):
        own_xvfb = subprocess.Popen(xvfb_command(conf), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.5)
    try:
        cmd = ffmpeg_command(conf, destination="/dev/null", duration_s=seconds, benchmark=True)
        cmd[cmd.index("-loglevel") + 1] = "info"
        cmd.remove("-nostats")                 # the final frame=/fps= line is what we parse
        t0 = time.time()
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           env=dict(os.environ, DISPLAY=conf.render.display), timeout=seconds + 30)
        wall = time.time() - t0
    finally:
        if own_xvfb:
            own_xvfb.terminate()
            own_xvfb.wait(5)
    out = r.stdout.decode("utf-8", "replace")
    res = {"ok": r.returncode == 0, "exit": r.returncode, "wall_s": round(wall, 1), "ffmpeg": conf.ffmpeg}
    for line in out.splitlines():
        if line.startswith("bench: utime="):
            parts = dict(kv.split("=") for kv in line[len("bench: "):].split())
            cpu = float(parts["utime"].rstrip("s")) + float(parts["stime"].rstrip("s"))
            res["cpu_s"] = round(cpu, 2)
            res["cpu_pct_of_one_core"] = round(100 * cpu / seconds, 1)
        if line.startswith("frame="):
            res["frames"] = int(line.split("fps=")[0].split("=")[1])
            res["fps_measured"] = round(res["frames"] / seconds, 1)
    if not res["ok"]:
        res["log_tail"] = out.splitlines()[-8:]
    return res


def which(prog: str) -> Optional[str]:
    return shutil.which(prog)
