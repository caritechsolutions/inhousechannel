"""Builds the ffmpeg command line: X11 grab → mpeg2video (CPU) → MPEG-TS → UDP.

CPU only, no GPU dependency. Measured 2026-10-28 on a Celeron 3965U hotel box while it kept
serving its rist receivers: 1080p30 MPEG-2 grab+encode+mux ≈ 73–80 % of one core, 720p ≈ 34–42 %.
"""
from typing import List, Optional

from .config import PlayerConf


def ffmpeg_command(conf: PlayerConf, destination: str = None, duration_s: int = None,
                   benchmark: bool = False, video: Optional[dict] = None) -> List[str]:
    """`video` = {"playlist": "/path/list.txt", "x","y","w","h" (output pixels), "loop": bool,
    "mute": bool} composites a clip playlist over the screen grab at that rectangle (the page
    draws a transparent hole there). None = graphics only."""
    o, r = conf.output, conf.render
    cmd = [
        conf.ffmpeg, "-y", "-hide_banner", "-nostats", "-loglevel", "warning",
        # input 0: the virtual screen (realtime source)
        "-f", "x11grab", "-framerate", str(o.fps), "-video_size", o.resolution,
        "-draw_mouse", "0", "-thread_queue_size", "512", "-i", r.display,
        # input 1: silent audio — an audio PID must always exist for modulators/STBs
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    ]
    if video:
        # input 2: the clip playlist (concat demuxer), read at native rate so it paces with the grab;
        # -stream_loop -1 loops the whole list. Clips are server-normalised 720p H.264 + AAC.
        cmd += ["-re", "-thread_queue_size", "512"]
        if video.get("loop", True):
            cmd += ["-stream_loop", "-1"]
        cmd += ["-f", "concat", "-safe", "0", "-i", video["playlist"]]
    if duration_s:
        cmd += ["-t", str(duration_s)]
    if video:
        w, h = max(16, int(video["w"]) // 2 * 2), max(16, int(video["h"]) // 2 * 2)
        graph = ("[0:v]setpts=PTS-STARTPTS[bg];"
                 "[2:v]scale=%d:%d:flags=fast_bilinear,setpts=PTS-STARTPTS[fg];"
                 "[bg][fg]overlay=%d:%d:eof_action=%s:shortest=0[v]"
                 % (w, h, int(video["x"]), int(video["y"]), "repeat" if video.get("loop", True) else "pass"))
        audio_map = "1:a" if video.get("mute") else "2:a?"
        cmd += ["-filter_complex", graph, "-map", "[v]", "-map", audio_map]
    else:
        cmd += ["-map", "0:v", "-map", "1:a"]
    cmd += ["-pix_fmt", "yuv420p", "-threads", str(r.threads)]
    cmd += video_codec_args(conf)
    cmd += [
        "-c:a", o.audio_codec, "-b:a", "%dk" % o.audio_bitrate_kbps, "-ar", "48000", "-ac", "2",
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
