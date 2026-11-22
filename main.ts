// mend: one command-line tool that applies AI-written edits in four formats
// (unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON tool calls) to a
// tree of text files, following SPEC.md version 1. Node 22, standard library
// alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 failure: the whole run stops with this one stdout line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed; the patch still reports every failure, exit 1. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC.md section 3: a safe path. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Byte order of UTF-8 paths, for the exit-0 rows. */
function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** A file as lines: its own line break, and whether it ends with one. */
interface FileDoc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseDoc(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function renderDoc(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in patch order: [old, new]. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers
// ---------------------------------------------------------------------------

type Tier = 0 | 1 | 2;

/** One line normalised at a tier: exact, trailing whitespace off, both ends off. */
function normLine(line: string, tier: Tier): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : '';
}

/** Every position at or after `from` where O occurs in the file at this tier. */
function findOccurrences(file: string[], o: string[], tier: Tier, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const fn = file.map((l) => normLine(l, tier));
  const on = o.map((l) => normLine(l, tier));
  for (let i = Math.max(0, from); i + o.length <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (fn[i + j] !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * The first tier (0, then 1, then 2; strict: 0 only) at which O occurs.
 * `accept` narrows which occurrences count, before the tier is chosen, so an
 * end-of-file chunk picks the first tier with an occurrence ending at the
 * file's last line rather than the first tier with any occurrence.
 */
function firstTierWith(
  file: string[],
  o: string[],
  strict: boolean,
  from: number,
  accept?: (pos: number) => boolean,
): { tier: Tier; pos: number[] } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = findOccurrences(file, o, t, from).filter((p) => !accept || accept(p));
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of a hunk or chunk: context (kept), deleted, or added. */
interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}

/**
 * Replace the k matched lines at `pos` (O = the ctx and del lines) with N (the
 * ctx and add lines). A context line is written as the file's own matched
 * line. At tier 2 every other line of N is re-indented: its leading P (the
 * leading whitespace of O's first line) is replaced by F (that of the file's
 * first matched line), unless it is empty or only whitespace.
 */
function applyBlock(file: string[], pos: number, ops: Op[], tier: Tier): string[] {
  const oLen = ops.reduce((n, o) => n + (o.kind === 'add' ? 0 : 1), 0);
  const firstO = ops.find((o) => o.kind !== 'add');
  const p = firstO ? leadingWs(firstO.text) : '';
  const f = firstO ? leadingWs(file[pos] ?? '') : '';
  const out: string[] = [];
  let oIdx = 0;
  for (const op of ops) {
    if (op.kind === 'del') {
      oIdx += 1;
      continue;
    }
    if (op.kind === 'ctx') {
      out.push(file[pos + oIdx]!);
      oIdx += 1;
      continue;
    }
    let t = op.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return [...file.slice(0, pos), ...out, ...file.slice(pos + oLen)];
}

// ---------------------------------------------------------------------------
// Section 4: detecting the format
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  )
    return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not one (a parse fault). */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const doc = parseDoc(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      doc.lines.splice(line, 0, ...add);
      tree.now.set(p, renderDoc(doc));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

interface Hunk {
  /** A: the old-file start line (1-based) from the header. */
  a: number;
  ops: Op[];
  /** A `\` line follows the hunk's last context or `+` line. */
  backslashAfterLastN: boolean;
  /** A `\` line follows this hunk's last `+` line, or null when it has none. */
  lastPlusBackslash: boolean | null;
}

interface Section {
  /** null means /dev/null (no file). */
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
  /** A `\` line follows the section's last `+` line (any hunk). */
  lastPlusBackslash: boolean;
  /** Index of the first line after this section. */
  next: number;
}

/** A ---/+++ path: text after the four characters, up to the first tab, trimmed, a/ or b/ removed. */
function diffPath(raw: string): string | null {
  let p = raw.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p === '/dev/null' ? null : p;
}

function parseHunk(lines: string[], j: number): { hunk: Hunk; next: number } {
  const header = lines[j]!;
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  if (!m) throw new Exit2(`error: parse ${j + 1}`);
  let k = j + 1;
  const raw: string[] = [];
  while (k < lines.length) {
    const l = lines[k]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      raw.push(l);
      k += 1;
    } else {
      break;
    }
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  interface El {
    kind: 'ctx' | 'del' | 'add' | 'bs';
    text: string;
  }
  const els: El[] = raw.map((l) => {
    if (l.startsWith('\\')) return { kind: 'bs', text: '' };
    if (l === '') return { kind: 'ctx', text: '' };
    if (l[0] === ' ') return { kind: 'ctx', text: l.slice(1) };
    if (l[0] === '-') return { kind: 'del', text: l.slice(1) };
    return { kind: 'add', text: l.slice(1) };
  });
  const ops: Op[] = els.filter((e) => e.kind !== 'bs').map((e) => ({ kind: e.kind as Op['kind'], text: e.text }));
  let lastN = -1;
  let lastPlus = -1;
  for (let t = 0; t < els.length; t += 1) {
    if (els[t]!.kind === 'ctx' || els[t]!.kind === 'add') lastN = t;
    if (els[t]!.kind === 'add') lastPlus = t;
  }
  return {
    hunk: {
      a: parseInt(m[1]!, 10),
      ops,
      backslashAfterLastN: lastN >= 0 && els[lastN + 1]?.kind === 'bs',
      lastPlusBackslash: lastPlus >= 0 ? els[lastPlus + 1]?.kind === 'bs' : null,
    },
    next: k,
  };
}

function parseSection(lines: string[], start: number, gitOld: string | null, gitNew: string | null): Section {
  let pairOld: string | null | undefined;
  let pairNew: string | null | undefined;
  let renameOld: string | undefined;
  let renameNew: string | undefined;
  let isCreate = false;
  let isDelete = false;
  const hunks: Hunk[] = [];
  let inHeader = true;
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) {
      if (!inHeader) break;
      if (pairOld === undefined) {
        pairOld = diffPath(l);
        pairNew = diffPath(lines[j + 1]!);
      }
      j += 2;
      continue;
    }
    if (inHeader && l.startsWith('--- ')) throw new Exit2(`error: parse ${j + 2}`);
    if (l.startsWith('@@')) {
      inHeader = false;
      const parsed = parseHunk(lines, j);
      hunks.push(parsed.hunk);
      j = parsed.next;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('rename from ') && renameOld === undefined) renameOld = l.slice(12).trim();
      else if (l.startsWith('rename to ') && renameNew === undefined) renameNew = l.slice(10).trim();
      else if (l.startsWith('new file mode')) isCreate = true;
      else if (l.startsWith('deleted file mode')) isDelete = true;
    }
    j += 1;
  }
  let lastPlusBackslash = false;
  for (const h of hunks) {
    if (h.lastPlusBackslash !== null) lastPlusBackslash = h.lastPlusBackslash;
  }
  return {
    oldPath: pairOld !== undefined ? pairOld : (renameOld ?? gitOld),
    newPath: pairNew !== undefined ? pairNew : (renameNew ?? gitNew),
    isCreate,
    isDelete,
    hunks,
    lastPlusBackslash,
    next: j,
  };
}

/** Apply a section's hunks in order to a file's text. Throws Fail on a hunk that finds no match. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const doc = parseDoc(text);
  let d = 0;
  for (const h of hunks) {
    const oOps = h.ops.filter((o) => o.kind !== 'add');
    const o = oOps.map((op) => op.text);
    const nCount = h.ops.filter((op) => op.kind !== 'del').length;
    if (o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, doc.lines.length));
      const atEnd = at === doc.lines.length;
      const ins = h.ops.filter((op) => op.kind === 'add').map((op) => op.text);
      doc.lines.splice(at, 0, ...ins);
      if (atEnd) doc.final = !h.backslashAfterLastN;
      d += ins.length;
      continue;
    }
    const found = firstTierWith(doc.lines, o, strict, 0);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const atEnd = best + o.length === doc.lines.length;
    doc.lines = applyBlock(doc.lines, best, h.ops, found.tier);
    if (atEnd) doc.final = !h.backslashAfterLastN;
    d += nCount - o.length;
  }
  return renderDoc(doc);
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = sec.isCreate || oldP === null;
    const isDelete = !isCreate && (sec.isDelete || newP === null);
    if (isCreate) {
      if (newP === null) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const op of h.ops) if (op.kind === 'add') plus.push(op.text);
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (sec.lastPlusBackslash ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || newP === null) return;
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(cur, sec.hunks, strict, oldP);
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(cur, sec.hunks, strict, oldP));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const sec = parseSection(lines, i + 1, m[1]!, m[2]!);
      edits.push(unifiedEdit(sec, strict));
      i = sec.next;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec = parseSection(lines, i, null, null);
      edits.push(unifiedEdit(sec, strict));
      i = sec.next;
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const doc = parseDoc(cur);
    const found = firstTierWith(doc.lines, oldLines, strict, 0);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const ops: Op[] = [
      ...oldLines.map((t): Op => ({ kind: 'del', text: t })),
      ...newLines.map((t): Op => ({ kind: 'add', text: t })),
    ];
    doc.lines = applyBlock(doc.lines, found.pos[0]!, ops, found.tier);
    tree.now.set(path, renderDoc(doc));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const isSearch = (l: string): boolean => l.trimEnd() === '<<<<<<< SEARCH';
  const isSep = (l: string): boolean => l.trimEnd() === '=======';
  const isReplace = (l: string): boolean => l.trimEnd() === '>>>>>>> REPLACE';
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    let s = -1;
    for (let j = i; j < lines.length; j += 1) {
      if (isSearch(lines[j]!)) {
        s = j;
        break;
      }
    }
    if (s === -1) break;
    let m = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (isSep(lines[j]!)) {
        m = j;
        break;
      }
    }
    if (m === -1) throw new Exit2(`error: parse ${s + 1}`);
    let r = -1;
    for (let j = m + 1; j < lines.length; j += 1) {
      if (isReplace(lines[j]!)) {
        r = j;
        break;
      }
    }
    if (r === -1) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    prevPath = path;
    edits.push(srEdit(path, lines.slice(s + 1, m), lines.slice(m + 1, r), strict));
    prevEnd = r;
    i = r + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

const V4A_ADD = '*** Add File: ';
const V4A_DELETE = '*** Delete File: ';
const V4A_UPDATE = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';
const V4A_EOF = '*** End of File';

interface V4AChunk {
  /** null: no @@ line; '': @@ with empty text, also no anchor. */
  anchor: string | null;
  ops: Op[];
  eof: boolean;
}

