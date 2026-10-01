export interface JsonToken {
  kind: 'key' | 'string' | 'text' | 'number' | 'literal' | 'punct';
  text: string;
}

/**
 * 把值格式化为带语法类别的JSON片段，供只读展示。多行字符串不转义换行，
 * 以续行缩进展示为`text`，因此展示结果不是合法JSON；复制仍使用标准JSON原文。
 */
export function highlightJson(value: unknown, maxDepth = 64): JsonToken[] {
  const out: JsonToken[] = [];
  const push = (kind: JsonToken['kind'], text: string) => {
    const last = out.at(-1);
    if (last?.kind === kind) {
      last.text += text;
    } else {
      out.push({ kind, text });
    }
  };
  const string = (s: string, indent: string) => {
    if (!s.includes('\n')) {
      push('string', JSON.stringify(s));
      return;
    }
    const body = JSON.stringify(s).slice(1, -1).split('\\n');
    push('punct', '"');
    push('text', body.join(`\n${indent}  `));
    push('punct', '"');
  };
  const walk = (v: unknown, indent: string, depth: number) => {
    if (v === null || typeof v === 'boolean') {
      push('literal', String(v));
    } else if (typeof v === 'number') {
      push('number', Number.isFinite(v) ? String(v) : 'null');
    } else if (typeof v === 'string') {
      string(v, indent);
    } else if (typeof v !== 'object') {
      push('literal', 'null');
    } else if (depth >= maxDepth) {
      push('punct', '[嵌套过深]');
    } else {
      const array = Array.isArray(v);
      const entries = array
        ? (v as unknown[]).map((item) => [null, item] as const)
        : Object.entries(v as Record<string, unknown>);
      const [open, close] = array ? ['[', ']'] : ['{', '}'];
      if (!entries.length) {
        push('punct', open + close);
        return;
      }
      const inner = `${indent}  `;
      push('punct', `${open}\n`);
      entries.forEach(([key, item], index) => {
        push('punct', inner);
        if (key !== null) {
          push('key', JSON.stringify(key));
          push('punct', ': ');
        }
        walk(item, inner, depth + 1);
        push('punct', index < entries.length - 1 ? ',\n' : '\n');
      });
      push('punct', indent + close);
    }
  };
  walk(value, '', 0);
  return out;
}
