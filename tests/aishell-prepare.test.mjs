import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pcmWav} from '../audio.mjs';

test('AISHELL preparation isolates speakers and handles official wav filenames and pinyin',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'xim-speech-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const lines=[];
  for(const speaker of ['SSB0005','SSB0009','SSB0011']){
    const folder=path.join(root,'train','wav',speaker);await fs.mkdir(folder,{recursive:true});
    const uid=speaker+'0001';await fs.writeFile(path.join(folder,uid+'.wav'),pcmWav(Buffer.alloc(32000)));
    lines.push(uid+'.wav\t你 ni3 好 hao3');
  }
  await fs.writeFile(path.join(root,'train','content.txt'),lines.join('\n'));
  const run=spawnSync('python',['scripts/prepare_aishell3.py','--root',root,'--output',path.join(root,'out'),'--eval-speakers','1'],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const train=(await fs.readFile(path.join(root,'out','train_raw.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  const evalRows=(await fs.readFile(path.join(root,'out','holdout_raw.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(train.length,2);assert.equal(evalRows.length,1);assert.equal(train[0].text,'你好');
  assert.ok(!train.some(x=>x.audio.split(/[\\/]/).at(-2)===evalRows[0].audio.split(/[\\/]/).at(-2)));
});
