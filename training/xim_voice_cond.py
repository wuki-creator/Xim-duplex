"""XimVoiceCond-v1: a trainable speech-condition alignment module.

This file contains model code only. It does not contain trained weights, a
CosyVoice 2 adapter, or evidence of speech quality. The block-causal KV API
expects each call after the first one to contain complete, strictly newer
chunks; splitting one chunk across calls is rejected by contract.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import torch
from torch import Tensor, nn
from torch.nn import functional as F


@dataclass(frozen=True)
class XimVoiceCondConfig:
    d_xim: int = 4096
    d_cv2: int = 1024
    d_model: int = 512
    num_layers: int = 4
    num_heads: int = 8
    d_ff: int = 2048
    max_seq_len: int = 256
    num_emotions: int = 6
    num_speakers: int = 256
    num_states: int = 8
    emotion_dim: int = 64
    speaker_dim: int = 128
    state_dim: int = 64
    prosody_hidden: int = 256
    dropout: float = 0.0

    def __post_init__(self) -> None:
        dimensions = (
            self.d_xim, self.d_cv2, self.d_model, self.num_layers,
            self.num_heads, self.d_ff, self.max_seq_len,
            self.num_emotions, self.num_speakers, self.num_states,
            self.emotion_dim, self.speaker_dim, self.state_dim,
            self.prosody_hidden,
        )
        if any(not isinstance(value, int) or value <= 0 for value in dimensions):
            raise ValueError("All dimensions and vocabulary sizes must be positive integers")
        if self.d_model % self.num_heads:
            raise ValueError("d_model must be divisible by num_heads")
        if (self.d_model // self.num_heads) % 2:
            raise ValueError("The attention head dimension must be even for RoPE")
        if not 0.0 <= self.dropout < 1.0:
            raise ValueError("dropout must be in [0, 1)")


@dataclass(frozen=True)
class LayerCache:
    """One layer's rotated keys, values and attention metadata."""

    key: Tensor
    value: Tensor
    chunk_ids: Tensor
    key_padding_mask: Tensor
    position_ids: Tensor


@dataclass(frozen=True)
class XimVoiceCondOutput:
    condition: Tensor
    prosody: Tensor
    past_key_values: Optional[tuple[LayerCache, ...]] = None


@dataclass(frozen=True)
class ConditionChunk:
    """Validated metadata envelope for one active speech-condition chunk."""

    condition: Tensor
    chunk_id: int
    generation_id: int
    text_start: int
    text_end: int


def pack_condition_chunk(
    condition: Tensor,
    *,
    chunk_id: int,
    generation_id: int,
    active_generation_id: int,
    text_start: int,
    text_end: int,
) -> Optional[ConditionChunk]:
    """Drop stale generations, then validate an active condition chunk."""

    ids = (chunk_id, generation_id, active_generation_id, text_start, text_end)
    if any(isinstance(value, bool) or not isinstance(value, int) for value in ids):
        raise ValueError("Chunk, generation and text-range values must be integers")
    if generation_id != active_generation_id:
        return None
    if min(chunk_id, generation_id, text_start) < 0 or text_end < text_start:
        raise ValueError("Invalid chunk, generation or text range")
    if condition.ndim != 2 or condition.shape[0] == 0 or condition.shape[1] == 0:
        raise ValueError("condition must have shape [T_chunk, d_CV2] with non-zero dimensions")
    if not condition.is_floating_point() or not torch.isfinite(condition).all():
        raise ValueError("condition must contain finite floating-point values")
    return ConditionChunk(condition, chunk_id, generation_id, text_start, text_end)


def _apply_rope(x: Tensor, position_ids: Tensor) -> Tensor:
    """Apply rotary position embeddings to [B, H, T, D] queries or keys."""

    head_dim = x.shape[-1]
    half = head_dim // 2
    inv_freq = 1.0 / (
        10000 ** (torch.arange(half, device=x.device, dtype=torch.float32) / half)
    )
    angles = position_ids.to(torch.float32).unsqueeze(-1) * inv_freq
    cos = angles.cos().unsqueeze(1).to(x.dtype)
    sin = angles.sin().unsqueeze(1).to(x.dtype)
    first, second = x[..., :half], x[..., half:]
    return torch.cat((first * cos - second * sin, first * sin + second * cos), dim=-1)


