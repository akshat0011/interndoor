"""Synthesise one line of voiceover to a WAV, using storygasted's MLX TTS.

    uv run --project ~/Desktop/projects/storygasted \
        python bin/tts_once.py --text "..." --out /tmp/vo.wav

Runs under storygasted's venv because that is where mlx-audio and the
Qwen3-TTS weights live. Nothing is duplicated here — this is a thin adapter
so the Node renderer can reach a model the Python project already owns.

Prints one JSON line to stdout: {"wav": path, "seconds": float}.
Everything the model logs goes to stderr, so stdout stays parseable.
"""
import argparse
import contextlib
import json
import sys
import wave
from pathlib import Path

SG = Path.home() / "Desktop" / "projects" / "storygasted"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--voice", default=None, help="a profile name from storygasted config.yaml")
    ap.add_argument("--instruct", default=None, help="delivery direction for the model")
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()

    sys.path.insert(0, str(SG / "src"))
    from storygasted import config, tts

    c = config.load(SG / "config.yaml")
    if a.voice:
        c = config.use_voice(c, a.voice)

    dst = Path(a.out)
    dst.parent.mkdir(parents=True, exist_ok=True)

    # The model chatters on stdout; the caller parses stdout. Push everything
    # it prints to stderr so a stray progress line cannot corrupt the JSON.
    with contextlib.redirect_stdout(sys.stderr):
        tts.say(a.text, c, dst, instruct=a.instruct, seed=a.seed)

    with contextlib.closing(wave.open(str(dst), "rb")) as w:
        seconds = w.getnframes() / float(w.getframerate())

    print(json.dumps({"wav": str(dst), "seconds": round(seconds, 3)}))


if __name__ == "__main__":
    main()
