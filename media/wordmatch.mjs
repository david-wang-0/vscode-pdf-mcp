// @ts-check
/**
 * Word-level SyncTeX: SyncTeX records source lines only, so the word under the pointer (or
 * the cursor) is found on the other side by matching text. Both sides are cut into
 * normalised words: LaTeX source (`texTokens`: comments, control words, the keys of
 * \cite, \ref and \label, braces dropped; math opaque) and PDF text (`pdfTokens`:
 * ligatures, line-end hyphenation). An anchor is the word(s) with a few words of context
 * on each side; `findAnchor` takes the occurrence whose context agrees best and gives up
 * when that is not unique. Pure: shared by the webview, the extension (dynamic import)
 * and the unit tests.
 */

/** Words of context on each side of an anchor. */
export const CONTEXT = 6;

/**
 * @typedef {{norm: string, start: number, end: number, math?: boolean}} Token a word:
 *   `norm` normalised ("" for math), [start, end) offsets into the text it was cut from
 * @typedef {{before: string[], words: string[], after: string[]}} Anchor normalised words
 * @typedef {{c: string, at: number} | {math: true, at: number, to: number}} Item
 */

const WORD = /[\p{L}\p{N}\p{M}]/u;
/** Inside a word these join its parts and are dropped: non-deterministic = nondeterministic. */
const JOINER = /^['\u2019\u02BC\-\u2010\u2011]$/;

/**
 * The normal form of a word: compatibility-decomposed (ligatures to letters, accents
 * apart), marks and anything not a letter or digit dropped, lower case.
 * @param {string} s
 */
export function normWord(s) {
  return s.normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

/**
 * Cut a stream of characters into words. A joiner between two word characters stays in
 * the word; everything else that is not a word character separates.
 * @param {Item[]} items @returns {Token[]}
 */
function segment(items) {
  /** @type {Token[]} */
  const out = [];
  let raw = "";
  let start = -1;
  let end = -1;
  const flush = () => {
    if (start >= 0) {
      const norm = normWord(raw);
      if (norm) out.push({ norm, start, end });
    }
    raw = "";
    start = -1;
  };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if ("math" in it) {
      flush();
      out.push({ norm: "", start: it.at, end: it.to, math: true });
      continue;
    }
    if (WORD.test(it.c)) {
      if (start < 0) start = it.at;
      raw += it.c;
      end = it.at + it.c.length;
      continue;
    }
    const next = items[i + 1];
    if (start >= 0 && JOINER.test(it.c) && next && "c" in next && WORD.test(next.c)) continue;
    flush();
  }
  flush();
  return out;
}

// ---- PDF text ---------------------------------------------------------------------------

/**
 * The words of PDF text (the text layer of a page, lines joined with "\n"). A hyphen at a
 * line end between letters joins the two parts (TeX's hyphenation); a soft hyphen goes.
 * @param {string} text @returns {Token[]}
 */
export function pdfTokens(text) {
  /** @type {Item[]} */
  const items = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const soft = c === "\u00AD";
    if (soft || ((c === "-" || c === "\u2010") && i > 0 && /\p{L}/u.test(text[i - 1]))) {
      // TeX's hyphenation: the next line's word continues this one
      const m = /^[ \t]*\n\s*/.exec(text.slice(i + 1, i + 40));
      if (m && /\p{L}/u.test(text[i + 1 + m[0].length] || "")) {
        i += m[0].length;
        continue;
      }
      if (soft) continue;
    }
    items.push({ c, at: i });
  }
  return segment(items);
}

// ---- LaTeX source -----------------------------------------------------------------------

