"""Small executable adapter invariant test; does not require model weights."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1] / 'training'))
import torch
from xim_moss_adapter import XimAffectAdapter,attach_adapter

torch.manual_seed(7)
adapter=XimAffectAdapter(12,4)
x=torch.randn(2,3,12)
assert torch.equal(adapter(x,1),x)
class Output:
    def __init__(self,x):self.last_hidden_state=x
class Transformer(torch.nn.Module):
    def forward(self,x):return Output(x)
class Mock:
    transformer=Transformer()
m=Mock();hook=attach_adapter(m,adapter,lambda:'warm')
assert torch.equal(m.transformer(x).last_hidden_state,x)
with torch.no_grad():adapter.up.weight.fill_(0.1)
assert not torch.equal(m.transformer(x).last_hidden_state,x)
hook.remove()
assert torch.equal(m.transformer(x).last_hidden_state,x)
print('adapter identity, conditional hook and removal passed')
