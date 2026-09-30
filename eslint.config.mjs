// ESLint只管代码规范，排版交给Prettier。
// eslint-config-prettier需放在自定义规则之前，否则会关掉下面重新启用的curly。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import stylistic from '@stylistic/eslint-plugin';
import { localPlugin } from './scripts/eslint/top-level-spacing.mjs';

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      'dist/',
      'coverage/',
      'data/',
      'prompts/',
      'artifacts/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  prettier,
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
      globals: globals.browser,
    },
  },
  {
    files: ['src/dashboard/web/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.{ts,mts,mjs}'],
    ignores: ['src/dashboard/web/src/**'],
    languageOptions: { globals: globals.node },
  },
  {
    // 空行：Prettier只保留不新增，由这里补齐。函数内部不强制。
    plugins: { '@stylistic': stylistic, local: localPlugin },
    rules: {
      'local/top-level-spacing': 'error',
      '@stylistic/lines-between-class-members': [
        'error',
        'always',
        { exceptAfterSingleLine: true },
      ],
    },
  },
  {
    rules: {
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // 先声明、在闭包读取之后才赋值的变量保留let。
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      'no-throw-literal': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 控制字符正则用于过滤输入，是有意为之。
      'no-control-regex': 'off',
      // 部分错误有意不携带原始异常，避免泄露路径或内部细节。
      'preserve-caught-error': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports', disallowTypeAnnotations: false },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowTernary: true, allowShortCircuit: true },
      ],
      // 用TypeScript声明可选prop，不强制默认值。
      'vue/require-default-prop': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: '使用具名导出，不用default export。',
        },
        {
          selector: 'ThrowStatement > CallExpression[callee.name=/Error$/]',
          message: '抛错写成 throw new Error(...)。',
        },
      ],
    },
  },
  {
    // 工具配置文件按约定需要default export。
    files: ['*.config.{ts,mjs}', 'src/dashboard/web/vite.config.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // 测试用any构造非法输入与替身对象。
    files: ['tests/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
