"""CLI: python -m inhousechannel <run|status|preview|selftest|init|ffmpeg-cmd|version>"""
import argparse
import json
import logging
import os
import subprocess
import sys

from . import __version__
from .config import RUN_DIR, PlayerConf, load, write_example


def cmd_run(conf: PlayerConf, args) -> int:
    from .supervisor import Supervisor
    return Supervisor(conf).run()


def cmd_status(conf: PlayerConf, args) -> int:
    path = os.path.join(RUN_DIR, "status.json")
    if not os.path.exists(path):
        print("player is not running (no %s)" % path)
        return 1
    with open(path) as f:
        s = json.load(f)
    if args.json:
        print(json.dumps(s, indent=1))
        return 0
    print("inhousechannel player v%s on %s — up %ds — output udp://%s %s@%dfps — ffmpeg %s" %
          (s["version"], s["hostname"], s["uptime_s"], s["output"], s["resolution"], s["fps"], s["ffmpeg_binary"]))
    print("render root: %s" % s["render_root"])
    for name, p in s["procs"].items():
        print("  %-7s %s pid %-7s up %6ds  restarts/h %d  (%s)" % (
            name, "alive" if p["alive"] else "DOWN ", p["pid"] or "-", p["uptime_s"],
            p["restarts_last_hour"], p["last_reason"]))
        for line in p["stderr_tail"][-2:]:
            print("          | %s" % line)
    for e in s["events"][-5:]:
        print("  event: %s" % e)
    return 0


def cmd_preview(conf: PlayerConf, args) -> int:
    from .supervisor import snapshot
    out = args.out or "/tmp/inhousechannel-preview.png"
    snapshot(conf, out)
    print(out)
    return 0


def cmd_selftest(conf: PlayerConf, args) -> int:
    from .supervisor import selftest
    res = selftest(conf, args.seconds)
    print(json.dumps(res, indent=1))
    if res.get("ok"):
        print("OK: %s fps measured, %.1f%% of one core for %ds of %s video" %
              (res.get("fps_measured"), res.get("cpu_pct_of_one_core", 0), args.seconds, conf.output.resolution))
    return 0 if res.get("ok") else 1


def cmd_init(conf: PlayerConf, args) -> int:
    """Write the conf from environment variables (install.sh) without clobbering existing values."""
    env = os.environ
    conf.server.url = env.get("IHC_SERVER_URL", conf.server.url)
    conf.server.player_key = env.get("IHC_PLAYER_KEY", conf.server.player_key)
    conf.output.address = env.get("IHC_MCAST", conf.output.address)
    conf.output.port = int(env.get("IHC_PORT", conf.output.port))
    conf.output.resolution = env.get("IHC_RESOLUTION", conf.output.resolution)
    conf.output.service_name = env.get("IHC_SERVICE_NAME", conf.output.service_name)
    write_example(args.path or conf.path, conf)
    print("wrote %s" % (args.path or conf.path))
    return 0


def cmd_ffmpeg_cmd(conf: PlayerConf, args) -> int:
    from .pipeline import ffmpeg_command
    print(" ".join(subprocess.list2cmdline([a]) for a in ffmpeg_command(conf)))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="inhousechannel-player")
    ap.add_argument("-c", "--conf", help="config file (default /etc/inhousechannel/player.conf)")
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("run", help="run the player (what systemd starts)")
    p = sub.add_parser("status", help="show the running player's state"); p.add_argument("--json", action="store_true")
    p = sub.add_parser("preview", help="save a PNG of the current frame"); p.add_argument("out", nargs="?")
    p = sub.add_parser("selftest", help="run the encode pipeline for N seconds and report fps/CPU")
    p.add_argument("--seconds", type=int, default=10)
    p = sub.add_parser("init", help="write player.conf from IHC_* environment variables"); p.add_argument("--path")
    sub.add_parser("ffmpeg-cmd", help="print the ffmpeg command line")
    sub.add_parser("version")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(levelname)s %(message)s", stream=sys.stderr)
    if args.cmd == "version" or not args.cmd:
        print(__version__)
        return 0
    conf = load(args.conf)
    return {"run": cmd_run, "status": cmd_status, "preview": cmd_preview, "selftest": cmd_selftest,
            "init": cmd_init, "ffmpeg-cmd": cmd_ffmpeg_cmd}[args.cmd](conf, args)


if __name__ == "__main__":
    sys.exit(main())
