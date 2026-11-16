"""Prepare a short Chinese public SFT pilot with pinned provenance and split checks.

OASST2 human messages are reconstructed through parent IDs. No response is
rewritten, no task/reward label is invented, and official validation trees
never enter training. The independent HelpSteer3 preference files stay for DPO.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import urllib.request

OASST_REVISION = "179dd21fc55192153d94adb0e0ce8f69e222bf75"
OASST_SHA = "a9f240c4c77aa1378364f70d37e753c07ba284e247b019d700e1947a0e5da751"
TOOLACE_REVISION = "6bda777c88d21e5a204703c1ee45597a8fa4f734"
TOOLACE_SHA = "ba12c083fca7e8da48c67ad5b895e495447da7c66e39a2e19742c082e6cb537e"
VALIDATION_SHA = "fd46c63babc0756909a957ee40975bcf5610d58c5d1ab5ff2c57c0f57be1f273"
VALIDATION_FILE = "data/validation-00000-of-00001-1deeef95c3248fe0.parquet"


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def fetch_validation_ids(root):
    """Explicit 3.18 MB pinned download; pyarrow is needed only for this step."""
    import pyarrow.parquet as pq
    source = root / "oasst2-validation.parquet"
    url = f"https://huggingface.co/datasets/OpenAssistant/oasst2/resolve/{OASST_REVISION}/{VALIDATION_FILE}"
    if not source.exists():
        with urllib.request.urlopen(url, timeout=60) as response:
            content = response.read(3_180_112)
        if len(content) != 3_180_111 or sha256(content) != VALIDATION_SHA:
            raise ValueError("validation_download_checksum_mismatch")
        source.write_bytes(content)
    if sha256(source.read_bytes()) != VALIDATION_SHA:
        raise ValueError("validation_source_checksum_mismatch")
    table = pq.read_table(source, columns=["message_id", "message_tree_id"])
    ids = sorted(set(table.column("message_id").to_pylist()))
    trees = sorted(set(table.column("message_tree_id").to_pylist()))
    if len(ids) != 6599:
        raise ValueError("validation_duplicate_or_missing_ids")
    result = {"dataset": "OpenAssistant/oasst2", "revision": OASST_REVISION,
              "split": "validation", "source_rows": 6599,
              "message_ids": ids, "tree_ids": trees,
              "source_url": url, "source_sha256": VALIDATION_SHA}
    (root / "oasst2-validation-tree-ids.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


def label(row, name, fallback=0):
    return row.get("labels", {}).get(name, {}).get("value", fallback)


def valid_message(row):
    text = row.get("text")
    return (row.get("lang") == "zh" and row.get("review_result") is True
            and not row.get("deleted") and row.get("synthetic") is False
            and isinstance(text, str) and text.strip() and "\ufffd" not in text
            and label(row, "pii") == 0 and label(row, "spam") == 0
            and label(row, "lang_mismatch") == 0)


def prepare_oasst(root, max_chars):
    raw_path = root / "oasst2-ready.messages.jsonl.gz"
    if sha256(raw_path.read_bytes()) != OASST_SHA:
        raise ValueError("oasst_source_checksum_mismatch")
    split_evidence = json.loads((root / "oasst2-validation-tree-ids.json").read_text(encoding="utf-8"))
    if (split_evidence["revision"] != OASST_REVISION
            or split_evidence.get("source_sha256") != VALIDATION_SHA
            or split_evidence["source_rows"] != 6599 or len(split_evidence["message_ids"]) != 6599):
        raise ValueError("invalid_official_split_evidence")
    validation_trees = set(split_evidence["tree_ids"])
    with gzip.open(raw_path, "rt", encoding="utf-8") as source:
        all_rows = {row["message_id"]: row for row in map(json.loads, source)}
    # The ready export is exactly the 128,575 + 6,599 official-split messages.
    if len(all_rows) != 135174 or not set(split_evidence["message_ids"]).issubset(all_rows):
        raise ValueError("export_does_not_match_official_split")
    candidates = []
    for row in all_rows.values():
        if not valid_message(row) or row["role"] != "assistant" or row.get("rank") != 0:
            continue
        if label(row, "quality") < 0.6:
            continue
        chain = []
        current = row
        seen = set()
        while current is not None and len(chain) < 12:
            key = current["message_id"]
            if key in seen or not valid_message(current):
                break
            seen.add(key)
            chain.append(current)
            parent_id = current.get("parent_id")
            if parent_id is None:
                chain.reverse()
                if len(chain) < 2 or sum(len(item["text"]) for item in chain) > max_chars:
                    break
                roles = ["user" if item["role"] == "prompter" else "assistant" for item in chain]
                if roles != ["user" if i % 2 == 0 else "assistant" for i in range(len(chain))]:
                    break
                if len(re.findall(r"[\u4e00-\u9fff]", chain[-1]["text"])) < 4:
                    break
                messages = [{"role": role, "content": item["text"]} for role, item in zip(roles, chain)]
                group = "oasst2:" + row["message_tree_id"]
                split = "validation" if row["message_tree_id"] in validation_trees else "train"
                candidates.append({"id": "oasst2:" + row["message_id"], "group_id": group,
                                   "split": split, "source": "OpenAssistant/oasst2", "synthetic": False,
                                   "dataset_revision": OASST_REVISION, "license": "Apache-2.0",
                                   "original_message_id": row["message_id"],
                                   "source_split": split, "source_sha256": OASST_SHA,
                                   "prompt": messages[:-1], "completion": messages[-1:], "messages": messages})
                break
            current = all_rows.get(parent_id)
    return candidates


def toolace_audit(root, max_chars):
    source = root / "toolace-data.json"
    if sha256(source.read_bytes()) != TOOLACE_SHA:
        raise ValueError("toolace_source_checksum_mismatch")
    rows = json.loads(source.read_text(encoding="utf-8"))
    chinese = []
    short = []
    for idx, row in enumerate(rows):
        if any(re.search(r"[\u4e00-\u9fff]", item["value"])
               for item in row["conversations"] if item["from"] == "user"):
            chinese.append(idx)
            if len(row["system"]) + sum(len(item["value"]) for item in row["conversations"]) <= max_chars:
                short.append(idx)
    # Manual review found the only two <=1000-character candidates unsuitable.
    # 6417 omits a requested second tool action; 8190 contradicts its date schema.
    # Do not truncate tool definitions or silently invent corrected labels.
    return {"dataset": "Team-ACE/ToolACE", "revision": TOOLACE_REVISION, "license": "Apache-2.0",
            "sha256": TOOLACE_SHA, "source_rows": len(rows), "chinese_user_rows": len(chinese),
            "short_candidate_indices": short, "included_in_pilot": 0,
            "reason": "No usable Chinese candidates under pilot length and semantic checks; source retained for future curation.",
            "synthetic": True}


def write_split(rows, split, limit, target):
    unique = {}
    for row in sorted((r for r in rows if r["split"] == split), key=lambda r: sha256(r["id"].encode())):
        unique.setdefault(row["group_id"], row)
    selected = list(unique.values())[:limit]
    if split == "train" and len(selected) < limit:
        raise ValueError("insufficient_reviewed_public_training_groups")
    with target.open("w", encoding="utf-8", newline="\n") as stream:
        for row in selected:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
    return selected, len(unique)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "multitask-public")
    parser.add_argument("--fetch-validation-ids", action="store_true")
    parser.add_argument("--train-limit", type=int, default=64)
    parser.add_argument("--validation-limit", type=int, default=16)
    parser.add_argument("--max-chars", type=int, default=800)
    args = parser.parse_args()
    if not 1 <= args.train_limit <= 128 or not 1 <= args.validation_limit <= 128 or not 1 <= args.max_chars <= 1000:
        parser.error("pilot requires train-limit 1..128 and max-chars 1..1000")
    if args.fetch_validation_ids:
        fetch_validation_ids(args.root)
    candidates = prepare_oasst(args.root, args.max_chars)
    train, train_available = write_split(candidates, "train", args.train_limit, args.root / "public-sft-train.jsonl")
    validation, validation_available = write_split(candidates, "validation", args.validation_limit, args.root / "public-sft-validation.jsonl")
    if {r["group_id"] for r in train} & {r["group_id"] for r in validation}:
        raise ValueError("split_leakage")
    report = {"train_rows": len(train), "validation_rows": len(validation),
              "available_distinct_train_trees": train_available, "available_distinct_validation_trees": validation_available,
              "max_chars": args.max_chars, "source": "OpenAssistant/oasst2", "dataset_revision": OASST_REVISION,
              "license": "Apache-2.0", "synthetic": False,
              "split_rule": "Use official validation tree IDs from the SHA-verified pinned parquet; exclude every validation tree from training; at most one target per tree.",
              "validation_source_sha256": VALIDATION_SHA,
              "toolace": toolace_audit(args.root, args.max_chars),
              "helpsteer3": "Not included in SFT or online-RL reward; separate human preference data retained for future DPO.",
              "quality_limit": "Source-reviewed rank-0 replies, not factuality-certified; no product-quality improvement claim."}
    (args.root / "public-sft-manifest.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
