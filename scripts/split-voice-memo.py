#!/usr/bin/env python3
r"""Split one long Voice Memo (all lines read in order, ~3 s pause between) into
one file per scene code, then hand them to scripts/ingest-voice.sh.

    python3 scripts/split-voice-memo.py ~/Downloads/All\ lines.m4a
    python3 scripts/split-voice-memo.py memo.m4a --skip 5,9      drop takes 5 and 9 (1-based) before mapping
    python3 scripts/split-voice-memo.py memo.m4a --dry-run       list the takes found, write nothing

Takes are found with ffmpeg silencedetect (pauses of 1.6 s or more below -38 dB).
If the number of takes left after --skip is not exactly the number of codes, it
writes nothing and lists every take with its start and length, so the founder's
re-reads can be dropped with --skip. Originals are never touched.
"""
import argparse
import re
import subprocess
import sys
import tempfile
from pathlib import Path

CODES = ["A1", "O1", "O2", "O3", "A2", "C", "D", "E", "F", "REJ", "G", "W", "H", "I", "K", "R", "J1", "Z"]
ROOT = Path(__file__).resolve().parent.parent


def duration(path: Path) -> float:
    err = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
    if not m:
        raise SystemExit(f"cannot read duration of {path}")
    h, mi, se = m.groups()
    return int(h) * 3600 + int(mi) * 60 + float(se)


def takes(path: Path, noise_db: float, min_pause: float, min_take: float) -> list[tuple[float, float]]:
    err = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af",
         f"highpass=f=80,silencedetect=noise={noise_db}dB:d={min_pause}", "-f", "null", "-"],
        capture_output=True, text=True,
    ).stderr
    starts = [float(m) for m in re.findall(r"silence_start: (-?[\d.]+)", err)]
    ends = [float(m) for m in re.findall(r"silence_end: ([\d.]+)", err)]
    total = duration(path)
    # Speech runs between silences: [0, s0], [e0, s1], ..., [e_last, total]
    bounds, cursor = [], 0.0
    for i, s in enumerate(starts):
        bounds.append((cursor, max(cursor, s)))
        cursor = ends[i] if i < len(ends) else total
    bounds.append((cursor, total))
    return [(a, b) for a, b in bounds if b - a >= min_take]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("memo", type=Path)
    ap.add_argument("--skip", default="", help="1-based take numbers to drop (re-reads), comma separated")
    ap.add_argument("--noise", type=float, default=-38.0)
    ap.add_argument("--pause", type=float, default=1.6)
    ap.add_argument("--min-take", type=float, default=0.6)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    if not a.memo.is_file():
        print(f"no such file: {a.memo}", file=sys.stderr)
        return 2
    found = takes(a.memo, a.noise, a.pause, a.min_take)
    skip = {int(x) for x in a.skip.split(",") if x.strip()}
    kept = [t for i, t in enumerate(found, 1) if i not in skip]

    print(f"{len(found)} takes found, {len(kept)} kept, {len(CODES)} codes")
    code_iter = iter(CODES)
    for i, (s, e) in enumerate(found, 1):
        tag = "skip" if i in skip else (next(code_iter, "EXTRA"))
        print(f"  take {i:2d}  {s:7.2f}s  {e - s:5.2f}s  -> {tag}")

    if len(kept) != len(CODES):
        print(
            f"\nnot writing: {len(kept)} takes for {len(CODES)} codes. "
            "Drop re-reads with --skip, or adjust --pause / --noise.",
            file=sys.stderr,
        )
        return 1
    if a.dry_run:
        return 0

    with tempfile.TemporaryDirectory(prefix="voice-split-") as tmp:
        for code, (s, e) in zip(CODES, kept):
            pad_s, pad_e = max(0.0, s - 0.25), e + 0.25
            subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(a.memo),
                 "-ss", f"{pad_s:.3f}", "-to", f"{pad_e:.3f}", "-ac", "1", "-ar", "48000",
                 str(Path(tmp) / f"{code}.wav")],
                check=True,
            )
        subprocess.run(["bash", str(ROOT / "scripts" / "ingest-voice.sh"), tmp], check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
