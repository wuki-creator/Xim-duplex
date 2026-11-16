"""Xim conditional residual adapter for MOSS-TTS-Nano global hidden states.

Use only with explicitly selected, evaluated adapter weights. The zero-initialized
adapter is mathematically an identity at creation; it is NOT a trained voice model.
"""
import torch
from torch import nn

STYLES = ('joy', 'warm', 'calm', 'curious', 'support', 'celebrate')

class XimAffectAdapter(nn.Module):
    def __init__(self, hidden_size, rank=32):
        super().__init__()
        if not 1 <= rank <= 256 or not 1 <= hidden_size <= 8192:
            raise ValueError('Invalid adapter dimensions')
        self.down = nn.Linear(hidden_size, rank, bias=False)
        self.style = nn.Embedding(len(STYLES), rank)
        self.up = nn.Linear(rank, hidden_size, bias=False)
        nn.init.zeros_(self.up.weight)

    def forward(self, hidden, style_id):
        if not 0 <= style_id < len(STYLES):
            raise ValueError('Unknown style')
        style = self.style.weight[style_id]
        return hidden + self.up(torch.tanh(self.down(hidden) + style))

def attach_adapter(model, adapter, style_getter):
    """Attach to global decoder output; does not rewrite upstream source or KV cache.

    A caller must serialize requests and supply a validated, per-request style.
    The hook affects the returned hidden state, not already cached past states.
    """
    def transform(_module, _args, output):
        hidden = output.last_hidden_state
        output.last_hidden_state = adapter(hidden, STYLES.index(style_getter()))
        return output
    return model.transformer.register_forward_hook(transform)
