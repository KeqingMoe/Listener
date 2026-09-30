/**
 * 为只关心策略的fixture补上必需的合成模型 [models.main]，不改动其原有的表、值或故意写错的语法。
 * 已有 [models.main] 时只补缺失的 model 与 api_key_env。模型校验测试应直接写出自己的输入。此helper从不读取密钥。
 */
export function withFixtureModel(source: string): string {
  const header = /^\[models\.main\][ \t]*(?:#[^\n]*)?$/m;
  const section =
    /^\[models\.main\][ \t]*(?:#[^\n]*)?$(?:\n([\s\S]*?))?(?=^\[|(?![\s\S]))/m;
  const match = section.exec(source);
  if (match) {
    const body = match[1] ?? '';
    const missing = [
      /^model\s*=/m.test(body) ? '' : '\nmodel = "fixture-model"',
      /^api_key_env\s*=/m.test(body) ? '' : '\napi_key_env = "OPENAI_API_KEY"',
    ].join('');
    return missing ? source.replace(header, `$&${missing}`) : source;
  }
  // 其他写法的模型定义有意留给loader处理。
  if (/^(\[models[.\]]|models\s*[.=])/m.test(source)) {
    return source;
  }
  return `${source}\n[models.main]\nmodel = "fixture-model"\napi_key_env = "OPENAI_API_KEY"\n`;
}
