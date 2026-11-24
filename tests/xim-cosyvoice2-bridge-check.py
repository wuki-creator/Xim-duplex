"""Interface-compatible CosyVoice 2 bridge tests; no upstream weights or audio."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "training"))

import torch
from torch import nn

from xim_cosyvoice2_bridge import (
    OFFICIAL_LLM_INPUT_SIZE,
    OFFICIAL_MIX_RATIO,
    OFFICIAL_SPEECH_TOKEN_SIZE,
    UPSTREAM_COMMIT,
    CosyVoice2ConditionBridge,
    read_cosyvoice2_interface,
    validate_official_cosyvoice2,
)
from xim_voice_cond import XimVoiceCondConfig, XimVoiceCondV1


class QwenEmbeddingCore(nn.Module):
    """Only the official Qwen2LM attribute chain needed by the adapter."""

    def __init__(self, dim: int, text_vocab: int = 64) -> None:
        super().__init__()
        self.embed_tokens = nn.Embedding(text_vocab, dim)


class QwenTextModelCore(nn.Module):
    def __init__(self, dim: int, text_vocab: int = 64) -> None:
        super().__init__()
        self.model = QwenEmbeddingCore(dim, text_vocab)


class QwenModelCore(nn.Module):
    def __init__(self, dim: int, text_vocab: int = 64) -> None:
        super().__init__()
        self.model = QwenTextModelCore(dim, text_vocab)


class Qwen2LMInterfaceDouble(nn.Module):
    """Small tensor-contract double, not CosyVoice 2 or a speech synthesizer."""

    def __init__(self, dim: int = 16, speech_vocab: int = 97) -> None:
        super().__init__()
        self.llm = QwenModelCore(dim)
        self.llm_input_size = dim
        self.speech_token_size = speech_vocab
        self.mix_ratio = (5, 15)
        self.llm_embedding = nn.Embedding(2, dim)
        self.speech_embedding = nn.Embedding(speech_vocab, dim)
        self.sos = 0
        self.task_id = 1
        self.calls = []

    def inference_wrapper(self, lm_input, sampling, min_len, max_len, uuid):
        self.calls.append({
            "lm_input": lm_input.detach().clone(),
            "sampling": sampling,
            "min_len": min_len,
            "max_len": max_len,
            "uuid": uuid,
        })
        # A deterministic, bounded tensor path stand-in, not generated speech.
        yield from range(101, 101 + min(2, max_len))


class CosyVoice2BridgeTest(unittest.TestCase):
    def setUp(self) -> None:
        torch.manual_seed(23)
        self.dim = 16
        self.llm = Qwen2LMInterfaceDouble(self.dim)
        self.bridge = CosyVoice2ConditionBridge(self.dim)
        self.text = torch.tensor([[3, 4, 5]])
        self.prompt_text = torch.tensor([[7, 8]])
        self.prompt_speech = torch.tensor([[9, 10]])
        self.condition = torch.randn(1, 3, self.dim)

    def build(self, **overrides):
        arguments = {
            "text": self.text,
            "prompt_text": self.prompt_text,
            "prompt_speech_token": self.prompt_speech,
            "condition": self.condition,
        }
        arguments.update(overrides)
        return self.bridge.build_lm_input(self.llm, **arguments)

    def target_embeddings(self):
        return self.llm.llm.model.model.embed_tokens(self.text)

    def test_official_contract_and_reduced_double(self):
        interface = read_cosyvoice2_interface(self.llm)
        self.assertEqual(interface.llm_input_size, self.dim)
        self.assertEqual(interface.speech_token_size, 97)
        self.assertEqual(interface.mix_ratio, OFFICIAL_MIX_RATIO)
        self.assertEqual(OFFICIAL_LLM_INPUT_SIZE, 896)
        self.assertEqual(OFFICIAL_SPEECH_TOKEN_SIZE, 6561)
        self.assertEqual(
            UPSTREAM_COMMIT, "074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc"
        )
        official = Qwen2LMInterfaceDouble(
            OFFICIAL_LLM_INPUT_SIZE, OFFICIAL_SPEECH_TOKEN_SIZE
        )
        self.assertEqual(validate_official_cosyvoice2(official).text_embedding_dim, 896)
        with self.assertRaisesRegex(ValueError, "llm_input_size=896"):
            validate_official_cosyvoice2(self.llm)

    def test_zero_gate_is_exact_identity(self):
        actual = self.bridge(self.target_embeddings(), self.condition)
        torch.testing.assert_close(actual, self.target_embeddings(), rtol=0, atol=0)
        self.assertEqual(self.bridge.gate.item(), 0.0)

    def test_nonzero_gate_only_changes_target_text(self):
        self.bridge.gate.data.fill_(0.5)
        actual = self.build()
        with torch.no_grad():
            baseline = self.build(condition=torch.zeros_like(self.condition))
        torch.testing.assert_close(actual[:, :3], baseline[:, :3], rtol=0, atol=0)
        torch.testing.assert_close(actual[:, 6:], baseline[:, 6:], rtol=0, atol=0)
        self.assertFalse(torch.allclose(actual[:, 3:6], baseline[:, 3:6]))
        self.assertEqual(actual.shape, (1, 9, self.dim))

    def test_condition_mask_and_empty_prompt_preserve_sequence_contract(self):
        self.bridge.gate.data.fill_(0.5)
        mask = torch.tensor([[True, False, True]])
        actual = self.build(
            prompt_text=torch.empty(1, 0, dtype=torch.long),
            prompt_speech_token=torch.empty(1, 0, dtype=torch.long),
            condition_mask=mask,
        )
        self.assertEqual(actual.shape, (1, 5, self.dim))
        target = actual[:, 1:4]
        original = self.target_embeddings()
        torch.testing.assert_close(target[:, 1], original[:, 1], rtol=0, atol=0)
        self.assertFalse(torch.allclose(target[:, 0], original[:, 0]))

    def test_sequential_batch_one_dry_runs_have_bounded_budgets(self):
        results = []
        for index, text in enumerate((self.text, torch.tensor([[11, 12]]))):
            condition = torch.randn(1, text.shape[1], self.dim)
            results.append(self.bridge.dry_run(
                self.llm,
                text=text,
                prompt_text=self.prompt_text,
                prompt_speech_token=self.prompt_speech,
                condition=condition,
                sampling=17,
                min_token_text_ratio=1,
                max_token_text_ratio=5,
                max_tokens=3,
                uuid=f"interface-double-{index}",
            ))
        self.assertEqual(len(self.llm.calls), 2)
        self.assertEqual([result.lm_input_shape for result in results], [(1, 9, 16), (1, 8, 16)])
        self.assertEqual([result.speech_tokens for result in results], [(101, 102)] * 2)
        self.assertEqual([result.max_len for result in results], [3, 3])
        self.assertEqual(self.llm.calls[0]["sampling"], 17)
        self.assertEqual(self.llm.calls[0]["uuid"], "interface-double-0")
        self.assertEqual(self.llm.calls[1]["uuid"], "interface-double-1")
        self.assertEqual(results[0].wrapper_class, "Qwen2LMInterfaceDouble")

    def test_gradients_reach_gate_and_condition(self):
        self.bridge.gate.data.fill_(0.25)
        condition = self.condition.clone().requires_grad_(True)
        output = self.bridge(self.target_embeddings(), condition)
        output.square().mean().backward()
        self.assertIsNotNone(condition.grad)
        self.assertIsNotNone(self.bridge.gate.grad)
        self.assertGreater(condition.grad.abs().sum().item(), 0.0)
        self.assertNotEqual(self.bridge.gate.grad.item(), 0.0)

    def test_invalid_tensor_contracts_are_rejected(self):
        bad_calls = (
            {"text": self.text[:, :0]},
            {"text": self.text.float()},
            {"condition": torch.randn(1, 2, self.dim)},
            {"condition": torch.full_like(self.condition, float("nan"))},
            {"condition_mask": torch.ones(1, 3, dtype=torch.long)},
            {"condition_mask": torch.ones(1, 2, dtype=torch.bool)},
        )
        for overrides in bad_calls:
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                self.build(**overrides)
        with self.assertRaises(ValueError):
            self.bridge(torch.randn(3, self.dim), torch.randn(3, self.dim))
        with self.assertRaises(ValueError):
            self.bridge(self.target_embeddings(), self.condition.long())
        with self.assertRaises(ValueError):
            self.bridge(self.target_embeddings().long(), self.condition)

    def test_invalid_interface_and_budgets_are_rejected(self):
        with self.assertRaises(ValueError):
            read_cosyvoice2_interface(object())
        with self.assertRaisesRegex(ValueError, "do not match"):
            CosyVoice2ConditionBridge(self.dim + 1).build_lm_input(
                self.llm,
                text=self.text,
                prompt_text=self.prompt_text,
                prompt_speech_token=self.prompt_speech,
                condition=torch.randn(1, 3, self.dim + 1),
            )
        for budget in (
            {"max_tokens": 0},
            {"max_tokens": 1.5},
            {"min_token_text_ratio": -1},
            {"min_token_text_ratio": 3, "max_token_text_ratio": 2},
        ):
            with self.subTest(budget=budget), self.assertRaises(ValueError):
                self.bridge.dry_run(
                    self.llm,
                    text=self.text,
                    prompt_text=self.prompt_text,
                    prompt_speech_token=self.prompt_speech,
                    condition=self.condition,
                    **budget,
                )

    def test_untrained_xim_voice_cond_connects_to_interface_double(self):
        model = XimVoiceCondV1(XimVoiceCondConfig(
            d_xim=24,
            d_cv2=896,
            d_model=32,
            num_layers=1,
            num_heads=4,
            d_ff=64,
            max_seq_len=16,
            emotion_dim=8,
            speaker_dim=12,
            state_dim=8,
            prosody_hidden=16,
        )).eval()
        llm = Qwen2LMInterfaceDouble(896)
        bridge = CosyVoice2ConditionBridge(896)
        self.assertEqual(model.config.d_cv2, 896)
        with torch.no_grad():
            output = model(
                torch.randn(1, 3, 24),
                emotion_id=torch.tensor([0]),
                speaker_id=torch.tensor([0]),
                state_id=torch.tensor([0]),
                chunk_ids=torch.tensor([[0, 0, 1]]),
            )
            result = bridge.dry_run(
                llm,
                text=self.text,
                prompt_text=self.prompt_text,
                prompt_speech_token=self.prompt_speech,
                condition=output.condition,
                max_tokens=3,
                uuid="xim-voice-cond-interface-double",
            )
        self.assertEqual(result.lm_input_shape, (1, 9, 896))
        self.assertEqual(result.speech_tokens, (101, 102))
        self.assertEqual(result.max_len, 3)
        self.assertEqual(result.uuid, "xim-voice-cond-interface-double")
        self.assertEqual(len(llm.calls), 1)
        self.assertTrue(torch.isfinite(llm.calls[0]["lm_input"]).all())


if __name__ == "__main__":
    unittest.main(verbosity=2)
