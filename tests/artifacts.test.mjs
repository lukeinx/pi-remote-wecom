import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {artAllowed, mentionedPaths, scanArtifacts} from '../daemon/artifacts.mjs';

// Not under os.tmpdir(): temp dirs are excluded on purpose.
const root = fs.mkdtempSync(path.join(os.homedir(), 'pi-remote-art-test-'));
test.after(() => fs.rmSync(root, {recursive: true, force: true}));

const T0 = Date.now() - 60_000;
let seq = 0;
const rec = (role, content) => JSON.stringify({type: 'message', timestamp: new Date(T0 + seq++ * 1000).toISOString(), message: {role, content}});
const call = (name, args) => rec('assistant', [{type: 'toolCall', name, arguments: args}]);
const say = (text) => rec('assistant', [{type: 'text', text}]);
function session(lines) {
  const file = path.join(root, `s${seq}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}
function put(rel, body = 'x', mtime) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, body);
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return fs.realpathSync(file);
}
const names = (list) => list.map((a) => path.relative(fs.realpathSync(root), a.file)).sort();
const scan = (file, tracked = new Set()) => scanArtifacts({}, file, root, {isTracked: (f) => tracked.has(f)});

test('artAllowed 排除临时目录、隐藏目录和敏感文件名', () => {
  assert.equal(artAllowed('/home/a/out/report.html'), true);
  assert.equal(artAllowed('/tmp/report.html'), false);
  assert.equal(artAllowed('/private/var/folders/x/report.html'), false);
  assert.equal(artAllowed(path.join(os.homedir(), '.pi/agent/agents/x.md')), false);
  assert.equal(artAllowed('/home/a/proj/node_modules/x/README.md'), false);
  assert.equal(artAllowed('/home/a/out/secret-notes.md'), false);
  assert.equal(artAllowed('/home/a/out/run.log'), false);
});

test('mentionedPaths 认链接、file:// 和绝对路径，不认行内代码', () => {
  const text = [
    '报告：[报告.html](file:///home/a/My%20Docs/%E6%8A%A5%E5%91%8A.html)。',
    '另见 [prd](docs/prd.md) 和 [官网](https://x.com/a.html)，',
    '截图在 /home/a/shots/1.png，配置在 `web/index.html`。',
    '```\ncat /home/a/code-block.md\n```',
  ].join('\n');
  assert.deepEqual(mentionedPaths(text, '/home/a/proj').sort(), ['/home/a/My Docs/报告.html', '/home/a/proj/docs/prd.md', '/home/a/shots/1.png'].sort());
});

test('write / edit 写过的文件算产物，仓库跟踪的源码不算', () => {
  put('out/mock.html');
  put('out/notes.md');
  const src = put('repo/README.md');
  const file = session([call('write', {path: 'out/mock.html', content: 'x'}), call('edit', {path: 'out/notes.md', edits: []}), call('write', {path: 'repo/README.md', content: 'x'})]);
  assert.deepEqual(names(scan(file, new Set([src]))), ['out/mock.html', 'out/notes.md']);
});

test('shell 搬过去并在回复里链接的文件算产物', () => {
  put('final/page.html');
  const file = session([
    call('write', {path: '/tmp/draft.html', content: 'x'}),
    call('bash', {command: 'cp /tmp/draft.html final/page.html'}),
    say(`已完成：[page.html](file://${encodeURI(path.join(root, 'final/page.html'))})`),
  ]);
  assert.deepEqual(names(scan(file)), ['final/page.html']);
});

test('回复里提到但本会话没碰过的旧文件不算', () => {
  put('old/report.html', 'x', T0 - 3 * 86400_000);
  const file = session([say(`参考了 ${path.join(root, 'old/report.html')}`)]);
  assert.deepEqual(names(scan(file)), []);
});

test('subagent 写的文件：回复里链接且修改时间在会话期间也算', () => {
  put('proposals/a.html', 'x', T0 + 2000);
  const file = session([call('Agent', {prompt: '写提案'}), say(`[a.html](${path.join(root, 'proposals/a.html')})`)]);
  assert.deepEqual(names(scan(file)), ['proposals/a.html']);
});

test('软链接与原路径去重，按真实路径过滤', () => {
  put('materials/x.html');
  fs.symlinkSync(path.join(root, 'materials'), path.join(root, '.materials'));
  const file = session([call('write', {path: '.materials/x.html', content: 'x'}), say(`[x](${path.join(root, 'materials/x.html')})`)]);
  assert.deepEqual(names(scan(file)), ['materials/x.html']);
});

test('增量读取：新追加的记录会被识别，文件删除后不再列出', () => {
  const a = put('inc/a.md');
  const file = session([call('write', {path: 'inc/a.md', content: 'x'})]);
  const state = {};
  assert.equal(scanArtifacts(state, file, root, {isTracked: () => false}).length, 1);
  put('inc/b.pdf');
  fs.appendFileSync(file, call('write', {path: 'inc/b.pdf', content: 'x'}) + '\n');
  assert.equal(scanArtifacts(state, file, root, {isTracked: () => false}).length, 2);
  fs.rmSync(a);
  assert.deepEqual(names(scanArtifacts(state, file, root, {isTracked: () => false})), ['inc/b.pdf']);
});