class BlockCausalAttention(nn.Module):
    def __init__(self, config: XimVoiceCondConfig) -> None:
        super().__init__()
        self.num_heads = config.num_heads
        self.head_dim = config.d_model // config.num_heads
        self.dropout = config.dropout
        self.qkv = nn.Linear(config.d_model, 3 * config.d_model)
        self.out_proj = nn.Linear(config.d_model, config.d_model)

    def _shape(self, x: Tensor) -> Tensor:
        batch, length, _ = x.shape
        return x.view(batch, length, self.num_heads, self.head_dim).transpose(1, 2)

    def forward(
        self,
        hidden: Tensor,
        *,
        chunk_ids: Tensor,
        position_ids: Tensor,
        key_padding_mask: Tensor,
        cache: Optional[LayerCache],
        use_cache: bool,
    ) -> tuple[Tensor, Optional[LayerCache]]:
        batch, query_len, _ = hidden.shape
        query, key, value = self.qkv(hidden).chunk(3, dim=-1)
        query = _apply_rope(self._shape(query), position_ids)
        key = _apply_rope(self._shape(key), position_ids)
        value = self._shape(value)

        if cache is not None:
            key = torch.cat((cache.key, key), dim=2)
            value = torch.cat((cache.value, value), dim=2)
            key_chunks = torch.cat((cache.chunk_ids, chunk_ids), dim=1)
            key_mask = torch.cat((cache.key_padding_mask, key_padding_mask), dim=1)
            cached_positions = torch.cat((cache.position_ids, position_ids), dim=1)
        else:
            key_chunks = chunk_ids
            key_mask = key_padding_mask
            cached_positions = position_ids

        allowed = key_chunks.unsqueeze(1) <= chunk_ids.unsqueeze(2)
        allowed = allowed & key_mask.unsqueeze(1)
        attended = F.scaled_dot_product_attention(
            query,
            key,
            value,
            attn_mask=allowed.unsqueeze(1),
            dropout_p=self.dropout if self.training else 0.0,
        )
        attended = attended.transpose(1, 2).contiguous().view(batch, query_len, -1)
        new_cache = (
            LayerCache(key, value, key_chunks, key_mask, cached_positions)
            if use_cache else None
        )
        return self.out_proj(attended), new_cache


class VoiceCondBlock(nn.Module):
    def __init__(self, config: XimVoiceCondConfig) -> None:
        super().__init__()
        condition_dim = config.emotion_dim + config.speaker_dim + config.state_dim
        self.norm1 = nn.LayerNorm(config.d_model)
        self.norm2 = nn.LayerNorm(config.d_model)
        self.attention = BlockCausalAttention(config)
        self.film = nn.Linear(condition_dim, 2 * config.d_model)
        nn.init.normal_(self.film.weight, std=0.02)
        nn.init.zeros_(self.film.bias)
        self.mlp = nn.Sequential(
            nn.Linear(config.d_model, config.d_ff),
            nn.GELU(),
            nn.Dropout(config.dropout),
            nn.Linear(config.d_ff, config.d_model),
        )
        self.dropout = nn.Dropout(config.dropout)

    def forward(
        self,
        hidden: Tensor,
        condition: Tensor,
        *,
        chunk_ids: Tensor,
        position_ids: Tensor,
        key_padding_mask: Tensor,
        cache: Optional[LayerCache],
        use_cache: bool,
    ) -> tuple[Tensor, Optional[LayerCache]]:
        attended, new_cache = self.attention(
            self.norm1(hidden),
            chunk_ids=chunk_ids,
            position_ids=position_ids,
            key_padding_mask=key_padding_mask,
            cache=cache,
            use_cache=use_cache,
        )
        scale, shift = self.film(condition).chunk(2, dim=-1)
        attended = attended * (1 + scale.unsqueeze(1)) + shift.unsqueeze(1)
        hidden = hidden + self.dropout(attended)
        hidden = hidden + self.dropout(self.mlp(self.norm2(hidden)))
        return hidden, new_cache


