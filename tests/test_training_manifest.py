"""Checkpoint admission checks; no model libraries, GPU or training required."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('xim_train_multitask', Path(__file__).resolve().parents[1] / 'training/train_multitask.py')
training = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(training)


class TrainingManifestTests(unittest.TestCase):
    def test_pinned_qwen3_8b_has_36_layers_not_32(self):
        # Official b968826d config: 32 attention heads, but 36 hidden layers.
        with tempfile.TemporaryDirectory(prefix='xim-base-config-') as directory:
            base = Path(directory)
            (base / 'model.safetensors').write_bytes(b'only checks metadata; never loaded')
            config = {'model_type':'qwen3', 'hidden_size':4096, 'num_hidden_layers':36,
                      'num_attention_heads':32, 'num_key_value_heads':8}
            (base / 'config.json').write_text(json.dumps(config), encoding='utf-8')
            self.assertEqual(training.checked_model_dir(base), base.resolve())
            config['num_hidden_layers'] = 32
            (base / 'config.json').write_text(json.dumps(config), encoding='utf-8')
            with self.assertRaises(ValueError):
                training.checked_model_dir(base)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='xim-training-manifest-')
        self.root = Path(self.temporary.name).resolve()
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.weights = self.root / 'adapter_model.safetensors'
        self.weights.write_bytes(b'test checkpoint bytes; no model loading in this test')
        self.config = self.root / 'adapter_config.json'
        self.config.write_text('{"peft_type":"LORA","task_type":"CAUSAL_LM","r":16}', encoding='utf-8')
        self.manifest = {'status':'completed', 'stage':'sft', 'actual_steps':20,
                         'adapter_sha256':training.file_hash(self.weights),
                         'base_config_sha256':'a' * 64,
                         'base_weight_sha256':{'model-00001-of-00001.safetensors':'b' * 64}}
        self.write_manifest()

    def tearDown(self):
        self.temporary.cleanup()

    def write_manifest(self, changes=None):
        (self.root / 'run_manifest.json').write_text(json.dumps({**self.manifest, **(changes or {})}), encoding='utf-8')

    def test_completed_sft_and_grpo_are_accepted(self):
        for stage in ('sft', 'grpo'):
            self.write_manifest({'stage':stage})
            path, manifest = training.adapter_manifest(self.root)
            self.assertEqual(path, self.root)
            self.assertEqual(manifest['stage'], stage)

    def test_running_failed_unknown_stage_or_nonpositive_integer_steps_are_rejected(self):
        for changes in ({'status':'running'}, {'status':'failed'}, {'stage':'dpo'}, {'stage':None},
                        {'actual_steps':0}, {'actual_steps':-1}, {'actual_steps':True},
                        {'actual_steps':1.0}, {'actual_steps':'20'}):
            with self.subTest(changes=changes):
                self.write_manifest(changes)
                with self.assertRaises(ValueError):
                    training.adapter_manifest(self.root)

    def test_replaced_or_truncated_tensor_bytes_are_rejected(self):
        self.weights.write_bytes(b'replaced')
        with self.assertRaisesRegex(ValueError, 'checkpoint checksum'):
            training.adapter_manifest(self.root)

    def test_absent_invalid_or_empty_tensor_checksum_is_rejected(self):
        for value in (None, '', 'z' * 64, 'c' * 64):
            with self.subTest(value=value):
                self.write_manifest({'adapter_sha256':value})
                with self.assertRaisesRegex(ValueError, 'checkpoint checksum'):
                    training.adapter_manifest(self.root)
        self.weights.write_bytes(b'')
        self.write_manifest({'adapter_sha256':training.file_hash(self.weights)})
        with self.assertRaisesRegex(ValueError, 'checkpoint checksum'):
            training.adapter_manifest(self.root)

    def test_only_causal_lora_configuration_is_accepted(self):
        for config in ({'peft_type':'PREFIX_TUNING','task_type':'CAUSAL_LM'},
                       {'peft_type':'LORA','task_type':'SEQ_CLS'}, []):
            self.config.write_text(json.dumps(config), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'LoRA'):
                training.adapter_manifest(self.root)

    def test_invalid_or_missing_base_fingerprints_are_rejected(self):
        for changes in ({'base_config_sha256':None}, {'base_weight_sha256':{}},
                        {'base_weight_sha256':{'../model.safetensors':'b' * 64}},
                        {'base_weight_sha256':{'model.safetensors':'short'}},
                        {'base_weight_sha256':{'model.bin':'b' * 64}}):
            with self.subTest(changes=changes):
                self.write_manifest(changes)
                with self.assertRaisesRegex(ValueError, 'base weight fingerprints'):
                    training.adapter_manifest(self.root)

    def test_optional_recorded_configuration_hash_is_checked(self):
        self.write_manifest({'adapter_config_sha256':training.file_hash(self.config)})
        training.adapter_manifest(self.root)
        self.config.write_text('{"peft_type":"LORA","task_type":"CAUSAL_LM","r":32}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'configuration checksum'):
            training.adapter_manifest(self.root)

    def test_missing_required_file_or_nonobject_manifest_is_rejected(self):
        (self.root / 'run_manifest.json').write_text('[]', encoding='utf-8')
        with self.assertRaises(ValueError):
            training.adapter_manifest(self.root)
        self.write_manifest()
        self.config.unlink()
        with self.assertRaisesRegex(ValueError, 'completed local pilot'):
            training.adapter_manifest(self.root)


if __name__ == '__main__':
    unittest.main()
