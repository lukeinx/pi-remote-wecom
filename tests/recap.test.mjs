import test from 'node:test';
import assert from 'node:assert/strict';
import {lastTurn} from '../daemon/recap.mjs';

let seq = 0;
const T0 = Date.parse('2026-10-25T00:00:00Z');
function entry(message, parentId, id = `e${++seq}`) {
  return {type: 'message', id, parentId, timestamp: new Date(T0 + seq * 1000).toISOString(), message};
}
const user = (text) => ({role: 'user', content: [{type: 'text', text}]});
const say = (text, stopReason = 'stop') => ({role: 'assistant', stopReason, content: [{type: 'thinking', thinking: 'hmm'}, {type: 'text', text}]});
const call = () => ({role: 'assistant', stopReason: 'toolUse', content: [{type: 'toolCall', name: 'bash', arguments: {}}]});
const result = () => ({role: 'toolResult', content: [{type: 'text', text: 'ok'}]});
/** 按顺序把消息串成一条链，返回条目。 */
function chain(msgs, parentId = null) {
  const out = [];
  for (const m of msgs) { const e = entry(m, parentId); out.push(e); parentId = e.id; }
  return out;
}
const jsonl = (entries) => [{type: 'session', id: 's', cwd: '/x'}, ...entries].map((e) => JSON.stringify(e)).join('\n') + '\n';

test('取最近一轮，正文用最后一段有文字的回复，插话并入同一轮', () => {
  const es = chain([user('第一轮'), say('答一'), user('第二轮'), call(), result(), user('插话'), say('中间', 'toolUse'), result(), say('最终答复')]);
  const t = lastTurn(jsonl(es));
  assert.equal(t.prompt, '第二轮');
  assert.equal(t.text, '最终答复');
  assert.equal(t.status, 'done');
  assert.equal(t.endedAt - t.startedAt, 6000);
});

test('进行中的一轮跳过，取上一轮已结束的', () => {
  const es = chain([user('旧'), say('旧答'), user('新'), call(), result()]);
  assert.equal(lastTurn(jsonl(es)).prompt, '旧');
  assert.equal(lastTurn(jsonl(chain([user('刚发')]))), null);
});

test('沿当前分支取，忽略被放弃的分支', () => {
  const base = chain([user('根'), say('根答')]);
  const abandoned = chain([user('废弃'), say('废弃答')], base[1].id);
  const current = chain([user('当前'), say('当前答')], base[1].id);
  assert.equal(lastTurn(jsonl([...base, ...abandoned, ...current])).text, '当前答');
});

test('中断、无文字回复、末尾非消息条目和坏行', () => {
  const es = chain([user('跑一下'), call(), result(), {role: 'assistant', stopReason: 'aborted', content: []}]);
  const tail = {type: 'custom', id: 'c1', parentId: es.at(-1).id, timestamp: new Date().toISOString(), data: {}};
  const t = lastTurn(jsonl([...es, tail]) + '{oops\n');
  assert.equal(t.status, 'aborted');
  assert.equal(t.text, '');
  assert.equal(t.prompt, '跑一下');
});

test('轮次末尾的 ! 命令消息不影响结束判断', () => {
  const es = chain([user('问'), say('答'), {role: 'bashExecution', command: 'ls', output: ''}]);
  assert.equal(lastTurn(jsonl(es)).text, '答');
});