/** Control words dropped with their arguments: how many mandatory ones. */
const DROP = new Map([
  ...["cite", "citep", "citet", "citealp", "citealt", "citeauthor", "citeyear", "parencite", "textcite",
    "autocite", "nocite", "ref", "eqref", "pageref", "autoref", "cref", "Cref", "vref", "nameref", "label",
    "href", "input", "include", "includegraphics", "usepackage", "documentclass", "bibliography",
    "bibliographystyle", "begin", "end", "vspace", "hspace", "hypersetup", "color", "textcolor", "pagestyle",
    "thispagestyle", "linespread"].map((n) => /** @type {[string, number]} */ ([n, 1])),
  ...["setlength", "setcounter", "addtocounter", "newcommand", "renewcommand", "providecommand",
    "DeclareMathOperator", "fontsize"].map((n) => /** @type {[string, number]} */ ([n, 2])),
]);
/** Control words that print a letter (inside a word, no break). */
const LETTERS = new Map([["i", "i"], ["j", "j"], ["ss", "ß"], ["o", "ø"], ["O", "Ø"], ["ae", "æ"], ["AE", "Æ"],
  ["oe", "œ"], ["OE", "Œ"], ["aa", "å"], ["AA", "Å"], ["l", "ł"], ["L", "Ł"]]);
/** Accent commands: the accent goes, the letter stays (and PDF text loses its accents too). */
const ACCENT_WORDS = new Set(["c", "v", "u", "H", "k", "r", "d", "b", "t"]);
const ACCENT_SYMBOLS = new Set(["'", "\"", "`", "^", "~", "=", "."]);
/** Environments whose body is math. */
const MATH_ENVS = /^(equation|align|alignat|flalign|gather|multline|eqnarray|displaymath|math|split)\*?$/;

/**
 * The words of LaTeX source (several lines joined with "\n"), offsets into it. Comments,
 * braces and control words go (\emph{x} gives x); the arguments of \cite, \ref, \label
 * and the like go entirely; ~ is a space; quotes and dashes separate words; $...$, \(...\),
 * \[...\] and math environments are one opaque token each (norm "", `math`).
 * @param {string} text @returns {Token[]}
 */
