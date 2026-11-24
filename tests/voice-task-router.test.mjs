import test from 'node:test';
import assert from 'node:assert/strict';
import {routeVoiceTask} from '../voice-task-router.mjs';

test('explicit spoken requests route to meeting and virtual scene tools',()=>{
  assert.deepEqual(routeVoiceTask('组织三个人开会，主题是产品演示'),{kind:'meeting',input:'组织三个人开会，主题是产品演示'});
  assert.deepEqual(routeVoiceTask('创建会议'),{kind:'meeting',input:'创建会议'});
  assert.deepEqual(routeVoiceTask('请帮我加到 6 位参会者'),{kind:'meeting',input:'请帮我加到 6 位参会者'});
  assert.deepEqual(routeVoiceTask('添加一个红色方块'),{kind:'workbench',input:'添加一个红色方块'});
  assert.deepEqual(routeVoiceTask('让机械臂抓起小砖'),{kind:'workbench',input:'让机械臂抓起小砖'});
});

test('questions, refusals and ordinary conversation do not create tasks',()=>{
  for(const input of [
    '你能组织三个人开会吗？',
    '不要创建会议',
    '不要添加一个红色方块',
    '先不要添加一个红色方块',
    '讨论会议安排',
    '讨论怎么开会',
    '会议需要三个人',
    '陪我聊聊物理场景',
    '今天很开心',
    '',
  ])assert.equal(routeVoiceTask(input),null,input);
});
