"""Builds the ffmpeg command line: X11 grab → GPU upload/convert → h264_vaapi → MPEG-TS → UDP.

All colour conversion happens on the iGPU (hwupload of the RGB grab + scale_vaapi), which
measured ~26 % CPU on the Celeron 3965U versus ~68 % for the CPU `format=nv12` path.
"""
from typing import List

from .config import PlayerConf


def ffmpeg_command(conf: PlayerConf, destination: str = None, duration_s: int = None,
                   benchmark: bool = False) -> List[str]:
    o, r = conf.output, conf.render
    gop = o.fps * 2
    cmd = [
        conf.ffmpeg, "-y", "-hide_banner", "-nostats", "-loglevel", "warning",
        "-vaapi_device", r.vaapi_device,
        # input 0: the virtual screen (realtime source)
        "-f", "x11grab", "-framerate", str(o.fps), "-video_size", o.resolution,
        "-draw_mouse", "0", "-thread_queue_size", "512", "-i", r.display,
        # input 1: silent audio — an audio PID must always exist for modulators/STBs
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    ]
    if duration_s:
        cmd += ["-t", str(duration_s)]
    cmd += [
        "-filter_complex",
        "[0:v]hwupload,scale_vaapi=w=%d:h=%d:format=nv12[v]" % (o.width, o.height),
        "-map", "[v]", "-map", "1:a",
        "-c:v", "h264_vaapi", "-profile:v", "high",
        "-b:v", "%dk" % o.video_bitrate_kbps, "-maxrate", "%dk" % o.video_bitrate_kbps,
        "-bufsize", "%dk" % (o.video_bitrate_kbps * 2),
        "-g", str(gop), "-keyint_min", str(gop), "-bf", "0",
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