export function texTokens(text) {
  /** @type {Item[]} */
  const items = [];
  const n = text.length;
  let i = 0;
  /** @param {number} j */
  const skipSpaces = (j) => {
    while (j < n && (text[j] === " " || text[j] === "\t" || text[j] === "\n")) j++;
    return j;
  };
  /** Past the group that opens at `j` (`{` or `[`), or `j` if none opens there. @param {number} j */
  const skipGroup = (j) => {
    const open = text[j];
    if (open !== "{" && open !== "[") return j;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    for (let k = j; k < n; k++) {
      const c = text[k];
      if (c === "\\") k++;
      else if (c === "%") while (k < n && text[k] !== "\n") k++;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) return k + 1;
    }
    return n;
  };
  /** The end of math that started before `j`, closed by `close` (a string or env end). @param {number} j @param {string} close */
  const mathEnd = (j, close) => {
    for (let k = j; k < n; k++) {
      if (text[k] === "%") {
        while (k < n && text[k] !== "\n") k++;
        continue;
      }
      if (text.startsWith(close, k)) return k + close.length;
      if (text[k] === "\\" && close[0] !== "\\") k++;
    }
    return n;
  };
  while (i < n) {
    const c = text[i];
    if (c === "%") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "{" || c === "}") {
      i++;
      continue;
    }
    if (c === "~") {
      items.push({ c: " ", at: i++ });
      continue;
    }
    if (c === "$") {
      const display = text[i + 1] === "$";
      const to = mathEnd(i + (display ? 2 : 1), display ? "$$" : "$");
      items.push({ math: true, at: i, to });
      i = to;
      continue;
    }
    if (c !== "\\") {
      items.push({ c, at: i++ });
      continue;
    }
    // a control sequence
    const m = /^[A-Za-z@]+/.exec(text.slice(i + 1, i + 64));
    if (!m) {
      const s = text[i + 1] || "";
      if (s === "(" || s === "[") {
        const to = mathEnd(i + 2, s === "(" ? "\\)" : "\\]");
        items.push({ math: true, at: i, to });
        i = to;
      } else if (ACCENT_SYMBOLS.has(s) || s === "-" || s === "/") {
        i += 2; // an accent (the letter follows), a discretionary hyphen, an italic correction
      } else if ("%&_#${}".includes(s) && s) {
        items.push({ c: s, at: i + 1 });
        i += 2;
      } else {
        items.push({ c: " ", at: i }); // \\, \, \; \  ...
        i += 2;
      }
      continue;
    }
    const name = m[0];
    const after = i + 1 + name.length;
    if (LETTERS.has(name) && !/[A-Za-z]/.test(text[after] || "")) {
      items.push({ c: /** @type {string} */ (LETTERS.get(name)), at: i });
      i = text[after] === " " ? after + 1 : after;
      continue;
    }
    if (ACCENT_WORDS.has(name)) {
      i = skipSpaces(after);
      continue;
    }
    if (name === "begin") {
      const envAt = skipSpaces(after);
      const env = /^\{([^}]*)\}/.exec(text.slice(envAt, envAt + 64));
      if (env && MATH_ENVS.test(env[1])) {
        const to = mathEnd(envAt + env[0].length, `\\end{${env[1]}}`);
        items.push({ math: true, at: i, to });
        i = to;
        continue;
      }
    }
    let j = skipSpaces(after);
    const drop = DROP.get(name);
    if (drop) {
      if (text[j] === "*") j = skipSpaces(j + 1);
      for (let k = 0; k < drop; k++) {
        while (text[j] === "[") {
          const to = skipGroup(j);
          // a citation's optional arguments print ("[Chapter 4]"); other ones do not
          if (/cite/i.test(name)) for (let q = j + 1; q < to - 1; q++) items.push({ c: /[{}\\~]/.test(text[q]) ? " " : text[q], at: q });
          j = skipSpaces(to);
        }
        if (text[j] !== "{") break;
        j = skipSpaces(skipGroup(j));
      }
      // \begin{figure}[h]: the placement goes too; \href{url}{text}: the text stays
      if (name === "begin") while (text[j] === "[") j = skipSpaces(skipGroup(j));
    }
    items.push({ c: " ", at: i });
    i = j;
  }
  return segment(items);
}

// ---- anchors and matching -----------------------------------------------------------------

/**
 * The anchor of tokens[index .. index+count): their words and CONTEXT words each side.
 * @param {Token[]} tokens @param {number} index @param {number} [count] @param {number} [context]
 * @returns {Anchor}
 */
export function anchorOf(tokens, index, count = 1, context = CONTEXT) {
  const norms = tokens.map((t) => t.norm);
  return {
    before: norms.slice(Math.max(0, index - context), index),
    words: norms.slice(index, index + count),
    after: norms.slice(index + count, index + count + context),
  };
}

/**
 * How well the context words `a` (nearest first) turn up in order in `b` (nearest
 * first): a longest common subsequence where each pair counts less the further apart
 * its two positions are. Math ("") matches nothing.
 * @param {string[]} a @param {string[]} b
 */
