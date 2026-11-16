#!/usr/bin/env bash
set -euo pipefail
# Training uses OpenMOSS upstream code; point to independently prepared, licensed data.
: "${XIM_NANO_REPO:?Set XIM_NANO_REPO to the pinned MOSS-TTS-Nano checkout}"
: "${XIM_TRAIN_MANIFEST:?Set XIM_TRAIN_MANIFEST to the train_raw.jsonl path}"
: "${XIM_HOLDOUT_MANIFEST:?Set XIM_HOLDOUT_MANIFEST to the holdout_raw.jsonl path}"
: "${XIM_BASE_MODEL:?Set XIM_BASE_MODEL to the original Nano model directory}"
: "${XIM_CODEC_MODEL:?Set XIM_CODEC_MODEL to the audio tokenizer directory}"
: "${XIM_RUN_DIR:?Set XIM_RUN_DIR to a new output directory on a suitable data disk}"
[[ ! -e "$XIM_RUN_DIR" ]] || { printf '%s\n' 'Output already exists; choose a new run directory.' >&2; exit 1; }
[[ -f "$XIM_NANO_REPO/finetuning/run_train.sh" && -f "$XIM_TRAIN_MANIFEST" && -f "$XIM_HOLDOUT_MANIFEST" ]] || { printf '%s\n' 'Missing repository or manifests.' >&2; exit 1; }
python - "$XIM_TRAIN_MANIFEST" "$XIM_HOLDOUT_MANIFEST" <<'PY'
import json, pathlib, sys
splits=[]
for filename in sys.argv[1:]:
    rows=[json.loads(line) for line in pathlib.Path(filename).read_text(encoding='utf-8').splitlines() if line.strip()]
    if not rows or any(not pathlib.Path(row.get('audio','')).is_file() or not row.get('text') for row in rows):raise SystemExit('Invalid audio/text manifest')
    splits.append(rows)
if len(splits[0]) < 1000 or len(splits[1]) < 100:raise SystemExit('Development sample is too small. Prepare at least 1000 training and 100 independent holdout utterances.')
speakers=[{pathlib.Path(row['audio']).parent.name for row in group} for group in splits]
if speakers[0] & speakers[1]:raise SystemExit('Train and holdout speakers overlap.')
PY
mkdir -p "$XIM_RUN_DIR"
git -C "$XIM_NANO_REPO" rev-parse HEAD > "$XIM_RUN_DIR/upstream-revision.txt"
printf '%s\n' 'The holdout set is reserved for evaluation and is not supplied to the trainer.' > "$XIM_RUN_DIR/holdout-policy.txt"
MODEL_PATH="$XIM_BASE_MODEL" CODEC_PATH="$XIM_CODEC_MODEL" RAW_JSONL="$XIM_TRAIN_MANIFEST" \
 PREPARED_JSONL="$XIM_RUN_DIR/train_with_codes.jsonl" OUTPUT_DIR="$XIM_RUN_DIR/checkpoints" \
 "$XIM_NANO_REPO/finetuning/run_train.sh"
