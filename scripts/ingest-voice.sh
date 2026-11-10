#!/usr/bin/env bash
# Ingest the founder's Voice Memos into the demo video's voice slots.
#
#   scripts/ingest-voice.sh [source_dir]     (default: ~/Downloads)
#
# Looks for one recording per scene code, named like "A1.m4a" (also .wav/.mp3/.aac/.caf;
# case-insensitive). The newest match wins. Each one is cleaned and written to
# demo/v2/voice/<CODE>.wav:
#   - 80 Hz high-pass (rumble, handling noise), gentle FFT denoise
#   - light compression, then loudness-normalised to -16 LUFS (the render mixes to -14)
#   - leading/trailing silence trimmed, 0.15 s of air kept at each end
# Nothing is uploaded; originals are left where they are.
set -euo pipefail

SRC="${1:-$HOME/Downloads}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/demo/v2/voice"
mkdir -p "$OUT"
CODES=(A1 O1 O2 O3 A2 C D E F REJ G W H I K R J1 Z)
missing=()

for code in "${CODES[@]}"; do
  match="$(find "$SRC" -maxdepth 1 -type f \( -iname "${code}.m4a" -o -iname "${code}.wav" -o -iname "${code}.mp3" -o -iname "${code}.aac" -o -iname "${code}.caf" -o -iname "${code} *.m4a" \) -print0 2>/dev/null \
    | xargs -0 ls -t 2>/dev/null | head -1 || true)"
  if [[ -z "$match" ]]; then missing+=("$code"); continue; fi
  ffmpeg -hide_banner -loglevel error -y -i "$match" -ac 1 -ar 48000 -af \
    "highpass=f=80,afftdn=nf=-28,acompressor=threshold=-20dB:ratio=2.5:attack=8:release=120,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15,areverse,loudnorm=I=-16:TP=-1.5:LRA=7" \
    "$OUT/${code}.wav"
  secs="$(ffmpeg -hide_banner -i "$OUT/${code}.wav" -f null - 2>&1 | grep -o 'time=[0-9:.]*' | tail -1 | cut -d= -f2)"
  echo "ok  ${code}  <- $(basename "$match")  (${secs})"
done

if ((${#missing[@]})); then
  echo "missing: ${missing[*]}  (those scenes keep the draft voice)"
fi
