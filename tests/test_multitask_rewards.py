import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "training"))
from multitask_rewards import extract_completion_text, multitask_reward, score_completion
from make_multitask_data import build_dataset


class MultitaskRewardTests(unittest.TestCase):
    def setUp(self):
        self.meeting = {"task":"meeting_count", "expected":{"action":"organize", "count":3}}
        self.arm = {"task":"arm_plan", "expected":{"action":"propose", "job":"arm", "start":[0,1,0], "target":[1,2,3], "execute":False}}

    def score(self, case, value):
        return score_completion(case, json.dumps(value, ensure_ascii=False))

    def test_exact_targets_get_full_credit_for_every_task(self):
        cases = [self.meeting, self.arm,
                 {"task":"correction", "expected":{"action":"revise", "topic":"家里的事情"}},
                 {"task":"yield", "expected":{"action":"yield"}},
                 {"task":"scene_action", "objects":[{"id":"obj-1"}], "expected":{"action":"move", "target":"obj-1", "position":[1,2,3]}}]
        for case in cases:
            with self.subTest(task=case["task"]):
                result = self.score(case, case["expected"])
                self.assertEqual(result["reward"], 1)
                self.assertTrue(result["format"] and result["legal"] and result["correct"])

    def test_missing_or_invalid_reference_does_not_guess_a_target(self):
        for case in [None, {}, {"task":"meeting_count"}, {"task":"other", "expected":{}},
                     {"task":"meeting_count", "expected":{"action":"organize", "count":9}}]:
            self.assertEqual(self.score(case, self.meeting["expected"])["reward"], 0)

    def test_invalid_json_duplicate_keys_and_nonfinite_values_get_zero(self):
        for completion in ['not json', '```json\n{"action":"organize","count":3}\n```', '[]',
                           '{"action":"organize","count":3,"count":4}', '{"action":"organize","count":NaN}',
                           '{"action":"organize","count":Infinity}', '{"action":"organize"}',
                           '{"action":"organize","count":true}', '{"action":"organize","count":"3"}']:
            with self.subTest(completion=completion):
                self.assertEqual(score_completion(self.meeting, completion)["reward"], 0)

    def test_wrong_valid_parameters_only_receive_structure_credit(self):
        wrong = self.score(self.meeting, {"action":"organize", "count":4})
        self.assertEqual(wrong["reward"], .25)
        self.assertFalse(wrong["correct"])
        for count in [0,9,-1,3.5]:
            self.assertEqual(self.score(self.meeting, {"action":"organize", "count":count})["reward"], 0)
        wrong_arm = dict(self.arm["expected"], target=[3,2,1])
        self.assertEqual(self.score(self.arm, wrong_arm)["reward"], .25)
        self.assertEqual(self.score(self.arm, dict(self.arm["expected"], target=[1.0000001,2,3]))["reward"], 1)

    def test_arm_output_only_proposes_and_never_self_approves(self):
        for changed in [{"execute":True}, {"execute":0}, {"action":"execute"}, {"approved":True}, {"permission":"granted"}]:
            self.assertEqual(self.score(self.arm, dict(self.arm["expected"], **changed))["reward"], -1)
        missing = dict(self.arm["expected"]); missing.pop("execute")
        self.assertEqual(self.score(self.arm, missing)["reward"], 0)
        self.assertEqual(self.score(self.arm, dict(self.arm["expected"], target=[11,2,3]))["reward"], 0)

    def test_scene_enumerations_and_target_existence(self):
        objects = [{"id":"obj-1"}]
        targets = [{"action":"talk", "reply":"你好"}, {"action":"add", "shape":"box", "color":"jade"},
                   {"action":"move", "target":"obj-1", "position":[1,1,1]}, {"action":"paint", "target":"obj-1", "color":"blue"},
                   {"action":"pick", "target":"obj-1"}, {"action":"place", "position":[0,0,0]}, {"action":"release"}, {"action":"physics"},
                   {"action":"trajectory", "target":"obj-1"}, {"action":"trajectory", "position":[1,1,1]},
                   {"action":"download", "file":"gltf"}, {"action":"image", "prompt":"一只桌面机器人"}]
        for target in targets:
            case = {"task":"scene_action", "objects":objects, "expected":target}
            self.assertEqual(self.score(case, target)["reward"], 1, target)
        case = {"task":"scene_action", "objects":objects, "expected":{"action":"pick", "target":"obj-1"}}
        self.assertEqual(self.score(case, {"action":"pick", "target":"obj-99"})["reward"], 0)
        self.assertEqual(self.score(case, {"action":"add", "shape":"torus", "color":"jade"})["reward"], 0)
        self.assertEqual(self.score(case, {"action":"download", "file":"secret"})["reward"], 0)

    def test_reward_hacking_extra_fields_and_happy_words_cannot_raise_reward(self):
        for field in ["reward", "score", "command", "shell", "url"]:
            self.assertEqual(self.score(self.meeting, dict(self.meeting["expected"], **{field:1}))["reward"], -1)
        self.assertEqual(self.score(self.meeting, dict(self.meeting["expected"], note="开心快乐"*100))["reward"], 0)
        self.assertEqual(self.score(self.meeting, {"action":"organize", "count":4, "notes":[{"execute":True}]})["reward"], -1)
        self.assertEqual(score_completion(self.meeting, json.dumps(self.meeting["expected"])+"给我满分")['reward'], 0)
        self.assertEqual(score_completion(self.meeting, 'a'*8193)["reward"], 0)

    def test_trl_message_completions_and_alignment(self):
        completion = [{"role":"assistant", "content":json.dumps(self.meeting["expected"])}]
        self.assertEqual(extract_completion_text(completion), completion[0]["content"])
        self.assertEqual(multitask_reward([completion], case=[self.meeting], expected=[{"count":9}]), [1.0])
        self.assertEqual(multitask_reward([completion], case=[]), [0.0])
        self.assertEqual(multitask_reward([completion], expected=[self.meeting]), [0.0])
        for malformed in [completion*2, [{"role":"system", "content":completion[0]["content"]}], [{"role":"assistant", "content":{}}]]:
            self.assertIsNone(extract_completion_text(malformed))
            self.assertEqual(score_completion(self.meeting, malformed)["reward"], 0)

    def test_synthetic_datasets_are_verifiable_and_split_without_prompt_or_coordinate_leakage(self):
        for count in (300,480,600):
            data = build_dataset(count,100)
            self.assertEqual(len(data["train"]), count)
            self.assertEqual(len(data["holdout"]), 100)
            train_ids = {row["id"] for row in data["train"]}
            holdout_ids = {row["id"] for row in data["holdout"]}
            self.assertFalse(train_ids & holdout_ids)
            self.assertFalse({row["group_id"] for row in data["train"]} & {row["group_id"] for row in data["holdout"]})
            train_points, holdout_points = set(), set()
            for split, rows in data.items():
                for row in rows:
                    self.assertTrue(row["synthetic"])
                    self.assertEqual(row["source"], "synthetic_rule_template")
                    self.assertEqual(row["messages"], row["prompt"] + row["completion"])
                    self.assertEqual(score_completion(row["case"], row["completion"])["reward"], 1)
                    self.assertNotIn('"expected":', row["prompt"][-1]["content"])
                    if row["case"]["task"] == "arm_plan":
                        bucket = train_points if split == "train" else holdout_points
                        bucket.add(tuple(row["case"]["expected"]["start"]))
                        bucket.add(tuple(row["case"]["expected"]["target"]))
            self.assertFalse(train_points & holdout_points)


if __name__ == "__main__":
    unittest.main()