class XimVoiceCondV1(nn.Module):
    """Map semantic inputs to chunked CosyVoice 2 condition candidates."""

    def __init__(self, config: XimVoiceCondConfig) -> None:
        super().__init__()
        self.config = config
        self.input_proj = nn.Linear(config.d_xim, config.d_model)
        self.input_norm = nn.LayerNorm(config.d_model)
        self.emotion_embedding = nn.Embedding(config.num_emotions, config.emotion_dim)
        self.speaker_embedding = nn.Embedding(config.num_speakers, config.speaker_dim)
        self.state_embedding = nn.Embedding(config.num_states, config.state_dim)
        self.blocks = nn.ModuleList(VoiceCondBlock(config) for _ in range(config.num_layers))
        self.output_mlp = nn.Sequential(
            nn.Linear(config.d_model, 2 * config.d_model),
            nn.GELU(),
            nn.Dropout(config.dropout),
            nn.Linear(2 * config.d_model, config.d_cv2),
        )
        self.output_residual = nn.Linear(config.d_model, config.d_cv2, bias=False)
        self.output_norm = nn.LayerNorm(config.d_cv2)
        self.prosody_head = nn.Sequential(
            nn.Linear(config.d_model, config.prosody_hidden),
            nn.GELU(),
            nn.Linear(config.prosody_hidden, 3),
        )

    def transformer_core_parameters(self) -> int:
        """Attention and FFN weight count, excluding biases and all adapters."""

        return sum(
            module.weight.numel()
            for block in self.blocks
            for module in (
                block.attention.qkv,
                block.attention.out_proj,
                block.mlp[0],
                block.mlp[3],
            )
        )

    @staticmethod
    def _validate_ids(name: str, value: Tensor, shape: tuple[int, ...], upper: int) -> None:
        if value.shape != shape or value.dtype != torch.long:
            raise ValueError(f"{name} must be a torch.long tensor with shape {shape}")
        if torch.any(value < 0) or torch.any(value >= upper):
            raise ValueError(f"{name} contains an out-of-range ID")

    def forward(
        self,
        semantic: Tensor,
        *,
        emotion_id: Tensor,
        speaker_id: Tensor,
        state_id: Tensor,
        chunk_ids: Tensor,
        attention_mask: Optional[Tensor] = None,
        past_key_values: Optional[tuple[LayerCache, ...]] = None,
        use_cache: bool = False,
    ) -> XimVoiceCondOutput:
        if semantic.ndim != 3 or semantic.shape[-1] != self.config.d_xim:
            raise ValueError("semantic must have shape [B, T, d_xim]")
        if not semantic.is_floating_point():
            raise ValueError("semantic must be a floating-point tensor")
        batch, length, _ = semantic.shape
        if length == 0:
            raise ValueError("semantic must contain at least one token")
        if attention_mask is None:
            attention_mask = torch.ones(
                batch, length, dtype=torch.bool, device=semantic.device
            )
        if attention_mask.shape != (batch, length) or attention_mask.dtype != torch.bool:
            raise ValueError("attention_mask must be a torch.bool tensor with shape [B, T]")
        self._validate_ids("chunk_ids", chunk_ids, (batch, length), 2**31 - 1)
        self._validate_ids("emotion_id", emotion_id, (batch,), self.config.num_emotions)
        self._validate_ids("speaker_id", speaker_id, (batch,), self.config.num_speakers)
        self._validate_ids("state_id", state_id, (batch,), self.config.num_states)
        if torch.any(chunk_ids[:, 1:] < chunk_ids[:, :-1]):
            raise ValueError("chunk_ids must be nondecreasing within each sequence")
        if past_key_values is not None and not use_cache:
            raise ValueError("past_key_values requires use_cache=True")
        if past_key_values is not None and len(past_key_values) != self.config.num_layers:
            raise ValueError("past_key_values must contain one cache entry per layer")
        if use_cache and not torch.all(attention_mask):
            raise ValueError("The incremental KV API requires unpadded complete chunks")

        past_length = 0
        if past_key_values is not None:
            first_cache = past_key_values[0]
            past_length = first_cache.key.shape[2]
            if first_cache.key.shape[0] != batch:
                raise ValueError("Cache batch size does not match semantic")
            if not torch.all(first_cache.key_padding_mask):
                raise ValueError("Cached chunks must be unpadded")
            if torch.any(chunk_ids[:, 0] <= first_cache.chunk_ids[:, -1]):
                raise ValueError("Each incremental call must use a strictly newer complete chunk")
        if past_length + length > self.config.max_seq_len:
            raise ValueError("Total sequence length exceeds max_seq_len")

        if past_key_values is None:
            position_ids = attention_mask.long().cumsum(dim=-1) - 1
            position_ids = position_ids.clamp(min=0)
        else:
            last_positions = past_key_values[0].position_ids[:, -1:]
            position_ids = last_positions + torch.arange(
                1, length + 1, device=semantic.device, dtype=torch.long
            ).unsqueeze(0)

        hidden = self.input_norm(self.input_proj(semantic))
        condition = torch.cat(
            (
                self.emotion_embedding(emotion_id),
                self.speaker_embedding(speaker_id),
                self.state_embedding(state_id),
            ),
            dim=-1,
        )
        new_caches: list[LayerCache] = []
        for index, block in enumerate(self.blocks):
            cache = past_key_values[index] if past_key_values is not None else None
            hidden, new_cache = block(
                hidden,
                condition,
                chunk_ids=chunk_ids,
                position_ids=position_ids,
                key_padding_mask=attention_mask,
                cache=cache,
                use_cache=use_cache,
            )
            if new_cache is not None:
                new_caches.append(new_cache)

        speech_condition = self.output_norm(
            self.output_residual(hidden) + self.output_mlp(hidden)
        )
        prosody = self.prosody_head(hidden)
        valid = attention_mask.unsqueeze(-1)
        speech_condition = speech_condition * valid
        prosody = prosody * valid
        return XimVoiceCondOutput(
            speech_condition,
            prosody,
            tuple(new_caches) if use_cache else None,
        )
