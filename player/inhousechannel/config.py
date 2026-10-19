"""Player configuration: /etc/inhousechannel/player.conf (INI). Python 3.8 compatible."""
import configparser
import os
from dataclasses import dataclass, field
from typing import Optional

DEFAULT_CONF = "/etc/inhousechannel/player.conf"
STATE_DIR = "/var/lib/inhousechannel"
RUN_DIR = "/run/inhousechannel"
OWN_FFMPEG = "/opt/inhousechannel/bin/ffmpeg"


@dataclass
class ServerConf:
    url: str = ""
    player_key: str = ""


@dataclass
class OutputConf:
    address: str = "239.1.1.10"
    port: int = 1234
    ttl: int = 4
    interface: str = ""            # optional source IP for multicast (localaddr=)
    resolution: str = "1920x1080"
    fps: int = 30
    video_bitrate_kbps: int = 6000
    mux_rate_kbps: int = 7000
    service_name: str = "In-House"
    service_provider: str = "Caritech"
    service_id: int = 1
    pmt_pid: int = 4096
    video_pid: int = 256           # audio PID = video_pid + 1 (ffmpeg -mpegts_start_pid)

    @property
    def width(self) -> int:
        return int(self.resolution.lower().split("x")[0])

    @property
    def height(self) -> int:
        return int(self.resolution.lower().split("x")[1])

    @property
    def audio_pid(self) -> int:
        return self.video_pid + 1


@dataclass
class RenderConf:
    display: str = ":99"
    render_port: int = 8089
    vaapi_device: str = "/dev/dri/renderD128"
    chrome: str = "google-chrome"
    ffmpeg: str = ""               # empty → own ffmpeg if present, else system ffmpeg
    chrome_profile: str = os.path.join(STATE_DIR, "chrome")


@dataclass
class PlayerConf:
    server: ServerConf = field(default_factory=ServerConf)
    output: OutputConf = field(default_factory=OutputConf)
    render: RenderConf = field(default_factory=RenderConf)
    path: str = DEFAULT_CONF

    @property
    def ffmpeg(self) -> str:
        if self.render.ffmpeg:
            return self.render.ffmpeg
        if os.access(OWN_FFMPEG, os.X_OK):
            return OWN_FFMPEG
        return "ffmpeg"


def _apply(section, obj, cp: configparser.ConfigParser) -> None:
    if not cp.has_section(section):
        return
    for key, value in cp.items(section):
        if not hasattr(obj, key):
            raise ValueError("unknown option [%s] %s" % (section, key))
        current = getattr(obj, key)
        if isinstance(current, bool):
            setattr(obj, key, cp.getboolean(section, key))
        elif isinstance(current, int):
            setattr(obj, key, int(value))
        else:
            setattr(obj, key, value.strip())


def load(path: Optional[str] = None) -> PlayerConf:
    path = path or os.environ.get("IHC_CONF", DEFAULT_CONF)
    cp = configparser.ConfigParser(inline_comment_prefixes=(";", "#"))
    conf = PlayerConf(path=path)
    if os.path.exists(path):
        cp.read(path)
        _apply("server", conf.server, cp)
        _apply("output", conf.output, cp)
        _apply("render", conf.render, cp)
    conf.output.width  # validates the resolution string
    return conf


def write_example(path: str, conf: PlayerConf) -> None:
    """Write a conf file from a PlayerConf (used by install.sh via `python -m inhousechannel init`)."""
    lines = [
        "[server]",
        "url = %s" % conf.server.url,
        "player_key = %s" % conf.server.player_key,
        "",
        "[output]",
        "address = %s" % conf.output.address,
        "port = %d" % conf.output.port,
        "ttl = %d" % conf.output.ttl,
        "interface = %s" % conf.output.interface,
        "resolution = %s" % conf.output.resolution,
        "fps = %d" % conf.output.fps,
        "video_bitrate_kbps = %d" % conf.output.video_bitrate_kbps,
        "mux_rate_kbps = %d" % conf.output.mux_rate_kbps,
        "service_name = %s" % conf.output.service_name,
        "service_provider = %s" % conf.output.service_provider,
        "service_id = %d" % conf.output.service_id,
        "pmt_pid = %d" % conf.output.pmt_pid,
        "video_pid = %d" % conf.output.video_pid,
        "",
        "[render]",
        "display = %s" % conf.render.display,
        "render_port = %d" % conf.render.render_port,
        "vaapi_device = %s" % conf.render.vaapi_device,
        "",
    ]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write("\n".join(lines))
    os.chmod(path, 0o600)
