"""Builds the ffmpeg command line: X11 grab → mpeg2video (CPU) → MPEG-TS → UDP.

CPU only, no GPU dependency. Measured 2026-10-28 on a Celeron 3965U hotel box: 720p30 MPEG-2
grab+encode+mux ≈ 34–42 % of one core while the box kept serving its rist receivers.
"""
from typing import List

from .config import PlayerConf


def ffmpeg_command(conf: PlayerConf, destination: str = None, duration_s: int = None,
                   benchmark: bool = False) -> List[str]:
    o, r = conf.output, conf.render
    cmd = [
        conf.ffmpeg, "-y", "-hide_banner", "-nostats", "-loglevel", "warning",
        # input 0: the virtual screen (realtime source)
        "-f", "x11grab", "-framerate", str(o.fps), "-video_size", o.resolution,
        "-draw_mouse", "0", "-thread_queue_size", "512", "-i", r.display,
        # input 1: silent audio — an audio PID must always exist for modulators/STBs
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    ]
    if duration_s:
        cmd += ["-t", str(duration_s)]
    cmd += ["-map", "0:v", "-map", "1:a", "-pix_fmt", "yuv420p", "-threads", str(r.threads)]
    cmd += video_codec_args(conf)
    cmd += [
        "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
        "-f", "mpegts",
        "-mpegts_service_id", str(o.service_id),
        "-mpegts_pmt_start_pid", str(o.pmt_pid),
        "-mpegts_start_pid", str(o.video_pid),
        "-mpegts_flags", "+resend_headers",
        "-metadata", "service_name=%s" % o.service_name,
        "-metadata", "service_provider=%s" % o.service_provider,
        "-muxrate", "%dk" % o.mux_rate_kbps,
        "-pcr_period", "20",
    ]
    if benchmark:
        cmd.append("-benchmark")
    cmd.append(destination or udp_url(conf))
    return cmd


def video_codec_args(conf: PlayerConf) -> List[str]:
    o = conf.output
    br = o.video_bitrate_kbps
    if o.video_codec == "h264":
        gop = o.fps * 2
        return ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-profile:v", "high",
                "-b:v", "%dk" % br, "-maxrate", "%dk" % br, "-bufsize", "%dk" % (br * 2),
                "-g", str(gop), "-keyint_min", str(gop), "-x264-params", "nal-hrd=cbr:force-cfr=1"]
    # MPEG-2: true CBR (minrate = maxrate), short GOP so modulator/STB lock is fast, 2 B-frames
    return ["-c:v", "mpeg2video", "-b:v", "%dk" % br, "-minrate", "%dk" % br, "-maxrate", "%dk" % br,
            "-bufsize", "%dk" % max(br // 3, 1000), "-g", "15", "-bf", "2"]


def udp_url(conf: PlayerConf) -> str:
    o = conf.output
    params = ["pkt_size=1316", "ttl=%d" % o.ttl]
    if o.interface:
        params.append("localaddr=%s" % o.interface)
    return "udp://%s:%d?%s" % (o.address, o.port, "&".join(params))


def snapshot_command(conf: PlayerConf, out_png: str) -> List[str]:
    """One frame of the virtual screen as PNG (CLI `preview`, heartbeat thumbnails)."""
    return [conf.ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-f", "x11grab", "-video_size", conf.output.resolution, "-draw_mouse", "0",
            "-i", conf.render.display, "-frames:v", "1", out_png]


def chrome_command(conf: PlayerConf, url: str) -> List[str]:
    """Chrome kiosk on the virtual display. Dedicated --user-data-dir so it never joins another
    instance (a second plain invocation prints 'Opening in existing browser session' and exits)."""
    o, r = conf.output, conf.render
    return [
        r.chrome,
        "--user-data-dir=%s" % r.chrome_profile,
        "--no-sandbox", "--kiosk", "--no-first-run", "--noerrdialogs",
        "--window-size=%d,%d" % (o.width, o.height), "--window-position=0,0",
        "--force-device-scale-factor=1", "--hide-scrollbars",
        "--disable-gpu", "--disable-dev-shm-usage", "--disable-extensions",
        "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
        "--disable-session-crashed-bubble", "--disable-infobars",
        "--disable-features=TranslateUI,Translate",
        "--autoplay-policy=no-user-gesture-required",
        "--password-store=basic", "--no-default-browser-check",
        url,
    ]


def xvfb_command(conf: PlayerConf) -> List[str]:
    return ["Xvfb", conf.render.display, "-screen", "0", "%sx24" % conf.output.resolution,
            "-nolisten", "tcp", "-nocursor", "+extension", "RANDR"]
