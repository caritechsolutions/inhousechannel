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
from .pipeline import chrome_command, ffmpeg_command, udp_url, xvfb_command
from .renderserver import RenderServer, hostname

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
        self.render = RenderServer(conf.render.render_port, self.status)
        self.xvfb = Proc("Xvfb", lambda: xvfb_command(conf))
        self.chrome = Proc("chrome", lambda: chrome_command(conf, self.render.url),
                           env={"DISPLAY": conf.render.display, "HOME": "/var/lib/inhousechannel"})
        self.ffmpeg = Proc("ffmpeg", lambda: ffmpeg_command(conf), env={"DISPLAY": conf.render.display})
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
            "render_root": self.render.root,
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
            self.start_all("initial start")
            last_status = 0.0
            while not self.stop_requested:
                time.sleep(0.5)
                self._check()
                if time.time() - last_status > 10:
                    self.write_status()
                    last_status = time.time()
        finally:
            self.stop_all()
            self.render.stop()
            self.write_status()
        return 0

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


def snapshot(conf: PlayerConf, out_png: str) -> None:
    from .pipeline import snapshot_command
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
