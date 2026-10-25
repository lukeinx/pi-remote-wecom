// Session artifacts: files the agent produced in this session that are worth sending to the phone.
// A file qualifies if the agent wrote it with write/edit, or pointed to it in a reply (markdown link,
// file:// URL or bare absolute path) after touching it in this session; shell-made outputs (cp, mv,
// exporters, subagents) only show up through the second route. Git-tracked files are source, not artifacts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

export const ART_EXT = new Set(['.html', '.htm', '.md', '.pdf', '.docx', '.xlsx', '.pptx', '.png', '.svg']);
const HOME = os.homedir();
const EXT_RE = String.raw`\.(?:html?|md|pdf|docx|xlsx|pptx|png|svg)`;
const FILE_URL = new RegExp(String.raw`file://[^\s)\]>"'\x60]+?${EXT_RE}(?![\w.])`, 'gi');
const MD_LINK = /\]\((<[^>\n]+>|[^)\s]+)\)/g;
const BARE_ABS = new RegExp(String.raw`(?<![\w/:.%~])((?:~|/)[^\s\x60"'<>()\[\]]+?${EXT_RE})(?![\w.])`, 'gi');
// The file may be finished a little after the last record we have read (e.g. a slow exporter).
const MTIME_SLACK_BEFORE = 60_000;
const MTIME_SLACK_AFTER = 10 * 60_000;
const BASH_TEXT_MAX = 1 << 20;

/** Path-only checks, cheap enough to repeat right before sending. */
export function artAllowed(p) {
  if (!ART_EXT.has(path.extname(p).toLowerCase())) return false;
  if (/^(\/private)?\/(tmp|var\/folders)\//.test(p) || p.startsWith(path.join(HOME, 'Library', 'Caches') + path.sep)) return false;
  const segs = p.split(path.sep);
  // Hidden directories hold tool state and config (~/.pi, ~/.config, .cache), not deliverables.
  if (segs.slice(0, -1).some((s) => s === 'node_modules' || (s.length > 1 && s.startsWith('.')))) return false;
  const base = path.basename(p).toLowerCase();
  return !(base.startsWith('.') || base.endsWith('.pem') || base.includes('secret'));
}

export function gitTracked(file) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', path.basename(file)], {cwd: path.dirname(file), stdio: 'ignore', timeout: 3000});
    return true;
  } catch {
    return false;
  }
}

function resolveRef(raw, cwd) {
  let p = raw.trim().replace(/^<|>$/g, '');
  if (/^[a-z][\w+.-]*:/i.test(p) && !p.startsWith('file://')) return '';
  if (p.startsWith('file://')) p = p.slice(7);
  try { p = decodeURIComponent(p); } catch { }
  p = p.split(/[?#]/)[0];
  if (!p) return '';
  if (p === '~' || p.startsWith('~/')) p = path.join(HOME, p.slice(1));
  return path.resolve(cwd || HOME, p);
}

/** Local file references in assistant prose; inline code is skipped since it mostly names source files. */
export function mentionedPaths(text, cwd) {
  const prose = String(text).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const refs = [...prose.matchAll(FILE_URL)].map((m) => m[0]);
  for (const m of prose.matchAll(MD_LINK)) refs.push(m[1]);
  for (const m of prose.replace(MD_LINK, ' ').replace(FILE_URL, ' ').matchAll(BARE_ABS)) refs.push(m[1]);
  return [...new Set(refs.map((r) => resolveRef(r, cwd)).filter(Boolean))];
}

function freshState(file) {
  return {file, off: 0, t0: 0, t1: 0, tool: new Set(), linked: new Set(), bash: ''};
}

function ingest(st, line, cwd) {
  let rec;
  try { rec = JSON.parse(line); } catch { return; }
  const at = Date.parse(rec?.timestamp ?? '');
  if (Number.isFinite(at)) {
    if (!st.t0) st.t0 = at;
    st.t1 = Math.max(st.t1, at);
  }
  const msg = rec?.message;
  if (rec?.type !== 'message' || !Array.isArray(msg?.content)) return;
  for (const part of msg.content) {
    if (part?.type === 'toolCall') {
      const args = part.arguments ?? {};
      if (part.name === 'write' || part.name === 'edit') {
        const raw = args.path || args.file_path;
        if (typeof raw === 'string' && raw) st.tool.add(resolveRef(raw, cwd));
      } else if (part.name === 'bash' && typeof args.command === 'string') {
        st.bash = (st.bash + '\n' + args.command).slice(-BASH_TEXT_MAX);
      }
    } else if (part?.type === 'text' && msg.role === 'assistant') {
      for (const p of mentionedPaths(part.text ?? '', cwd)) st.linked.add(p);
    }
  }
}

/**
 * Incrementally reads the session jsonl and returns qualifying files, newest first.
 * `state` is any object kept per target between calls.
 * @returns {{file: string, size: number, mtime: number}[]}
 */
export function scanArtifacts(state, sessionFile, cwd, {isTracked = gitTracked} = {}) {
  if (!sessionFile) return [];
  if (state.art?.file !== sessionFile) state.art = freshState(sessionFile);
  const st = state.art;
  try {
    const size = fs.statSync(sessionFile).size;
    if (size < st.off) Object.assign(st, freshState(sessionFile));
    if (size > st.off) {
      const buf = Buffer.alloc(size - st.off);
      const fd = fs.openSync(sessionFile, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, st.off); } finally { fs.closeSync(fd); }
      const end = buf.lastIndexOf(10) + 1;
      for (const line of buf.subarray(0, end).toString('utf8').split('\n')) if (line) ingest(st, line, cwd);
      st.off += end;
    }
  } catch { }
  const tracked = state.artTracked ??= new Map();
  const isSource = (file, mtime) => {
    const key = `${file}\0${mtime}`;
    if (!tracked.has(key)) tracked.set(key, isTracked(file));
    return tracked.get(key);
  };
  const touched = (file, mtime) => st.tool.has(file) || st.bash.includes(path.basename(file))
    || (st.t0 > 0 && mtime >= st.t0 - MTIME_SLACK_BEFORE && mtime <= st.t1 + MTIME_SLACK_AFTER);
  const out = new Map();
  for (const [file, viaTool] of [...[...st.tool].map((f) => [f, true]), ...[...st.linked].map((f) => [f, false])]) {
    if (!ART_EXT.has(path.extname(file).toLowerCase())) continue;
    let stat, real;
    try {
      stat = fs.statSync(file);
      real = fs.realpathSync(file);
    } catch { continue; }
    if (!stat.isFile() || out.has(real) || !artAllowed(real)) continue;
    if (!viaTool && !touched(file, stat.mtimeMs)) continue;
    if (isSource(real, stat.mtimeMs)) continue;
    out.set(real, {file: real, size: stat.size, mtime: stat.mtimeMs});
  }
  return [...out.values()].sort((a, b) => b.mtime - a.mtime);
}
