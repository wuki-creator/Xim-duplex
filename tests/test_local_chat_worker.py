"""Worker checks with fake models/tokenizers; no PyTorch or GPU required."""
from contextlib import nullcontext
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

SPEC = importlib.util.spec_from_file_location('xim_local_chat_worker', Path(__file__).resolve().parents[1] / 'scripts/local_chat_worker.py')
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class FakeInputs(dict):
    def __init__(self, size=3):
        self.input_ids = SimpleNamespace(shape=(1, size))
        super().__init__(input_ids=self.input_ids)

    def to(self, device):
        self.device = device
        return self


class FakeTokenizer:
    eos_token_id = 99

    def __init__(self, raw='你好', text='你好', size=3):
        self.raw, self.text, self.size = raw, text, size
        self.template_kwargs = None
        self.decode_calls = []

    def apply_chat_template(self, messages, **kwargs):
        self.template_kwargs = kwargs
        return 'rendered prompt'

    def __call__(self, prompt, **kwargs):
        self.tokenizer_kwargs = kwargs
        return FakeInputs(self.size)

    def decode(self, tokens, *, skip_special_tokens):
        self.decode_calls.append(skip_special_tokens)
        return self.text if skip_special_tokens else self.raw


class FakeModel:
    config = SimpleNamespace(max_position_embeddings=32768)

    def __init__(self, output=None):
        self.output = output if output is not None else [[1, 2, 3, 4, 99]]
        self.calls = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        return self.output


class LocalWorkerTests(unittest.TestCase):
    def invoke(self, tokenizer=None, model=None, limit=10, maximum=100):
        return worker.generate_reply(tokenizer or FakeTokenizer(), model or FakeModel(),
                                     [{'role': 'user', 'content': '你好'}], limit,
                                     device='fake', max_input_tokens=maximum, inference_mode=nullcontext)

    def test_qwen_template_disables_thinking_and_generation_is_bounded(self):
        tokenizer, model = FakeTokenizer(), FakeModel()
        result = self.invoke(tokenizer, model, limit=10)
        self.assertIs(tokenizer.template_kwargs['enable_thinking'], False)
        self.assertIs(tokenizer.tokenizer_kwargs['add_special_tokens'], False)
        self.assertEqual(model.calls[0]['max_new_tokens'], 10)
        self.assertIs(model.calls[0]['do_sample'], False)
        self.assertEqual(result['choices'][0]['message']['content'], '你好')
        self.assertEqual(result['choices'][0]['finish_reason'], 'stop')
        self.assertEqual(tokenizer.decode_calls, [False, True])

    def test_raw_reasoning_rejected_before_special_tokens_removed(self):
        for raw in ('<think>private</think>你好', '<think>unfinished', '</think>你好', '<analysis>private</analysis>'):
            tokenizer = FakeTokenizer(raw=raw, text='private你好')
            with self.subTest(raw=raw), self.assertRaisesRegex(RuntimeError, 'reasoning'):
                self.invoke(tokenizer)
            self.assertEqual(tokenizer.decode_calls, [False])

    def test_prompt_limit_rejects_before_generating(self):
        model = FakeModel()
        with self.assertRaisesRegex(ValueError, 'input token limit'):
            self.invoke(FakeTokenizer(size=101), model, maximum=100)
        self.assertEqual(model.calls, [])

    def test_output_limit_reports_length_without_eos(self):
        result = self.invoke(model=FakeModel([[1, 2, 3, 4, 5]]), limit=2)
        self.assertEqual(result['choices'][0]['finish_reason'], 'length')

    def test_request_contract_retains_default_model_and_clamps_output(self):
        request = {'model': 'Qwen2.5-1.5B-Instruct', 'messages': [{'role': 'user', 'content': 'hi'}], 'max_tokens': 99999}
        self.assertEqual(worker.validate_request(request, request['model'])[1], 1200)
        with self.assertRaises(ValueError):
            worker.validate_request({**request, 'max_tokens': True}, request['model'])
        with self.assertRaises(ValueError):
            worker.validate_request(request, 'other-model')

    def test_health_reports_base_and_adapter_without_private_paths(self):
        for adapter in (None, {'path':'/private/candidate', 'stage':'grpo', 'actual_steps':8,
                              'sha256':'a' * 64, 'pilot_only':True}):
            handler_type = worker.make_handler(tokenizer=FakeTokenizer(), model=FakeModel(),
                served_model='local-test', base_model='Qwen/Qwen3-8B', adapter=adapter,
                max_input_tokens=1024, inference_mode=nullcontext)
            handler = object.__new__(handler_type)
            handler.path = '/health'
            responses = []
            handler.send_json = lambda status, body: responses.append((status, body))
            handler.do_GET()
            status, body = responses[0]
            self.assertEqual(status, 200)
            self.assertEqual(body['base_model'], 'Qwen/Qwen3-8B')
            self.assertEqual(body['adapter'], bool(adapter))
            self.assertNotIn('/private', json.dumps(body))
            self.assertIs(body['thinking_enabled'], False)

    def test_total_context_budget_rejects_before_generation(self):
        model = FakeModel()
        model.config = SimpleNamespace(max_position_embeddings=5)
        with self.assertRaisesRegex(ValueError, 'context token limit'):
            self.invoke(model=model, limit=10)
        self.assertEqual(model.calls, [])

    def test_adapter_requires_completed_steps_and_exact_base_and_adapter_bytes(self):
        temporary = tempfile.TemporaryDirectory(prefix='xim-worker-test-')
        root = Path(temporary.name).resolve()
        self.assertEqual(root.parent, Path(tempfile.gettempdir()).resolve())
        try:
            base, adapter = root / 'base', root / 'adapter'
            base.mkdir(); adapter.mkdir()
            (base / 'config.json').write_text('{"model_type":"qwen3"}', encoding='utf-8')
            (base / 'model.safetensors').write_bytes(b'fake base weights')
            (adapter / 'adapter_model.safetensors').write_bytes(b'fake adapter weights')
            (adapter / 'adapter_config.json').write_text('{"peft_type":"LORA","task_type":"CAUSAL_LM"}', encoding='utf-8')
            manifest = {'status': 'completed', 'actual_steps': 8, 'stage': 'grpo', 'pilot_only': True,
                        'base_model': 'Qwen/Qwen3-8B', 'base_config_sha256': worker.file_hash(base / 'config.json'),
                        'base_weight_sha256': {'model.safetensors': worker.file_hash(base / 'model.safetensors')},
                        'adapter_sha256': worker.file_hash(adapter / 'adapter_model.safetensors')}
            path = adapter / 'run_manifest.json'
            path.write_text(json.dumps(manifest), encoding='utf-8')
            self.assertEqual(worker.validate_adapter(base, adapter)['actual_steps'], 8)
            for changes in ({'status': 'running'}, {'actual_steps': 0}, {'actual_steps': True}, {'base_config_sha256': 'bad'},
                            {'base_weight_sha256': {}}, {'adapter_sha256': 'bad'}):
                with self.subTest(changes=changes):
                    path.write_text(json.dumps({**manifest, **changes}), encoding='utf-8')
                    with self.assertRaises(ValueError):
                        worker.validate_adapter(base, adapter)
            path.write_text(json.dumps(manifest), encoding='utf-8')
            (base / 'extra.safetensors').write_bytes(b'unexpected shard')
            with self.assertRaisesRegex(ValueError, 'base weight'):
                worker.validate_adapter(base, adapter)
        finally:
            temporary.cleanup()


if __name__ == '__main__':
    unittest.main()
