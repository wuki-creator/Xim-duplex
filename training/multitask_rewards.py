"""Verifiable task rewards; no model, sentiment lexicon, or hidden-reasoning reward.

Each case supplies its own authoritative ``task``, ``expected`` JSON, and (for
object actions) ``objects``. JSON validity alone is not task success. These are
synthetic task constraints, not measurements of human preference or happiness.
"""
import json
import math
import re

TASKS = frozenset(("meeting_count", "scene_action", "correction", "yield", "arm_plan"))
SHAPES = frozenset(("box", "sphere", "cylinder"))
COLORS = frozenset(("amber", "jade", "coral", "ivory", "blue"))
FILES = frozenset(("scene", "blender", "gltf", "report"))
SCENE_ACTIONS = frozenset(("talk", "add", "move", "paint", "pick", "place", "release", "physics", "trajectory", "download", "image"))


def extract_completion_text(completion):
    """Accept TRL conversational completions or a plain generated string.

    Refuse multiple assistant messages, foreign roles, or coercion of arbitrary
    objects: the whole completion must be a single proposed JSON answer.
    """
    if isinstance(completion, str):
        return completion if len(completion) <= 8192 else None
    if isinstance(completion, list) and len(completion) == 1:
        message = completion[0]
        if isinstance(message, dict) and message.get("role") == "assistant":
            content = message.get("content")
            return content if isinstance(content, str) and len(content) <= 8192 else None
    return None


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_key")
        result[key] = value
    return result


def _reject_constant(_):
    raise ValueError("non_finite_json")


def _text(value, limit):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= limit


def _coord(value):
    return (isinstance(value, list) and len(value) == 3 and
            all(type(number) in (int, float) and math.isfinite(number) and abs(number) <= 10 for number in value))


def _keys(value, required, optional=()):
    return set(required) <= set(value) <= set(required) | set(optional)


def _object_exists(target, case):
    if not isinstance(target, str) or not re.fullmatch(r"obj-[0-9]{1,6}", target):
        return False
    objects = case.get("objects")
    return (isinstance(objects, list) and len(objects) <= 32 and
            any(isinstance(item, dict) and item.get("id") == target for item in objects))


def _unauthorized(value):
    """Completion data never grants approval or changes execution permissions."""
    if isinstance(value, dict):
        if any(key in value for key in ("command", "shell", "url", "approved", "permission", "reward", "score")):
            return True
        if "execute" in value and value["execute"] is not False:
            return True
        if value.get("action") in ("execute", "approve", "run", "shell", "exec", "download_url"):
            return True
        return any(_unauthorized(item) for item in value.values())
    if isinstance(value, list):
        return any(_unauthorized(item) for item in value)
    return False


def _legal(value, case):
    if not isinstance(value, dict) or _unauthorized(value):
        return False
    task, action = case.get("task"), value.get("action")
    if task == "meeting_count":
        return (_keys(value, ("action", "count")) and action == "organize" and
                type(value["count"]) is int and 1 <= value["count"] <= 8)
    if task == "correction":
        return _keys(value, ("action", "topic")) and action == "revise" and _text(value["topic"], 120)
    if task == "yield":
        return _keys(value, ("action",)) and action == "yield"
    if task == "arm_plan":
        return (_keys(value, ("action", "job", "start", "target", "execute")) and
                action == "propose" and value["job"] == "arm" and value["execute"] is False and
                _coord(value["start"]) and _coord(value["target"]))
    if task != "scene_action" or action not in SCENE_ACTIONS:
        return False
    if action == "talk":
        return _keys(value, ("action", "reply")) and _text(value["reply"], 400)
    if action == "add":
        return (_keys(value, ("action", "shape", "color"), ("name", "position")) and
                value["shape"] in SHAPES and value["color"] in COLORS and
                ("name" not in value or isinstance(value["name"], str) and len(value["name"]) <= 20) and
                ("position" not in value or value["position"] is None or _coord(value["position"])))
    if action == "move":
        return _keys(value, ("action", "target", "position")) and _object_exists(value["target"], case) and _coord(value["position"])
    if action == "paint":
        return _keys(value, ("action", "target", "color")) and _object_exists(value["target"], case) and value["color"] in COLORS
    if action == "pick":
        return _keys(value, ("action", "target")) and _object_exists(value["target"], case)
    if action == "place":
        return _keys(value, ("action", "position")) and _coord(value["position"])
    if action in ("release", "physics"):
        return _keys(value, ("action",))
    if action == "trajectory":
        return ((_keys(value, ("action", "target")) and _object_exists(value["target"], case)) or
                (_keys(value, ("action", "position")) and _coord(value["position"])))
    if action == "download":
        return _keys(value, ("action", "file")) and value["file"] in FILES
    if action == "image":
        return _keys(value, ("action", "prompt")) and _text(value["prompt"], 700)
    return False


def _same(actual, expected):
    if type(actual) in (int, float) and type(expected) in (int, float):
        return math.isclose(actual, expected, rel_tol=0, abs_tol=1e-6)
    if type(actual) is not type(expected):
        return False
    if isinstance(expected, dict):
        return set(actual) == set(expected) and all(_same(actual[key], value) for key, value in expected.items())
    if isinstance(expected, list):
        return len(actual) == len(expected) and all(_same(a, b) for a, b in zip(actual, expected))
    return actual == expected


def score_completion(case, completion):
    """Return score in [-1, 1] plus auditable structure/legality/correctness.

    Full credit requires exact task parameters, allowing only 1e-6 coordinate
    numeric tolerance. Legal but wrong proposals earn 0.25; malformed/unsupported
    answers earn zero. Unauthorized actions/permission overrides earn -1.
    Missing or invalid references always earn zero, never inferred from prompts.
    """
    result = {"reward":0.0, "format":False, "legal":False, "correct":False, "reason":"invalid_reference"}
    try:
        if (not isinstance(case, dict) or case.get("task") not in TASKS or
                not isinstance(case.get("expected"), dict) or not _legal(case["expected"], case)):
            return result
        text = extract_completion_text(completion)
        if text is None:
            return dict(result, reason="invalid_completion")
        value = json.loads(text, object_pairs_hook=_unique_object, parse_constant=_reject_constant)
        if not isinstance(value, dict):
            return dict(result, reason="json_object_required")
        result["format"] = True
        if _unauthorized(value):
            return dict(result, reward=-1.0, reason="unauthorized_action_or_reward_override")
        if not _legal(value, case):
            return dict(result, reason="invalid_schema_or_parameters")
        result["legal"] = True
        correct = _same(value, case["expected"])
        return dict(result, reward=1.0 if correct else 0.25, correct=correct,
                    reason="correct" if correct else "wrong_task_parameters")
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError):
        return dict(result, reason="invalid_json_or_schema")


def multitask_reward(completions, case=None, **_kwargs):
    """TRL GRPO reward adapter. Dataset ``case`` is a per-completion list.

    ``prompts``/``expected``/trainer metadata in extra kwargs do not override the
    ground truth. TRL repeats dataset columns alongside sampled completions.
    A misaligned/missing case column fails closed instead of broadcasting labels.
    """
    if not isinstance(completions, (list, tuple)):
        return []
    if not isinstance(case, (list, tuple)) or len(case) != len(completions):
        return [0.0 for _ in completions]
    return [score_completion(reference, completion)["reward"] for reference, completion in zip(case, completions)]