function v4aSection(
  kind: 'add' | 'delete' | 'update',
  path: string,
  secLines: Array<{ text: string; idx: number }>,
  headerIdx: number,
  strict: boolean,
): Edit {
  if (kind === 'add') {
    const out: string[] = [];
    for (const { text, idx } of secLines) {
      if (text.startsWith('+')) out.push(text.slice(1));
      else if (text === '') out.push('');
      else throw new Exit2(`error: parse ${idx + 1}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, out.length === 0 ? '' : out.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    if (secLines.length > 0) throw new Exit2(`error: parse ${secLines[0]!.idx + 1}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  // Update: an optional Move to first, then chunks.
  let moveTo: string | null = null;
  let j = 0;
  if (secLines[0] && secLines[0].text.startsWith(V4A_MOVE)) {
    moveTo = secLines[0].text.slice(V4A_MOVE.length).trim();
    j = 1;
  }
  const chunks: V4AChunk[] = [];
  let current: V4AChunk | null = null;
  for (; j < secLines.length; j += 1) {
    const { text, idx } = secLines[j]!;
    if (text.startsWith('@@')) {
      if (current) chunks.push(current);
      current = { anchor: text.slice(2).trim(), ops: [], eof: false };
    } else if (text === V4A_EOF) {
      if (current) {
        current.eof = true;
        chunks.push(current);
        current = null;
      }
    } else if (text.startsWith(V4A_MOVE)) {
      throw new Exit2(`error: parse ${idx + 1}`);
    } else if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
      if (!current) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${idx + 1}`);
        current = { anchor: null, ops: [], eof: false };
      }
      if (text === '') current.ops.push({ kind: 'ctx', text: '' });
      else if (text[0] === ' ') current.ops.push({ kind: 'ctx', text: text.slice(1) });
      else if (text[0] === '-') current.ops.push({ kind: 'del', text: text.slice(1) });
      else current.ops.push({ kind: 'add', text: text.slice(1) });
    } else {
      throw new Exit2(`error: parse ${idx + 1}`);
    }
  }
  if (current) chunks.push(current);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerIdx + 1}`);
  const moveTarget = moveTo;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTarget !== null && !safe(moveTarget)) throw new Fail('unsafe', moveTarget);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTarget !== null && tree.get(moveTarget) !== null) throw new Fail('exists', moveTarget);
    const doc = parseDoc(cur);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        const anchor = chunk.anchor;
        const tiers: Tier[] = strict ? [0] : [0, 1, 2];
        let foundAt = -1;
        outer: for (const t of tiers) {
          const want = normLine(anchor, t);
          for (let k = cursor; k < doc.lines.length; k += 1) {
            if (normLine(doc.lines[k]!, t) === want) {
              foundAt = k;
              break outer;
            }
          }
        }
        if (foundAt === -1) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const oOps = chunk.ops.filter((o) => o.kind !== 'add');
      const o = oOps.map((op) => op.text);
      const nCount = chunk.ops.filter((op) => op.kind !== 'del').length;
      if (o.length === 0) {
        const ins = chunk.ops.filter((op) => op.kind === 'add').map((op) => op.text);
        const at = chunk.eof ? doc.lines.length : Math.min(cursor, doc.lines.length);
        doc.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const found = firstTierWith(doc.lines, o, strict, cursor, (p) => !chunk.eof || p + o.length === doc.lines.length);
      if (!found) throw new Fail('no-match', path);
      doc.lines = applyBlock(doc.lines, found.pos[0]!, chunk.ops, found.tier);
      cursor = found.pos[0]! + nCount;
    }
    const out = renderDoc(doc);
    if (moveTarget !== null) {
      tree.now.set(moveTarget, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTarget]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isHeader = (l: string): boolean =>
    l.startsWith(V4A_ADD) || l.startsWith(V4A_DELETE) || l.startsWith(V4A_UPDATE);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith(V4A_ADD)) {
      kind = 'add';
      path = line.slice(V4A_ADD.length).trim();
    } else if (line.startsWith(V4A_DELETE)) {
      kind = 'delete';
      path = line.slice(V4A_DELETE.length).trim();
    } else if (line.startsWith(V4A_UPDATE)) {
      kind = 'update';
      path = line.slice(V4A_UPDATE.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerIdx = i;
    i += 1;
    const secLines: Array<{ text: string; idx: number }> = [];
    while (i < last) {
      if (isHeader(lines[i]!)) break;
      secLines.push({ text: lines[i]!, idx: i });
      i += 1;
    }
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
    edits.push(v4aSection(kind, path, secLines, headerIdx, strict));
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Sections 1, 2 and 10: invocation, output, exit codes, atomicity
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.slice();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      for (const m of movesBefore) tree.moves.push(m);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rows: Array<{ key: string; text: string }> = [];
  const paired = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (paired.has(oldP) || paired.has(newP)) continue;
    const o = changed.get(oldP);
    const n = changed.get(newP);
    if (o && o.was !== null && o.now === null && n && n.was === null && n.now !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      paired.add(oldP);
      paired.add(newP);
    }
  }
  for (const [p, c] of changed) {
    if (paired.has(p)) continue;
    rows.push({ key: p, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    for (const [p, c] of changed) {
      if (c.now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, c.now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
