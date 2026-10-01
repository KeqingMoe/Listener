export interface CodeToken {
  kind: 'keyword' | 'string' | 'number' | 'comment' | 'literal' | 'text';
  text: string;
}

const KEYWORDS = new Set(
  'async await break case catch class const continue default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield'.split(
    ' ',
  ),
);
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN']);

// 依次匹配：注释、字符串（含模板字符串整体）、数字、标识符；其余字符原样输出。
const TOKEN =
  /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|`(?:\\[\s\S]|[^\\`])*(?:`|$)|'(?:\\.|[^\\'\n])*'?|"(?:\\.|[^\\"\n])*"?|\b(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)n?\b|[A-Za-z_$][\w$]*/g;

/**
 * 只读展示用的轻量JavaScript着色：不做完整语法分析，正则字面量与模板插值不单独区分。
 * 拼接所有片段的文本总是等于原代码。
 */
export function highlightJs(code: string): CodeToken[] {
  const out: CodeToken[] = [];
  const push = (kind: CodeToken['kind'], text: string) => {
    const last = out.at(-1);
    if (last?.kind === kind) {
      last.text += text;
    } else {
      out.push({ kind, text });
    }
  };
  let index = 0;
  for (const match of code.matchAll(TOKEN)) {
    const text = match[0];
    if (match.index > index) {
      push('text', code.slice(index, match.index));
    }
    const first = text[0]!;
    push(
      first === '/'
        ? 'comment'
        : first === '`' || first === '"' || first === "'"
          ? 'string'
          : /\d/.test(first)
            ? 'number'
            : KEYWORDS.has(text)
              ? 'keyword'
              : LITERALS.has(text)
                ? 'literal'
                : 'text',
      text,
    );
    index = match.index + text.length;
  }
  if (index < code.length) {
    push('text', code.slice(index));
  }
  return out;
}
