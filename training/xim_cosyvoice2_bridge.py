"""XimVoiceCond-v1 to CosyVoice 2 Qwen2LM condition bridge.

Upstream contract reviewed at CosyVoice commit
074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc. Qwen2LM accepts text-token
embeddings inside lm_input; it has no arbitrary condition-tensor argument.
This module adds a gated residual to target-text embeddings while preserving
prompt text, task markers, prompt speech tokens and sequence lengths.

No upstream weights are bundled and no waveform is produced by this adapter.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator, Optional
from uuid import uuid4

import torch
from torch import Tensor, nn


OFFICIAL_LLM_INPUT_SIZE = 896
OFFICIAL_SPEECH_TOKEN_SIZE = 6561
OFFICIAL_MIX_RATIO = (5, 15)
UPSTREAM_COMMIT = "074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc"


@dataclass(frozen=True)
class CosyVoice2Interface:
    llm_input_size: int
    speech_token_size: int
    text_embedding_dim: int
    mix_ratio: tuple[int, int]


@dataclass(frozen=True)
class CosyVoice2DryRunResult:
    lm_input_shape: tuple[int, ...]
    speech_tokens: tuple[int, ...]
    llm_input_size: int
    min_len: int
    max_len: int
    uuid: str
    wrapper_class: str


def read_cosyvoice2_interface(llm: object) -> CosyVoice2Interface:
    """Read and validate the real Qwen2LM tensor contract without importing it."""

    try:
        text_embedding = llm.llm.model.model.embed_tokens
        llm_input_size = int(llm.llm_input_size)
        speech_token_size = int(llm.speech_token_size)
        text_embedding_dim = int(text_embedding.weight.shape[1])
        marker_dim = int(llm.llm_embedding.weight.shape[1])
        speech_embedding_dim = int(llm.speech_embedding.weight.shape[1])
        mix_ratio = tuple(int(value) for value in llm.mix_ratio)
    except (AttributeError, TypeError, ValueError) as error:
        raise ValueError("Expected a CosyVoice 2 Qwen2LM-compatible object") from error
    if not callable(getattr(llm, "inference_wrapper", None)):
        raise ValueError("Qwen2LM.inference_wrapper is required for dry-run")
    if not llm_input_size == text_embedding_dim == marker_dim == speech_embedding_dim:
        raise ValueError("Text, marker and speech embedding dimensions must match llm_input_size")
    if len(mix_ratio) != 2 or min(mix_ratio) <= 0:
        raise ValueError("Invalid CosyVoice 2 text/speech mix_ratio")
    return CosyVoice2Interface(
        llm_input_size,
        speech_token_size,
        text_embedding_dim,
        mix_ratio,
    )


def validate_official_cosyvoice2(llm: object) -> CosyVoice2Interface:
    """Require the published CosyVoice2-0.5B dimensions, not a reduced test double."""

    interface = read_cosyvoice2_interface(llm)
    if interface.llm_input_size != OFFICIAL_LLM_INPUT_SIZE:
        raise ValueError("Official CosyVoice2-0.5B requires llm_input_size=896")
    if interface.speech_token_size != OFFICIAL_SPEECH_TOKEN_SIZE:
        raise ValueError("Official CosyVoice2-0.5B requires speech_token_size=6561")
    if interface.mix_ratio != OFFICIAL_MIX_RATIO:
        raise ValueError("Official CosyVoice2-0.5B requires mix_ratio=(5, 15)")
    return interface


def _validate_tokens(name: str, value: Tensor, *, allow_empty: bool) -> None:
    if value.ndim != 2 or value.shape[0] != 1 or value.dtype != torch.long:
        raise ValueError(f"{name} must be a torch.long tensor with shape [1, T]")
    if not allow_empty and value.shape[1] == 0:
        raise ValueError(f"{name} must contain at least one token")


class CosyVoice2ConditionBridge(nn.Module):
    """Gated residual condition injection at the Qwen2LM text-embedding boundary."""

    def __init__(self, llm_input_size: int) -> None:
        super().__init__()
        if not isinstance(llm_input_size, int) or llm_input_size <= 0:
            raise ValueError("llm_input_size must be a positive integer")
        self.llm_input_size = llm_input_size
        self.condition_norm = nn.LayerNorm(llm_input_size)
        # Zero is intentional: an untrained condition model starts as an identity path.
        self.gate = nn.Parameter(torch.tensor(0.0))

    def forward(
        self,
        text_token_emb: Tensor,
        condition: Tensor,
        condition_mask: Optional[Tensor] = None,
    ) -> Tensor:
        if text_token_emb.ndim != 3:
            raise ValueError("text_token_emb must have shape [B, T, llm_input_size]")
        expected = (text_token_emb.shape[0], text_token_emb.shape[1], self.llm_input_size)
        if tuple(text_token_emb.shape) != expected:
            raise ValueError("text_token_emb must have shape [B, T, llm_input_size]")
        if not text_token_emb.is_floating_point():
            raise ValueError("text_token_emb must be floating point")
        if tuple(condition.shape) != expected or not condition.is_floating_point():
            raise ValueError("condition must match text_token_emb and be floating point")
        if not torch.isfinite(condition).all():
            raise ValueError("condition must contain finite values")
        if condition_mask is not None:
            if condition_mask.shape != expected[:2] or condition_mask.dtype != torch.bool:
                raise ValueError("condition_mask must be a torch.bool tensor with shape [B, T]")
        residual = torch.tanh(
            self.condition_norm(condition.to(self.condition_norm.weight))
        )
        if condition_mask is not None:
            residual = residual * condition_mask.unsqueeze(-1)
        residual = residual.to(text_token_emb) * self.gate.to(text_token_emb)
        return text_token_emb + residual

    def build_lm_input(
        self,
        llm: object,
        *,
        text: Tensor,
        prompt_text: Tensor,
        prompt_speech_token: Tensor,
        condition: Tensor,
        condition_mask: Optional[Tensor] = None,
    ) -> Tensor:
        """Build Qwen2LM lm_input with only target-text embeddings conditioned."""

        interface = read_cosyvoice2_interface(llm)
        if interface.llm_input_size != self.llm_input_size:
            raise ValueError("Bridge and Qwen2LM llm_input_size do not match")
        _validate_tokens("text", text, allow_empty=False)
        _validate_tokens("prompt_text", prompt_text, allow_empty=True)
        _validate_tokens("prompt_speech_token", prompt_speech_token, allow_empty=True)
        if condition.shape[:2] != text.shape:
            raise ValueError("condition must have shape [1, text_length, llm_input_size]")

        text_embedding = llm.llm.model.model.embed_tokens
        prompt_text_emb = text_embedding(prompt_text)
        target_text_emb = text_embedding(text)
        target_text_emb = self(target_text_emb, condition, condition_mask)
        sos_emb = llm.llm_embedding.weight[llm.sos].reshape(1, 1, -1)
        task_id_emb = llm.llm_embedding.weight[llm.task_id].reshape(1, 1, -1)
        if prompt_speech_token.shape[1]:
            prompt_speech_emb = llm.speech_embedding(prompt_speech_token)
        else:
            prompt_speech_emb = torch.zeros(
                1, 0, self.llm_input_size,
                dtype=target_text_emb.dtype,
                device=target_text_emb.device,
            )
        return torch.concat(
            (sos_emb, prompt_text_emb, target_text_emb, task_id_emb, prompt_speech_emb),
            dim=1,
        )

    def dry_run(
        self,
        llm: object,
        *,
        text: Tensor,
        prompt_text: Tensor,
        prompt_speech_token: Tensor,
        condition: Tensor,
        condition_mask: Optional[Tensor] = None,
        sampling: int = 25,
        min_token_text_ratio: float = 2,
        max_token_text_ratio: float = 20,
        max_tokens: Optional[int] = None,
        uuid: Optional[str] = None,
    ) -> CosyVoice2DryRunResult:
        """Call the real Qwen2LM.inference_wrapper with a bounded token budget."""

        if max_tokens is not None and (not isinstance(max_tokens, int) or max_tokens <= 0):
            raise ValueError("max_tokens must be a positive integer")
        if not 0 <= min_token_text_ratio <= max_token_text_ratio:
            raise ValueError("Invalid min/max token text ratios")
        lm_input = self.build_lm_input(
            llm,
            text=text,
            prompt_text=prompt_text,
            prompt_speech_token=prompt_speech_token,
            condition=condition,
            condition_mask=condition_mask,
        )
        min_len = int(text.shape[1] * min_token_text_ratio)
        max_len = int(text.shape[1] * max_token_text_ratio)
        if max_tokens is not None:
            max_len = min(max_len, max_tokens)
        max_len = max(1, max_len)
        min_len = min(min_len, max_len)
        run_uuid = uuid or f"xim-voice-cond-{uuid4().hex}"
        tokens: Iterator[int] = llm.inference_wrapper(
            lm_input,
            sampling,
            min_len,
            max_len,
            run_uuid,
        )
        return CosyVoice2DryRunResult(
            tuple(lm_input.shape),
            tuple(int(token) for token in tokens),
            self.llm_input_size,
            min_len,
            max_len,
            run_uuid,
            type(llm).__name__,
        )
