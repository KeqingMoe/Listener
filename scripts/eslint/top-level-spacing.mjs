// 只检查文件顶层：import块之后、以及声明块（函数、类、interface、type、enum、
// 顶层test/describe）与相邻语句之间，只要其中一方跨多行就必须空一行。
// 函数内部不做要求。

const DECLARATIONS = new Set([
  'FunctionDeclaration',
  'ClassDeclaration',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSEnumDeclaration',
  'TSModuleDeclaration',
  'TSDeclareFunction',
]);

function unwrap(node) {
  if (
    (node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportDefaultDeclaration') &&
    node.declaration
  ) {
    return node.declaration;
  }
  return node;
}

function isTestCall(node) {
  if (node.type !== 'ExpressionStatement') {
    return false;
  }
  let callee =
    node.expression.type === 'AwaitExpression'
      ? node.expression.argument?.callee
      : node.expression.callee;
  while (callee?.type === 'MemberExpression') {
    callee = callee.object;
  }
  return callee?.type === 'Identifier' && /^(test|describe)$/.test(callee.name);
}

function isBlock(node) {
  const inner = unwrap(node);
  return DECLARATIONS.has(inner.type) || isTestCall(inner);
}

export const topLevelSpacing = {
  meta: {
    type: 'layout',
    fixable: 'whitespace',
    messages: { missing: '顶层声明前后需要空一行。' },
    schema: [],
  },
  create(context) {
    const source = context.sourceCode;
    const multiline = (node) => node.loc.start.line !== node.loc.end.line;
    return {
      Program(program) {
        const body = program.body;
        for (let i = 1; i < body.length; i++) {
          const prev = body[i - 1];
          const next = body[i];
          const afterImports =
            prev.type === 'ImportDeclaration' &&
            next.type !== 'ImportDeclaration';
          const aroundBlock =
            (isBlock(prev) || isBlock(next)) &&
            (multiline(prev) || multiline(next));
          if (!afterImports && !aroundBlock) {
            continue;
          }
          // 同行尾注释属于前一条语句；下一条语句的前导注释算作它的开头。
          let end = source.getLastToken(prev);
          const trailing = source
            .getCommentsAfter(end)
            .filter((c) => c.loc.start.line === end.loc.end.line);
          if (trailing.length) {
            end = trailing[trailing.length - 1];
          }
          const leading = source
            .getCommentsBefore(next)
            .filter((c) => c.range[0] > end.range[1]);
          const start = leading[0] ?? source.getFirstToken(next);
          if (start.loc.start.line - end.loc.end.line >= 2) {
            continue;
          }
          context.report({
            node: next,
            messageId: 'missing',
            fix: (fixer) => fixer.insertTextAfter(end, '\n'),
          });
        }
      },
    };
  },
};

export const localPlugin = { rules: { 'top-level-spacing': topLevelSpacing } };
