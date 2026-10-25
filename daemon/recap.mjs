// 「回顾」：从会话文件取当前分支上最近一轮已结束的对话。
// 条目靠 parentId 串成树，最后一条是当前叶子（/tree 切分支后的新条目也挂在新叶子下）。
// 一轮从用户消息开始；紧跟在 toolResult 之后的用户消息是插话（steer），并入同一轮。
// 最后一条 assistant/toolResult 是 stopReason !== 'toolUse' 的 assistant 才算这一轮已结束，进行中的轮次跳过。
import fs from 'node:fs/promises';

const texts = (content, type) => typeof content === 'string'
  ? (type === 'text' ? content : '')
  : Array.isArray(content) ? content.filter((x) => x?.type === type).map((x) => x.text || '').join('\n') : '';

function branch(lines) {
  const byId = new Map();
  let leaf;
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e?.id || e.type === 'session') continue;
    byId.set(e.id, e);
    leaf = e;
  }
  const out = [];
  for (let e = leaf, guard = 0; e && guard <= byId.size; e = byId.get(e.parentId), guard++) {
    if (e.type === 'message' && e.message) out.push(e);
  }
  return out.reverse();
}

/** @returns {{prompt: string, text: string, status: 'done'|'aborted'|'error', startedAt: number, endedAt: number} | null} */
export function lastTurn(raw) {
  const msgs = branch(String(raw).split('\n'));
  const turns = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i].message;
    if (m.role !== 'user') continue;
    const prev = msgs[i - 1]?.message;
    if (prev && (prev.role === 'toolResult' || (prev.role === 'assistant' && prev.stopReason === 'toolUse'))) continue;
    turns.push(i);
  }
  for (let k = turns.length - 1; k >= 0; k--) {
    const seg = msgs.slice(turns[k], turns[k + 1] ?? msgs.length);
    const last = seg.findLast((e) => e.message.role === 'assistant' || e.message.role === 'toolResult');
    const end = last?.message;
    if (end?.role !== 'assistant' || end.stopReason === 'toolUse') continue;
    let text = '';
    for (let j = seg.length - 1; j > 0 && !text; j--) {
      if (seg[j].message.role === 'assistant') text = texts(seg[j].message.content, 'text').trim();
    }
    const at = (e) => Date.parse(e.timestamp) || 0;
    return {
      prompt: texts(seg[0].message.content, 'text').trim(),
      text,
      status: end.stopReason === 'aborted' ? 'aborted' : end.stopReason === 'error' ? 'error' : 'done',
      startedAt: at(seg[0]),
      endedAt: at(last),
    };
  }
  return null;
}

export async function readLastTurn(sessionFile) {
  if (!sessionFile) return null;
  try { return lastTurn(await fs.readFile(sessionFile, 'utf8')); }
  catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
}
