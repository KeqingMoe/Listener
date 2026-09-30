/**
 * 为只关心策略的fixture补上必需的合成model，不改动其原有的表、值或故意写错的语法。
 * 模型校验测试应直接写出自己的输入。此helper从不读取密钥。
 */
export function withFixtureModel(source: string): string {
  const section =
    /^\[model\][ \t]*(?:#[^\n]*)?$(?:\n([\s\S]*?))?(?=^\[|(?![\s\S]))/m;
  const match = section.exec(source);
  if (match) {
    if (/^model\s*=/m.test(match[1] ?? '')) {
      return source;
    }
    return source.replace(
      /^\[model\][ \t]*(?:#[^\n]*)?$/m,
      '$&\nmodel = "fixture-model"',
    );
  }
  // 根级model值或点号形式的定义有意留给loader处理。
  if (/^model\s*[.=]/m.test(source)) {
    return source;
  }
  return `${source}\n[model]\nmodel = "fixture-model"\n`;
}
