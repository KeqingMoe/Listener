/** Supply a synthetic required model to policy-only fixtures without changing
 * their original tables, values, or malformed syntax. Model validation tests
 * should write their input directly instead. This helper never reads secrets. */
export function withFixtureModel(source: string): string {
  const section = /^\[model\][ \t]*(?:#[^\n]*)?$(?:\n([\s\S]*?))?(?=^\[|(?![\s\S]))/m;
  const match = section.exec(source);
  if (match) {
    if (/^model\s*=/m.test(match[1] ?? '')) return source;
    return source.replace(/^\[model\][ \t]*(?:#[^\n]*)?$/m, '$&\nmodel = "fixture-model"');
  }
  // Root model values/dotted definitions are deliberately left to the loader.
  if (/^model\s*[.=]/m.test(source)) return source;
  return `${source}\n[model]\nmodel = "fixture-model"\n`;
}
