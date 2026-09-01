"""Word-level timings for one voiceover WAV, using storygasted's MLX aligner.

    uv run --project "$(storygasted root)" \
        python bin/align_once.py --wav /tmp/vo.wav --text "..." --tempo 1.25

Runs under storygasted's venv because that is where mlx-audio and the
Qwen3-ForcedAligner weights live. The companion to bin/tts_once.py, and a thin
adapter for the same reason: the Node renderer reaches a model the Python
project already owns rather than duplicating it.

Prints one JSON line to stdout: {"words": [{"word", "start", "end"}, ...]}.
Everything the model logs goes to stderr, so stdout stays parseable.

--tempo is the atempo the renderer applied AFTER synthesis. The aligner is
handed the RAW wav, because feeding it a time-stretched one measurably degrades
the timings, so the timings come back on the raw timeline and are scaled here.
Align the raw audio, scale the numbers; never the other way round.
"""
import argparse
import contextlib
import json
import sys
from pathlib import Path

# Resolved, not hard-coded: this project moved from ~/Desktop/projects once
# already and took every reel down for 20 hours. STORYGASTED_HOME wins.
def _storygasted_root():
    import os
    for d in (os.environ.get("STORYGASTED_HOME"),
              Path.home() / "projects" / "storygasted",
              Path.home() / "Desktop" / "projects" / "storygasted"):
        if d and Path(d, "pyproject.toml").is_file():
            return Path(d)
    return Path.home() / "projects" / "storygasted"


SG = _storygasted_root()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True, help="the RAW voiceover, before atempo")
    ap.add_argument("--text", required=True, help="what the script asked the model to say")
    ap.add_argument("--tempo", type=float, default=1.0, help="atempo applied after synthesis")
    ap.add_argument("--language", default="English")
    a = ap.parse_args()

    sys.path.insert(0, str(SG / "src"))
    from storygasted import align

    with contextlib.redirect_stdout(sys.stderr):
        model = align._load(align.aligner_repo)
        result = model.generate(audio=a.wav, text=a.text, language=a.language)
        spoken = [
            {"word": it.text, "start": float(it.start_time), "end": float(it.end_time)}
            for it in result.items
        ]
        # The model transcribes what it HEARD; the caption has to read what the
        # script SAID. _stitch maps one onto the other with difflib, so a word
        # the model dropped or misheard still gets a sensible span instead of
        # shifting every caption after it.
        words = align._stitch(spoken, align._tokens(a.text))
        words = align._monotonic(words)

    scale = 1.0 / a.tempo if a.tempo else 1.0
    out = [
        {"word": w["word"], "start": round(w["start"] * scale, 3), "end": round(w["end"] * scale, 3)}
        for w in words
    ]
    print(json.dumps({"words": out}))


if __name__ == "__main__":
    main()