function agreement(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) {
      const pair = a[i - 1] && a[i - 1] === b[j - 1] ? prev[j - 1] + 1 / (1 + 0.25 * Math.abs(i - j)) : 0;
      cur[j] = Math.max(pair, prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Is it an anchor with words to look for? @param {any} a @returns {a is Anchor} */
export function validAnchor(a) {
  const strs = (/** @type {any} */ x) => Array.isArray(x) && x.length <= 64 && x.every((s) => typeof s === "string" && s.length <= 200);
  return !!a && typeof a === "object" && strs(a.before) && strs(a.after) && strs(a.words)
    && a.words.length > 0 && a.words.length <= 32 && a.words.every((/** @type {string} */ w) => w !== "");
}

/** Scores closer than this are a tie. */
const TIE = 0.05;

/**
 * Where the anchor is among `tokens`: each occurrence of its words that `weight` allows
 * (a number: a bonus, e.g. for the line SyncTeX named; null: not a candidate) scores the
 * context words found in order on each side, plus that bonus. The best wins only if no
 * other scores about as much; else null (not confident).
 * @param {Token[]} tokens @param {Anchor} anchor
 * @param {(index: number, count: number) => number | null} [weight]
 * @returns {{index: number, count: number, score: number} | null}
 */
export function findAnchor(tokens, anchor, weight = () => 0) {
  const r = rank(tokens, anchor, weight);
  return r.best && !r.tie ? r.best : null;
}

/**
 * @param {Token[]} tokens @param {Anchor} anchor @param {(index: number, count: number) => number | null} weight
 * @returns {{best: {index: number, count: number, score: number} | null, tie: boolean}}
 */
function rank(tokens, anchor, weight) {
  if (!validAnchor(anchor)) return { best: null, tie: false };
  const k = anchor.words.length;
  const before = [...anchor.before].reverse();
  /** @type {{index: number, count: number, score: number} | null} */
  let best = null;
  let second = -Infinity;
  for (let i = 0; i + k <= tokens.length; i++) {
    let same = true;
    for (let j = 0; j < k && same; j++) same = tokens[i + j].norm === anchor.words[j];
    if (!same) continue;
    const bonus = weight(i, k);
    if (bonus === null) continue;
    const left = tokens.slice(Math.max(0, i - before.length - 3), i).map((t) => t.norm).reverse();
    const right = tokens.slice(i + k, i + k + anchor.after.length + 3).map((t) => t.norm);
    const score = agreement(before, left) + agreement(anchor.after, right) + bonus;
    if (!best || score > best.score) {
      if (best) second = best.score;
      best = { index: i, count: k, score };
    } else {
      second = Math.max(second, score);
    }
  }
  return { best, tie: !!best && best.score - second < TIE };
}

// ---- source lines -------------------------------------------------------------------------

/**
 * Tokens of lines [from, to) (0-based, clamped) and how to map an offset back to a
 * line and column.
 * @param {string[]} lines @param {number} from @param {number} to
 */
function sourceWindow(lines, from, to) {
  const a = Math.max(0, from);
  const b = Math.min(lines.length, to);
  /** @type {number[]} */
  const starts = [];
  let at = 0;
  for (let l = a; l < b; l++) {
    starts.push(at);
    at += lines[l].length + 1;
  }
  const tokens = texTokens(lines.slice(a, b).join("\n"));
  /** 0-based line and column of an offset. @param {number} off */
  const where = (off) => {
    let lo = 0;
    for (let hi = starts.length - 1; lo < hi;) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return { line: a + lo, column: off - starts[lo] };
  };
  return { tokens, where, offset: (/** @type {number} */ line, /** @type {number} */ col) => starts[line - a] + col };
}

/**
 * The anchor for a forward search from `line` (1-based), `column` (0-based; to `end`
 * when a stretch is selected): the word at the column (or right after it, else the
 * last before it on the line), or the words the stretch touches, with context from the
 * lines around. Null when there is no such word or it is math.
 * @param {string[]} lines @param {number} line @param {number} column @param {number} [end]
 * @returns {Anchor | null}
 */
export function sourceAnchor(lines, line, column, end) {
  const l0 = line - 1;
  if (l0 < 0 || l0 >= lines.length || !Number.isInteger(column) || column < 0) return null;
  const w = sourceWindow(lines, l0 - 8, l0 + 9);
  const lineStart = w.offset(l0, 0);
  const lineEnd = lineStart + lines[l0].length;
  const col = lineStart + Math.min(column, lines[l0].length);
  const t = w.tokens;
  let index = -1;
  let count = 1;
  if (Number.isInteger(end) && /** @type {number} */ (end) > column) {
    const to = lineStart + Math.min(/** @type {number} */ (end), lines[l0].length);
    const hit = t.map((x, i) => (x.start < to && x.end > col ? i : -1)).filter((i) => i >= 0);
    if (hit.length) {
      index = hit[0];
      count = hit[hit.length - 1] - hit[0] + 1;
    }
  } else {
    index = t.findIndex((x) => x.start <= col && col < x.end);
    if (index < 0) index = t.findIndex((x) => x.end === col);
    if (index < 0) index = t.findIndex((x) => x.start >= col && x.start < lineEnd);
    if (index < 0) {
      for (let i = t.length - 1; i >= 0; i--) {
        if (t[i].end <= col && t[i].end > lineStart) {
          index = i;
          break;
        }
      }
    }
  }
  if (index < 0) return null;
  const a = anchorOf(t, index, count);
  return validAnchor(a) ? a : null;
}

/**
 * The first line (0-based) of the macro arguments that close on line `l0`: TeX reads an
 * argument whole, so its text carries the line it ends on. `l0` if none opens earlier;
 * at most `max` lines up.
 * @param {string[]} lines @param {number} l0 @param {number} max
 */
function argumentStart(lines, l0, max) {
  /** @type {number[]} the lines of the closing braces not matched yet */
  const open = [];
  let first = l0;
  for (let l = l0; l >= Math.max(0, l0 - max); l--) {
    const s = lines[l].replace(/(^|[^\\])%.*/, "$1");
    for (let k = s.length - 1; k >= 0; k--) {
      const c = s[k];
      if ((c !== "{" && c !== "}") || s[k - 1] === "\\") continue;
      if (c === "}") open.push(l);
      else if (!open.length) return first; // l0 is inside this group, not at its end
      else if (open.pop() === l0) first = l;
    }
    if (l < l0 && !open.includes(l0)) return first;
  }
  return first;
}

/**
 * Inverse search to the word: the anchor (from the PDF) in the source around `line`
 * (1-based, SyncTeX's answer), on that line or within `above` lines before and `below`
 * after it, the line SyncTeX named with a bonus of `bonus` context words. Found nowhere
 * there: in the rest of the macro arguments that end on the line (a caption, a footnote,
 * up to `reach` lines up). Null when not confident.
 * @param {string[]} lines @param {number} line @param {Anchor} anchor
 * @param {{above?: number, below?: number, bonus?: number, reach?: number}} [opts]
 * @returns {{line: number, column: number, end: number} | null} line 1-based, columns 0-based
 */
export function findInSource(lines, line, anchor, { above = 5, below = 2, bonus = 2, reach = 60 } = {}) {
  const l0 = line - 1;
  if (l0 < 0 || l0 >= lines.length || !validAnchor(anchor)) return null;
  const lastLine = Math.min(lines.length - 1, l0 + below);
  const from = Math.min(Math.max(0, l0 - above), argumentStart(lines, l0, reach));
  const w = sourceWindow(lines, from - 4, lastLine + 5);
  const lo = w.offset(Math.max(0, l0 - above), 0);
  const hi = w.offset(lastLine, lines[lastLine].length);
  const own = [w.offset(l0, 0), w.offset(l0, lines[l0].length)];
  let r = rank(w.tokens, anchor, (i) => {
    const s = w.tokens[i].start;
    if (s < lo || s > hi) return null;
    return s >= own[0] && s <= own[1] ? bonus : 0;
  });
  if (!r.best && from < l0 - above) {
    const top = w.offset(from, 0);
    r = rank(w.tokens, anchor, (i) => (w.tokens[i].start >= top && w.tokens[i].start < lo ? 0 : null));
  }
  if (!r.best || r.tie) return null;
  const hit = r.best;
  const first = w.where(w.tokens[hit.index].start);
  const last = w.where(w.tokens[hit.index + hit.count - 1].end);
  return { line: first.line + 1, column: first.column, end: last.line === first.line ? last.column : lines[first.line].length };
}
