/**
 * Small, dependency-free helpers for scanning JS/TS source text.
 *
 * `maskSource` walks the code with a tiny lexer and blanks out comments
 * (and optionally string contents) while preserving offsets and newlines,
 * so regex matches against the masked text map 1:1 to the original lines.
 */

export interface MaskOptions {
  comments?: boolean;
  strings?: boolean;
}

const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)\s*$/;

function blank(ch: string): string {
  return ch === '\n' || ch === '\r' ? ch : ' ';
}

export function maskSource(src: string, opts: MaskOptions = { comments: true }): string {
  const maskComments = opts.comments !== false;
  const maskStrings = opts.strings === true;
  const out: string[] = new Array(src.length);
  // Stack of brace depths for nested template literal expressions.
  const templateStack: number[] = [];
  let braceDepth = 0;
  let i = 0;
  let lastSignificant = '';
  let lastSignificantIndex = -1;

  const emit = (idx: number, masked: boolean) => {
    const ch = src[idx]!;
    out[idx] = masked ? blank(ch) : ch;
  };

  const readString = (quote: string) => {
    emit(i, false); // opening quote
    i++;
    while (i < src.length) {
      const ch = src[i]!;
      if (ch === '\\') {
        emit(i, maskStrings);
        if (i + 1 < src.length) emit(i + 1, maskStrings);
        i += 2;
        continue;
      }
      if (ch === quote) {
        emit(i, false);
        i++;
        return;
      }
      if (ch === '\n') {
        // Unterminated string: stop at end of line.
        emit(i, false);
        i++;
        return;
      }
      emit(i, maskStrings);
      i++;
    }
  };

  /** Reads template chars until closing backtick or `${`. Returns true if it stopped at `${`. */
  const readTemplateChunk = (): boolean => {
    while (i < src.length) {
      const ch = src[i]!;
      if (ch === '\\') {
        emit(i, maskStrings);
        if (i + 1 < src.length) emit(i + 1, maskStrings);
        i += 2;
        continue;
      }
      if (ch === '`') {
        emit(i, false);
        i++;
        return false;
      }
      if (ch === '$' && src[i + 1] === '{') {
        emit(i, false);
        emit(i + 1, false);
        i += 2;
        return true;
      }
      emit(i, maskStrings);
      i++;
    }
    return false;
  };

  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];

    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        emit(i, maskComments);
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      while (i < stop) {
        emit(i, maskComments);
        i++;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      readString(ch);
      lastSignificant = ch;
      lastSignificantIndex = i - 1;
      continue;
    }
    if (ch === '`') {
      emit(i, false);
      i++;
      if (readTemplateChunk()) {
        templateStack.push(braceDepth);
        braceDepth++;
      }
      lastSignificant = '`';
      lastSignificantIndex = i - 1;
      continue;
    }
    if (ch === '/') {
      const before = src.slice(Math.max(0, lastSignificantIndex - 12), lastSignificantIndex + 1);
      const looksLikeRegex = lastSignificant === '' || REGEX_PRECEDERS.has(lastSignificant) || REGEX_KEYWORDS.test(before);
      if (looksLikeRegex) {
        // Regex literal: treated like a string (body masked when masking strings).
        emit(i, false);
        i++;
        let inClass = false;
        while (i < src.length && src[i] !== '\n') {
          const c = src[i]!;
          if (c === '\\') {
            emit(i, maskStrings);
            if (i + 1 < src.length) emit(i + 1, maskStrings);
            i += 2;
            continue;
          }
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) {
            emit(i, false);
            i++;
            break;
          }
          emit(i, maskStrings);
          i++;
        }
        lastSignificant = ')';
        lastSignificantIndex = i - 1;
        continue;
      }
    }
    if (ch === '{') {
      braceDepth++;
    } else if (ch === '}') {
      braceDepth--;
      if (templateStack.length > 0 && braceDepth === templateStack[templateStack.length - 1]) {
        templateStack.pop();
        emit(i, false);
        i++;
        if (readTemplateChunk()) {
          templateStack.push(braceDepth);
          braceDepth++;
        }
        lastSignificant = '`';
        lastSignificantIndex = i - 1;
        continue;
      }
    }
    emit(i, false);
    if (!/\s/.test(ch)) {
      lastSignificant = /[\w$]/.test(ch) ? 'w' : ch;
      lastSignificantIndex = i;
    }
    i++;
  }
  return out.join('');
}

/** Blank out SQL comments (`-- ...` and block comments) while preserving offsets. */
export function maskSqlComments(src: string): string {
  return src.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Pre-computed line index for fast offset -> line lookups. */
export class LineIndex {
  private readonly starts: number[] = [0];
  constructor(private readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
    }
  }
  /** 1-based line number for a character offset. */
  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
  columnOf(offset: number): number {
    return offset - this.starts[this.lineOf(offset) - 1]! + 1;
  }
  /** Text of a 1-based line, without the trailing newline. */
  line(n: number): string {
    const start = this.starts[n - 1];
    if (start === undefined) return '';
    const end = this.starts[n] ?? this.text.length + 1;
    return this.text.slice(start, end - 1).replace(/\r$/, '');
  }
  get lineCount(): number {
    return this.starts.length;
  }
}

export function lineCount(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Trim a source line for display. */
export function snippetOf(line: string, max = 140): string {
  const t = line.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Does the file start with a given directive ("use client" / "use server")? */
export function hasDirective(src: string, directive: 'use client' | 'use server'): boolean {
  const masked = maskSource(src.slice(0, 4000));
  // Directives must be the first statements; allow other directives before it.
  const re = /^(?:\s*(['"])use [a-z ]+\1\s*;?)*/;
  const prologue = re.exec(masked)?.[0] ?? '';
  return prologue.includes(`'${directive}'`) || prologue.includes(`"${directive}"`);
}

/** Parse JSON with comments and trailing commas (tsconfig.json style). */
export function parseJsonc<T = unknown>(text: string): T | null {
  try {
    const noComments = maskSource(text, { comments: true });
    const noTrailing = noComments.replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(noTrailing) as T;
  } catch {
    return null;
  }
}

/** Find the index of the matching closing bracket starting at an opening bracket. Operates on masked text. */
export function matchBracket(text: string, openIndex: number): number {
  const open = text[openIndex];
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const c = text[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
