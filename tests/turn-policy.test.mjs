import test from 'node:test';
import assert from 'node:assert/strict';
import {interruptionIntent} from '../turn-policy.mjs';

test('Xim interruption policy distinguishes correction, yielding, backchannels and unknown input',()=>{
 const context={phase:'playing'};
 assert.equal(interruptionIntent('不是工作，是家里的事',context),'correction');
 assert.equal(interruptionIntent('等等！',context),'yield');
 assert.equal(interruptionIntent('嗯嗯。',context),'backchannel');
 assert.equal(interruptionIntent('嗯，不过我想问别的',context),'new_input');
 assert.equal(interruptionIntent('不是工作',null),null);
 assert.equal(interruptionIntent('不是工作',{phase:'complete'}),null);
});
