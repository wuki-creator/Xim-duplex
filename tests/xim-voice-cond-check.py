"""Executable XimVoiceCond-v1 tensor-contract tests; no model weights required."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "training"))

import torch

from xim_voice_cond import (
    XimVoiceCondConfig,
    XimVoiceCondV1,
    pack_condition_chunk,
)


class XimVoiceCondContractTest(unittest.TestCase):
    def setUp(self) -> None:
        torch.manual_seed(17)
        self.config = XimVoiceCondConfig(
            d_xim=24,
            d_cv2=20,
            d_model=32,
            num_layers=2,
            num_heads=4,
            d_ff=64,
            max_seq_len=16,
            num_speakers=4,
            num_states=4,
            emotion_dim=8,
            speaker_dim=12,
            state_dim=8,
            prosody_hidden=16,
            dropout=0.0,
        )
        self.model = XimVoiceCondV1(self.config).eval()
        self.semantic = torch.randn(2, 6, 24)
        self.chunks = torch.tensor([[0, 0, 1, 1, 2, 2], [0, 0, 1, 1, 2, 2]])
        self.emotion = torch.tensor([0, 1])
        self.speaker = torch.tensor([0, 1])
        self.state = torch.tensor([0, 1])

    def forward(self, semantic=None, **overrides):
        arguments = {
            "emotion_id": self.emotion,
            "speaker_id": self.speaker,
            "state_id": self.state,
            "chunk_ids": self.chunks,
        }
        arguments.update(overrides)
        return self.model(self.semantic if semantic is None else semantic, **arguments)

    def test_output_tensor_contract(self):
        with torch.no_grad():
            output = self.forward()
        self.assertEqual(output.condition.shape, (2, 6, 20))
        self.assertEqual(output.prosody.shape, (2, 6, 3))
        self.assertIsNone(output.past_key_values)
        self.assertTrue(torch.isfinite(output.condition).all())
        self.assertTrue(torch.isfinite(output.prosody).all())

    def test_default_transformer_core_parameter_count(self):
        model = XimVoiceCondV1(XimVoiceCondConfig(d_xim=24, d_cv2=20))
        self.assertEqual(model.transformer_core_parameters(), 12_582_912)

    def test_future_chunks_cannot_change_past_chunks(self):
        with torch.no_grad():
            baseline = self.forward().condition
            changed = self.semantic.clone()
            changed[:, 2:] = torch.randn_like(changed[:, 2:]) * 4
            candidate = self.forward(changed).condition
        torch.testing.assert_close(
            baseline[:, :2], candidate[:, :2], rtol=0, atol=1e-6
        )

    def test_current_chunk_is_bidirectional(self):
        with torch.no_grad():
            baseline = self.forward().condition
            changed = self.semantic.clone()
            changed[:, 1] = torch.randn_like(changed[:, 1]) * 4
            candidate = self.forward(changed).condition
        self.assertFalse(torch.allclose(baseline[:, 0], candidate[:, 0]))

    def test_incremental_cache_matches_full_forward(self):
        semantic = self.semantic[:1]
        chunks = self.chunks[:1]
        ids = {
            "emotion_id": self.emotion[:1],
            "speaker_id": self.speaker[:1],
            "state_id": self.state[:1],
        }
        with torch.no_grad():
            full = self.model(semantic, chunk_ids=chunks, **ids)
            cache = None
            conditions, prosodies = [], []
            for start, end in ((0, 2), (2, 4), (4, 6)):
                output = self.model(
                    semantic[:, start:end],
                    chunk_ids=chunks[:, start:end],
                    past_key_values=cache,
                    use_cache=True,
                    **ids,
                )
                cache = output.past_key_values
                conditions.append(output.condition)
                prosodies.append(output.prosody)
            condition = torch.cat(conditions, dim=1)
            prosody = torch.cat(prosodies, dim=1)
        torch.testing.assert_close(condition, full.condition, rtol=1e-4, atol=1e-5)
        torch.testing.assert_close(prosody, full.prosody, rtol=1e-4, atol=1e-5)
        self.assertEqual(len(cache), self.config.num_layers)
        self.assertEqual(cache[0].key.shape, (1, 4, 6, 8))

    def test_split_chunk_is_rejected(self):
        ids = {
            "emotion_id": self.emotion[:1],
            "speaker_id": self.speaker[:1],
            "state_id": self.state[:1],
        }
        with torch.no_grad():
            first = self.model(
                self.semantic[:1, :1],
                chunk_ids=self.chunks[:1, :1],
                use_cache=True,
                **ids,
            )
            with self.assertRaisesRegex(ValueError, "strictly newer complete chunk"):
                self.model(
                    self.semantic[:1, 1:2],
                    chunk_ids=self.chunks[:1, 1:2],
                    past_key_values=first.past_key_values,
                    use_cache=True,
                    **ids,
                )

    def test_padding_is_masked_and_zeroed(self):
        semantic = self.semantic[:1, :5].clone()
        chunks = torch.tensor([[0, 0, 1, 1, 1]])
        mask = torch.tensor([[True, True, True, False, False]])
        ids = {
            "emotion_id": self.emotion[:1],
            "speaker_id": self.speaker[:1],
            "state_id": self.state[:1],
        }
        with torch.no_grad():
            baseline = self.model(
                semantic, chunk_ids=chunks, attention_mask=mask, **ids
            )
            changed = semantic.clone()
            changed[:, 3:] = 999
            candidate = self.model(
                changed, chunk_ids=chunks, attention_mask=mask, **ids
            )
        torch.testing.assert_close(
            baseline.condition[:, :3], candidate.condition[:, :3], rtol=0, atol=1e-6
        )
        self.assertEqual(torch.count_nonzero(baseline.condition[:, 3:]), 0)
        self.assertEqual(torch.count_nonzero(baseline.prosody[:, 3:]), 0)

    def test_film_conditions_change_the_output(self):
        with torch.no_grad():
            baseline = self.forward().condition
            emotion = self.forward(emotion_id=torch.tensor([2, 3])).condition
            speaker = self.forward(speaker_id=torch.tensor([2, 3])).condition
            state = self.forward(state_id=torch.tensor([2, 3])).condition
        for candidate in (emotion, speaker, state):
            self.assertFalse(torch.allclose(baseline, candidate))

    def test_gradients_reach_trainable_heads(self):
        output = self.forward()
        loss = output.condition.square().mean() + output.prosody.square().mean()
        loss.backward()
        self.assertIsNotNone(self.model.input_proj.weight.grad)
        self.assertIsNotNone(self.model.blocks[0].film.weight.grad)
        self.assertIsNotNone(self.model.prosody_head[-1].weight.grad)

    def test_invalid_tensor_contracts_are_rejected(self):
        with self.assertRaises(ValueError):
            self.forward(emotion_id=torch.tensor([6, 0]))
        with self.assertRaises(ValueError):
            self.forward(chunk_ids=torch.tensor([[0, 1, 0, 1, 2, 2], [0, 0, 1, 1, 2, 2]]))
        with self.assertRaises(ValueError):
            self.forward(attention_mask=torch.ones(2, 6, dtype=torch.long))
        with self.assertRaises(ValueError):
            self.model(torch.randn(2, 6, 23), emotion_id=self.emotion,
                       speaker_id=self.speaker, state_id=self.state, chunk_ids=self.chunks)

    def test_active_and_stale_condition_chunk_packaging(self):
        condition = torch.randn(3, 20)
        active = pack_condition_chunk(
            condition,
            chunk_id=4,
            generation_id=7,
            active_generation_id=7,
            text_start=2,
            text_end=9,
        )
        self.assertIsNotNone(active)
        self.assertEqual(active.condition.shape, (3, 20))
        stale = pack_condition_chunk(
            condition,
            chunk_id=5,
            generation_id=6,
            active_generation_id=7,
            text_start=9,
            text_end=12,
        )
        self.assertIsNone(stale)
        with self.assertRaises(ValueError):
            pack_condition_chunk(
                torch.randn(20),
                chunk_id=6,
                generation_id=7,
                active_generation_id=7,
                text_start=12,
                text_end=15,
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
