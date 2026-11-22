// SPDX-License-Identifier: MIT
// mend: one patch tool for every AI edit format.
// Applies unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON
// text-editor tool calls to a tree of text files, to SPEC.md.
// Node 22, standard library only.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

class ParseError extends Error {
  constructor(line) {
    super('parse error');
    this.line = line;
  }
}

const FORMATS = ['unified', 'search-replace', 'v4a', 'json', 'auto'];

function rstrip(line) {
  return line.replace(/[ \t]+$/, '');
}

function leadingWs(line) {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : '';
}

function isSafePath(p) {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  const parts = p.split('/');
  for (const seg of parts) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Arguments (SPEC section 1)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  const positional = [];
  let endOpts = false;
  for (const arg of argv) {
    if (endOpts) {
      positional.push(arg);
      continue;
    }
    if (arg === '--') {
      endOpts = true;
      continue;
    }
    if (arg === '-') {
      positional.push(arg);
      continue;
    }
    if (arg.startsWith('-')) {
      if (arg === '--check') {
        if (seenCheck) return null;
        seenCheck = true;
        check = true;
      } else if (arg === '--strict') {
        if (seenStrict) return null;
        seenStrict = true;
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seenFormat) return null;
        seenFormat = true;
        const value = arg.slice('--format='.length);
        if (!FORMATS.includes(value)) return null;
        format = value;
      } else {
        return null;
      }
      continue;
    }
    positional.push(arg);
  }
  if (positional.length > 1) return null;
  return { format, check, strict, patchArg: positional.length === 1 ? positional[0] : null };
}

// ---------------------------------------------------------------------------
// Patch lines and format detection (SPEC sections 3 and 4)
// ---------------------------------------------------------------------------

function splitLines(text) {
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function detectFormat(lines) {
  let first = undefined;
  for (const l of lines) {
    if (l.trim() !== '') {
      first = l;
      break;
    }
  }
  if (first !== undefined) {
    if (first.trim() === '*** Begin Patch') return 'v4a';
    const c = first.trimStart().charAt(0);
    if (c === '[' || c === '{') return 'json';
  }
  for (const l of lines) {
    if (rstrip(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (const l of lines) {
    if (l.startsWith('diff --git ')) return 'unified';
  }
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i].startsWith('--- ') && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// File states (SPEC section 3)
// ---------------------------------------------------------------------------

function parseFileState(text) {
  if (text === '') return { lines: [], brk: '\n', ends: false };
  const idx = text.indexOf('\n');
  let brk = '\n';
  if (idx > 0 && text[idx - 1] === '\r') brk = '\r\n';
  const parts = text.split(brk);
  let ends = false;
  if (text.endsWith(brk)) {
    ends = true;
    parts.pop();
  }
  return { lines: parts, brk, ends };
}

function serializeState(st) {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.brk) + (st.ends ? st.brk : '');
}

function makeTree() {
  const original = new Map();
  const working = new Map();
  function touch(path) {
    if (original.has(path)) return;
    let text = null;
    try {
      const st = statSync(path);
      if (st.isFile()) text = readFileSync(path, 'utf8');
    } catch {
      text = null;
    }
    original.set(path, text);
    working.set(path, text);
  }
  function get(path) {
    touch(path);
    const text = working.get(path);
    return { exists: text !== null, text };
  }
  function setText(path, text) {
    touch(path);
    working.set(path, text);
  }
  function remove(path) {
    touch(path);
    working.set(path, null);
  }
  function setState(path, st) {
    setText(path, serializeState(st));
  }
  return { original, working, get, setText, setState, remove };
}

function stateOf(tree, path) {
  const f = tree.get(path);
  if (!f.exists) return null;
  return parseFileState(f.text);
}

// ---------------------------------------------------------------------------
// Line matching (SPEC section 5)
// ---------------------------------------------------------------------------

function normLine(line, tier) {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function findOccurrences(lines, pat, tier, start, onlyEndAtLast) {
  const out = [];
  const npat = pat.map((l) => normLine(l, tier));
  const last = lines.length - pat.length;
  for (let i = start; i <= last; i++) {
    if (onlyEndAtLast && i !== last) continue;
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (normLine(lines[i + j], tier) !== npat[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findAtFirstTier(lines, pat, strict, start, onlyEndAtLast) {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = findOccurrences(lines, pat, tier, start, onlyEndAtLast);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

// Build the replacement lines for one chunk/hunk from its ops.
// ops: [{kind: 'ctx'|'del'|'add', text}]. Context lines are written as the
// file's own matched lines; at tier 2 every other new line is re-indented.
function buildReplacement(ops, fileLines, matchIndex, tier) {
  const oldLines = [];
  for (const op of ops) {
    if (op.kind !== 'add') oldLines.push(op.text);
  }
  const p = oldLines.length > 0 ? leadingWs(oldLines[0]) : '';
  const f = matchIndex < fileLines.length ? leadingWs(fileLines[matchIndex]) : '';
  const out = [];
  let oIdx = 0;
  for (const op of ops) {
    if (op.kind === 'del') {
      oIdx++;
      continue;
    }
    if (op.kind === 'ctx') {
      out.push(fileLines[matchIndex + oIdx]);
      oIdx++;
      continue;
    }
    let line = op.text;
    if (tier === 2 && line !== '' && !/^[ \t]+$/.test(line) && line.startsWith(p)) {
      line = f + line.slice(p.length);
    }
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

function isDiffGitLine(l) {
  return l === 'diff --git' || l.startsWith('diff --git ');
}

function parseDiffGit(l, ln) {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
  if (!m) throw new ParseError(ln);
  return [m[1], m[2]];
}

function diffPath(line) {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab !== -1) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest.startsWith('a/')) rest = rest.slice(2);
  else if (rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function parseHunkHeader(l, ln) {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
  if (!m) throw new ParseError(ln);
  return { A: Number(m[1]) };
}

function parseUnifiedDiff(lines) {
  const n = lines.length;
  const edits = [];
  let section = null;
  let phase = 'outside';

  function newSection(diffPaths) {
    return {
      diffA: diffPaths ? diffPaths[0] : undefined,
      diffB: diffPaths ? diffPaths[1] : undefined,
      pair: null,
      renameFrom: undefined,
      renameTo: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
  }

  function sectionToEdit(s) {
    const oldP = s.pair ? s.pair[0] : s.renameFrom !== undefined ? s.renameFrom : s.diffA;
    const newP = s.pair ? s.pair[1] : s.renameTo !== undefined ? s.renameTo : s.diffB;
    let kind;
    if (oldP === '/dev/null' || s.newFile) kind = 'create';
    else if (newP === '/dev/null' || s.deletedFile) kind = 'delete';
    else if (oldP !== newP) kind = 'move';
    else kind = 'change';
    return { format: 'unified', kind, oldPath: oldP, newPath: newP, hunks: s.hunks };
  }

  function finishSection() {
    if (section) {
      edits.push(sectionToEdit(section));
      section = null;
    }
  }

  function parseHunkBody(startIdx) {
    const body = [];
    let j = startIdx;
    while (j < n) {
      const l = lines[j];
      if (l.startsWith('@@')) break;
      if (isDiffGitLine(l)) break;
      if (l.startsWith('--- ') && j + 1 < n && lines[j + 1].startsWith('+++ ')) break;
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
        if (l === '') body.push({ kind: 'ctx', text: '', raw: l });
        else if (l[0] === ' ') body.push({ kind: 'ctx', text: l.slice(1), raw: l });
        else if (l[0] === '-') body.push({ kind: 'del', text: l.slice(1), raw: l });
        else if (l[0] === '+') body.push({ kind: 'add', text: l.slice(1), raw: l });
        else body.push({ kind: 'backslash', text: l, raw: l });
        j++;
        continue;
      }
      break;
    }
    while (body.length > 0 && body[body.length - 1].raw === '') body.pop();
    let lastCtxAdd = -1;
    let lastAdd = -1;
    for (let k = 0; k < body.length; k++) {
      if (body[k].kind === 'ctx' || body[k].kind === 'add') lastCtxAdd = k;
      if (body[k].kind === 'add') lastAdd = k;
    }
    const noNewline =
      lastCtxAdd >= 0 && body[lastCtxAdd + 1] !== undefined && body[lastCtxAdd + 1].kind === 'backslash';
    const noNewlinePlus =
      lastAdd >= 0 && body[lastAdd + 1] !== undefined && body[lastAdd + 1].kind === 'backslash';
    const ops = body.filter((e) => e.kind !== 'backslash');
    return { body: ops, noNewline, noNewlinePlus, next: j };
  }

  function parseHunkAt(i) {
    const header = parseHunkHeader(lines[i], i + 1);
    const parsed = parseHunkBody(i + 1);
    section.hunks.push({ A: header.A, ops: parsed.body, noNewline: parsed.noNewline, noNewlinePlus: parsed.noNewlinePlus });
    return parsed.next;
  }

  let i = 0;
  while (i < n) {
    const l = lines[i];
    if (phase === 'outside') {
      if (isDiffGitLine(l)) {
        section = newSection(parseDiffGit(l, i + 1));
        phase = 'header';
        i++;
        continue;
      }
      if (l.startsWith('@@')) throw new ParseError(i + 1);
      if (l.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
        section = newSection(null);
        section.pair = [diffPath(l), diffPath(lines[i + 1])];
        phase = 'header';
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (phase === 'header') {
      if (isDiffGitLine(l)) {
        finishSection();
        section = newSection(parseDiffGit(l, i + 1));
        i++;
        continue;
      }
      if (l.startsWith('@@')) {
        i = parseHunkAt(i);
        phase = 'between';
        continue;
      }
      if (l.startsWith('--- ')) {
        if (i + 1 < n && lines[i + 1].startsWith('+++ ')) {
          const pair = [diffPath(l), diffPath(lines[i + 1])];
          if (!section.pair) {
            section.pair = pair;
            i += 2;
            continue;
          }
          finishSection();
          section = newSection(null);
          section.pair = pair;
          i += 2;
          continue;
        }
        throw new ParseError(i + 2);
      }
      if (l.startsWith('rename from ')) {
        section.renameFrom = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        section.renameTo = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) section.newFile = true;
      else if (l.startsWith('deleted file mode')) section.deletedFile = true;
      i++;
      continue;
    }
    // phase === 'between'
    if (isDiffGitLine(l)) {
      finishSection();
      section = newSection(parseDiffGit(l, i + 1));
      phase = 'header';
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      i = parseHunkAt(i);
      continue;
    }
    if (l.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      finishSection();
      section = newSection(null);
      section.pair = [diffPath(l), diffPath(lines[i + 1])];
      phase = 'header';
      i += 2;
      continue;
    }
    i++;
  }
  finishSection();
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

function applyUnified(tree, edit, strict) {
  const { kind, oldPath, newPath } = edit;
  if (kind === 'create') {
    if (!isSafePath(newPath)) return { fail: { code: 'unsafe', path: newPath } };
    if (tree.get(newPath).exists) return { fail: { code: 'exists', path: newPath } };
    const addLines = [];
    let lastPlusFlag = false;
    let seenPlus = false;
    for (const h of edit.hunks) {
      let hasPlus = false;
      for (const op of h.ops) {
        if (op.kind === 'add') {
          addLines.push(op.text);
          hasPlus = true;
        }
      }
      if (hasPlus) {
        seenPlus = true;
        lastPlusFlag = h.noNewlinePlus;
      }
    }
    tree.setState(newPath, { lines: addLines, brk: '\n', ends: seenPlus ? !lastPlusFlag : true });
    return {};
  }
  if (kind === 'delete') {
    if (!isSafePath(oldPath)) return { fail: { code: 'unsafe', path: oldPath } };
    if (!tree.get(oldPath).exists) return { fail: { code: 'missing', path: oldPath } };
    tree.remove(oldPath);
    return {};
  }
  // move or change
  if (!isSafePath(oldPath)) return { fail: { code: 'unsafe', path: oldPath } };
  if (kind === 'move' && !isSafePath(newPath)) return { fail: { code: 'unsafe', path: newPath } };
  const cur = tree.get(oldPath);
  if (!cur.exists) return { fail: { code: 'missing', path: oldPath } };
  if (kind === 'move' && tree.get(newPath).exists) return { fail: { code: 'exists', path: newPath } };
  const st = parseFileState(cur.text);
  let d = 0;
  for (const hunk of edit.hunks) {
    const oldLines = [];
    for (const op of hunk.ops) {
      if (op.kind !== 'add') oldLines.push(op.text);
    }
    if (oldLines.length === 0) {
      const addLines = [];
      for (const op of hunk.ops) {
        if (op.kind === 'add') addLines.push(op.text);
      }
      const oldLen = st.lines.length;
      const pos = Math.min(hunk.A + d, oldLen);
      st.lines.splice(pos, 0, ...addLines);
      if (pos === oldLen && addLines.length > 0) st.ends = !hunk.noNewline;
      d += addLines.length;
      continue;
    }
    const found = findAtFirstTier(st.lines, oldLines, strict, 0, false);
    if (!found) return { fail: { code: 'no-match', path: oldPath } };
    const target = hunk.A - 1 + d;
    let best = found.occ[0];
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const replacement = buildReplacement(hunk.ops, st.lines, best, found.tier);
    const runsToEnd = best + oldLines.length === st.lines.length;
    st.lines.splice(best, oldLines.length, ...replacement);
    if (runsToEnd) st.ends = !hunk.noNewline;
    d += replacement.length - oldLines.length;
  }
  if (kind === 'move') {
    tree.remove(oldPath);
    tree.setState(newPath, st);
    return { move: { oldPath, newPath } };
  }
  tree.setState(oldPath, st);
  return {};
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines) {
  const blocks = [];
  let prevEnd = 0;
  let prevPath = null;
  let i = 0;
  while (i < lines.length) {
    if (rstrip(lines[i]) === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let eq = -1;
      let j = i + 1;
      while (j < lines.length) {
        const t = rstrip(lines[j]);
        if (t === '=======') {
          eq = j;
          break;
        }
        if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
        j++;
      }
      if (eq === -1) throw new ParseError(searchLine);
      let end = -1;
      j = eq + 1;
      while (j < lines.length) {
        const t = rstrip(lines[j]);
        if (t === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
        if (t === '<<<<<<< SEARCH') break;
        j++;
      }
      if (end === -1) throw new ParseError(searchLine);
      let path = null;
      for (let k = i - 1; k >= prevEnd; k--) {
        const t = lines[k];
        if (t.trim() === '') continue;
        const trimmed = t.trim();
        if (trimmed.startsWith('```')) continue;
        path = trimmed;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new ParseError(searchLine);
        path = prevPath;
      }
      prevPath = path;
      blocks.push({ format: 'search-replace', path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, end) });
      prevEnd = end + 1;
      i = end + 1;
    } else {
      i++;
    }
  }
  if (blocks.length === 0) throw new ParseError(1);
  return blocks;
}

function applySearchReplace(tree, edit, strict) {
  const { path, oldLines, newLines } = edit;
  if (!isSafePath(path)) return { fail: { code: 'unsafe', path } };
  const cur = tree.get(path);
  if (oldLines.length === 0) {
    if (cur.exists) return { fail: { code: 'exists', path } };
    tree.setState(path, { lines: newLines.slice(), brk: '\n', ends: newLines.length > 0 });
    return {};
  }
  if (!cur.exists) return { fail: { code: 'missing', path } };
  const st = parseFileState(cur.text);
  const found = findAtFirstTier(st.lines, oldLines, strict, 0, false);
  if (!found) return { fail: { code: 'no-match', path } };
  if (found.occ.length !== 1) return { fail: { code: 'ambiguous', path } };
  const ops = [];
  for (const t of oldLines) ops.push({ kind: 'del', text: t });
  for (const t of newLines) ops.push({ kind: 'add', text: t });
  const replacement = buildReplacement(ops, st.lines, found.occ[0], found.tier);
  st.lines.splice(found.occ[0], oldLines.length, ...replacement);
  tree.setState(path, st);
  return {};
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

function parseV4A(lines) {
  let first = -1;
  let last = -1;
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].trim() !== '') {
      first = k;
      break;
    }
  }
  for (let k = lines.length - 1; k >= 0; k--) {
    if (lines[k].trim() !== '') {
      last = k;
      break;
    }
  }
  if (first === -1) throw new ParseError(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw new ParseError(lines.length + 1);

  const sections = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && lines[i].trim() === '') i++;
    if (i >= last) break;
    const header = lines[i];
    let kind = null;
    let path = null;
    if (header.startsWith('*** Add File: ')) {
      kind = 'add';
      path = header.slice('*** Add File: '.length).trim();
    } else if (header.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = header.slice('*** Delete File: '.length).trim();
    } else if (header.startsWith('*** Update File: ')) {
      kind = 'update';
      path = header.slice('*** Update File: '.length).trim();
    } else {
      throw new ParseError(i + 1);
    }
    const headerLine = i + 1;
    // Collect this section's lines: up to the next section header or End Patch.
    const raw = [];
    let j = i + 1;
    while (j < last) {
      const l = lines[j];
      if (
        l.startsWith('*** Add File: ') ||
        l.startsWith('*** Delete File: ') ||
        l.startsWith('*** Update File: ')
      ) {
        break;
      }
      raw.push({ text: l, ln: j + 1 });
      j++;
    }
    i = j;
    while (raw.length > 0 && raw[raw.length - 1].text.trim() === '') raw.pop();

    if (kind === 'add') {
      const fileLines = [];
      for (const entry of raw) {
        if (entry.text === '') fileLines.push('');
        else if (entry.text.startsWith('+')) fileLines.push(entry.text.slice(1));
        else throw new ParseError(entry.ln);
      }
      sections.push({ format: 'v4a', kind, path, fileLines });
    } else if (kind === 'delete') {
      for (const entry of raw) {
        if (entry.text.trim() !== '') throw new ParseError(entry.ln);
      }
      sections.push({ format: 'v4a', kind, path });
    } else {
      let moveTo = null;
      let idx = 0;
      if (raw.length > 0 && raw[0].text.startsWith('*** Move to: ')) {
        moveTo = raw[0].text.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks = [];
      let cur = null;
      const pushChunk = () => {
        if (cur) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; idx < raw.length; idx++) {
        const entry = raw[idx];
        const text = entry.text;
        if (text.startsWith('@@')) {
          pushChunk();
          const anchorText = text.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, ops: [], endAnchored: false };
          continue;
        }
        if (text.trim() === '*** End of File') {
          if (!cur) throw new ParseError(entry.ln);
          cur.endAnchored = true;
          pushChunk();
          continue;
        }
        if (text.startsWith('*** ')) throw new ParseError(entry.ln);
        if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
          if (!cur) cur = { anchor: null, ops: [], endAnchored: false };
          if (text === '') cur.ops.push({ kind: 'ctx', text: '' });
          else if (text[0] === ' ') cur.ops.push({ kind: 'ctx', text: text.slice(1) });
          else if (text[0] === '-') cur.ops.push({ kind: 'del', text: text.slice(1) });
          else cur.ops.push({ kind: 'add', text: text.slice(1) });
          continue;
        }
        throw new ParseError(entry.ln);
      }
      pushChunk();
      if (chunks.length === 0 && moveTo === null) throw new ParseError(headerLine);
      sections.push({ format: 'v4a', kind, path, moveTo, chunks });
    }
  }
  if (sections.length === 0) throw new ParseError(1);
  return sections;
}

function applyV4A(tree, edit, strict) {
  const { kind, path } = edit;
  if (kind === 'add') {
    if (!isSafePath(path)) return { fail: { code: 'unsafe', path } };
    if (tree.get(path).exists) return { fail: { code: 'exists', path } };
    tree.setState(path, { lines: edit.fileLines.slice(), brk: '\n', ends: true });
    return {};
  }
  if (kind === 'delete') {
    if (!isSafePath(path)) return { fail: { code: 'unsafe', path } };
    if (!tree.get(path).exists) return { fail: { code: 'missing', path } };
    tree.remove(path);
    return {};
  }
  // update
  if (!isSafePath(path)) return { fail: { code: 'unsafe', path } };
  const newPath = edit.moveTo !== null && edit.moveTo !== undefined ? edit.moveTo : path;
  if (edit.moveTo !== null && edit.moveTo !== undefined && !isSafePath(newPath)) {
    return { fail: { code: 'unsafe', path: newPath } };
  }
  const cur = tree.get(path);
  if (!cur.exists) return { fail: { code: 'missing', path } };
  if (edit.moveTo !== null && edit.moveTo !== undefined && tree.get(newPath).exists) {
    return { fail: { code: 'exists', path: newPath } };
  }
  const st = parseFileState(cur.text);
  let cursor = 0;
  for (const chunk of edit.chunks) {
    if (chunk.anchor !== null && chunk.anchor !== undefined) {
      const found = findAtFirstTier(st.lines, [chunk.anchor], strict, cursor, false);
      if (!found) return { fail: { code: 'no-match', path } };
      cursor = found.occ[0] + 1;
    }
    const oldLines = [];
    for (const op of chunk.ops) {
      if (op.kind !== 'add') oldLines.push(op.text);
    }
    if (oldLines.length === 0) {
      const addLines = [];
      for (const op of chunk.ops) {
        if (op.kind === 'add') addLines.push(op.text);
      }
      const pos = chunk.endAnchored ? st.lines.length : cursor;
      st.lines.splice(pos, 0, ...addLines);
      cursor = pos + addLines.length;
      continue;
    }
    const found = findAtFirstTier(st.lines, oldLines, strict, cursor, chunk.endAnchored);
    if (!found) return { fail: { code: 'no-match', path } };
    const idx = found.occ[0];
    const replacement = buildReplacement(chunk.ops, st.lines, idx, found.tier);
    st.lines.splice(idx, oldLines.length, ...replacement);
    cursor = idx + replacement.length;
  }
  if (edit.moveTo !== null && edit.moveTo !== undefined) {
    tree.remove(path);
    tree.setState(newPath, st);
    return { move: { oldPath: path, newPath } };
  }
  tree.setState(path, st);
  return {};
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

function validateJsonEdit(obj, errLine) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new ParseError(errLine);
  if (typeof obj.path !== 'string') throw new ParseError(errLine);
  if (typeof obj.command !== 'string') throw new ParseError(errLine);
  if (obj.command === 'create') {
    if (typeof obj.file_text !== 'string') throw new ParseError(errLine);
    return { format: 'json', kind: 'create', path: obj.path, text: obj.file_text };
  }
  if (obj.command === 'str_replace') {
    if (typeof obj.old_str !== 'string' || obj.old_str === '') throw new ParseError(errLine);
    const newStr = 'new_str' in obj ? obj.new_str : '';
    if (typeof newStr !== 'string') throw new ParseError(errLine);
    return { format: 'json', kind: 'str_replace', path: obj.path, oldStr: obj.old_str, newStr };
  }
  if (obj.command === 'insert') {
    if (!Number.isInteger(obj.insert_line)) throw new ParseError(errLine);
    if (typeof obj.new_str !== 'string') throw new ParseError(errLine);
    return { format: 'json', kind: 'insert', path: obj.path, insertLine: obj.insert_line, newStr: obj.new_str };
  }
  throw new ParseError(errLine);
}

function parseJSONEdits(lines, patchText) {
  let firstIdx = -1;
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].trim() !== '') {
      firstIdx = k;
      break;
    }
  }
  if (firstIdx === -1) throw new ParseError(1);
  const firstLine = lines[firstIdx];
  if (firstLine.trimStart().startsWith('[')) {
    let arr;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw new ParseError(firstIdx + 1);
    }
    if (!Array.isArray(arr)) throw new ParseError(firstIdx + 1);
    const edits = arr.map((obj) => validateJsonEdit(obj, firstIdx + 1));
    if (edits.length === 0) throw new ParseError(1);
    return edits;
  }
  const edits = [];
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (l.trim() === '') continue;
    let obj;
    try {
      obj = JSON.parse(l);
    } catch {
      throw new ParseError(k + 1);
    }
    edits.push(validateJsonEdit(obj, k + 1));
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

function countOverlapping(text, needle) {
  let count = 0;
  let pos = 0;
  for (;;) {
    const idx = text.indexOf(needle, pos);
    if (idx === -1) return count;
    count++;
    pos = idx + 1;
  }
}

function applyJSON(tree, edit) {
  const { kind, path } = edit;
  if (!isSafePath(path)) return { fail: { code: 'unsafe', path } };
  if (kind === 'create') {
    if (tree.get(path).exists) return { fail: { code: 'exists', path } };
    tree.setText(path, edit.text);
    return {};
  }
  const cur = tree.get(path);
  if (!cur.exists) return { fail: { code: 'missing', path } };
  if (kind === 'str_replace') {
    const st = parseFileState(cur.text);
    if (st.brk === '\r\n') {
      const normText = cur.text.replace(/\r\n/g, '\n');
      const normOld = edit.oldStr.replace(/\r\n/g, '\n');
      const normNew = edit.newStr.replace(/\r\n/g, '\n');
      const count = countOverlapping(normText, normOld);
      if (count === 0) return { fail: { code: 'no-match', path } };
      if (count > 1) return { fail: { code: 'ambiguous', path } };
      const idx = normText.indexOf(normOld);
      const replaced = normText.slice(0, idx) + normNew + normText.slice(idx + normOld.length);
      tree.setText(path, replaced.replace(/\n/g, '\r\n'));
      return {};
    }
    const count = countOverlapping(cur.text, edit.oldStr);
    if (count === 0) return { fail: { code: 'no-match', path } };
    if (count > 1) return { fail: { code: 'ambiguous', path } };
    const idx = cur.text.indexOf(edit.oldStr);
    tree.setText(path, cur.text.slice(0, idx) + edit.newStr + cur.text.slice(idx + edit.oldStr.length));
    return {};
  }
  // insert
  const st = parseFileState(cur.text);
  if (edit.insertLine < 0 || edit.insertLine > st.lines.length) {
    return { fail: { code: 'no-match', path } };
  }
  const newLines = edit.newStr === '' ? [] : splitLines(edit.newStr);
  st.lines.splice(edit.insertLine, 0, ...newLines);
  tree.setState(path, st);
  return {};
}

// ---------------------------------------------------------------------------
// Applying edits, output and writes (SPEC sections 2 and 10)
// ---------------------------------------------------------------------------

function applyEdit(tree, edit, strict) {
  if (edit.format === 'unified') return applyUnified(tree, edit, strict);
  if (edit.format === 'search-replace') return applySearchReplace(tree, edit, strict);
  if (edit.format === 'v4a') return applyV4A(tree, edit, strict);
  return applyJSON(tree, edit);
}

function computeChangeLines(tree, moves) {
  const changed = [];
  for (const [p, orig] of tree.original) {
    if (tree.working.get(p) !== orig) changed.push(p);
  }
  const claimedOld = new Set();
  const claimedNew = new Set();
  const lineObjs = [];
  for (const mv of moves) {
    const oldBefore = tree.original.get(mv.oldPath);
    const oldAfter = tree.working.get(mv.oldPath);
    const newBefore = tree.original.get(mv.newPath);
    const newAfter = tree.working.get(mv.newPath);
    if (oldBefore !== null && oldBefore !== undefined && oldAfter === null && newBefore === null && newAfter !== null) {
      claimedOld.add(mv.oldPath);
      claimedNew.add(mv.newPath);
      lineObjs.push({ key: mv.newPath, text: `R ${mv.oldPath} -> ${mv.newPath}` });
    }
  }
  for (const p of changed) {
    if (claimedOld.has(p) || claimedNew.has(p)) continue;
    const before = tree.original.get(p);
    const after = tree.working.get(p);
    if (before === null) lineObjs.push({ key: p, text: `A ${p}` });
    else if (after === null) lineObjs.push({ key: p, text: `D ${p}` });
    else lineObjs.push({ key: p, text: `M ${p}` });
  }
  lineObjs.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const out = lineObjs.map((o) => o.text);
  out.push(out.length === 1 ? 'ok: 1 file' : `ok: ${out.length} files`);
  return out;
}

function writeChanges(tree) {
  const changed = [];
  for (const [p, orig] of tree.original) {
    if (tree.working.get(p) !== orig) changed.push(p);
  }
  for (const p of changed) {
    if (tree.working.get(p) === null) {
      try {
        rmSync(p, { force: true });
      } catch {
        // leave the tree as it is; the failure is not specified by SPEC.md
      }
    }
  }
  for (const p of changed) {
    const t = tree.working.get(p);
    if (t !== null) {
      try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, t, 'utf8');
      } catch {
        // leave the tree as it is; the failure is not specified by SPEC.md
      }
    }
  }
}

function runCli(argv) {
  const opts = parseArgs(argv);
  if (!opts) return { code: 2, lines: ['error: usage'] };

  let patchText;
  if (opts.patchArg === null || opts.patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(opts.patchArg, 'utf8');
    } catch {
      return { code: 2, lines: ['error: no-patch'] };
    }
  }

  const lines = splitLines(patchText);
  let format = opts.format;
  if (format === 'auto') {
    format = detectFormat(lines);
    if (!format) return { code: 2, lines: ['error: format'] };
  }

  let edits;
  try {
    if (format === 'unified') edits = parseUnifiedDiff(lines);
    else if (format === 'search-replace') edits = parseSearchReplace(lines);
    else if (format === 'v4a') edits = parseV4A(lines);
    else edits = parseJSONEdits(lines, patchText);
  } catch (e) {
    if (e instanceof ParseError) return { code: 2, lines: [`error: parse ${e.line}`] };
    throw e;
  }

  const tree = makeTree();
  const failures = [];
  const moves = [];
  for (const edit of edits) {
    const result = applyEdit(tree, edit, opts.strict);
    if (result.fail) failures.push(result.fail);
    else if (result.move) moves.push(result.move);
  }
  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    return { code: 1, lines: out };
  }

  const out = computeChangeLines(tree, moves);
  if (!opts.check) writeChanges(tree);
  return { code: 0, lines: out };
}

async function main() {
  if (process.env.MAKEFUN_ENV_URL) {
    const { runTrial } = await import('./runner.ts');
    await runTrial(process.env.MAKEFUN_ENV_URL);
    return;
  }
  const result = runCli(process.argv.slice(2));
  process.stdout.write(result.lines.map((l) => l + '\n').join(''));
  process.exitCode = result.code;
}

main().catch((err) => {
  process.stderr.write(String((err && err.stack) || err) + '\n');
  process.exitCode = 1;
});
