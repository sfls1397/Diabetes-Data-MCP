import tseslint from 'typescript-eslint';

const typed = process.env.LINT_TYPED === '1';

const core = {
  'array-callback-return': 'error',
  'for-direction': 'error',
  'getter-return': 'error',
  'no-async-promise-executor': 'error',
  'no-class-assign': 'error',
  'no-compare-neg-zero': 'error',
  'no-cond-assign': 'error',
  'no-const-assign': 'error',
  'no-constant-binary-expression': 'error',
  'no-constant-condition': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-dupe-else-if': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-empty-character-class': 'error',
  'no-empty-pattern': 'error',
  'no-ex-assign': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-invalid-regexp': 'error',
  'no-loss-of-precision': 'error',
  'no-misleading-character-class': 'error',
  'no-new-native-nonconstructor': 'error',
  'no-obj-calls': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-setter-return': 'error',
  'no-shadow-restricted-names': 'error',
  'no-this-before-super': 'error',
  'no-unreachable': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-unused-private-class-members': 'error',
  'no-useless-backreference': 'error',
  'require-yield': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
};

const typeAware = {
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/no-array-delete': 'error',
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-for-in-array': 'error',
  '@typescript-eslint/no-implied-eval': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/no-unsafe-unary-minus': 'error',
  '@typescript-eslint/only-throw-error': 'error',
  '@typescript-eslint/prefer-promise-reject-errors': 'error',
  '@typescript-eslint/restrict-plus-operands': 'error',
  '@typescript-eslint/unbound-method': 'error',
};

const syntax = {
  '@typescript-eslint/no-duplicate-enum-values': 'error',
  '@typescript-eslint/no-extra-non-null-assertion': 'error',
  '@typescript-eslint/no-misused-new': 'error',
  '@typescript-eslint/no-non-null-asserted-nullish-coalescing': 'error',
  '@typescript-eslint/no-non-null-asserted-optional-chain': 'error',
  '@typescript-eslint/no-unsafe-declaration-merging': 'error',
  '@typescript-eslint/no-unsafe-function-type': 'error',
  '@typescript-eslint/no-wrapper-object-types': 'error',
};

const compat = ['nightscout/compat/**'];
const files = ['**/*.ts', '**/*.mts', '**/*.cts', '**/*.js', '**/*.mjs', '**/*.cjs'];

export default [
  { ignores: ['dist/**', 'node_modules/**', '.lint/node_modules/**'] },
  {
    files,
    ignores: typed ? compat : [],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: typed ? { project: ['.lint/tsconfig.json'], tsconfigRootDir: process.cwd() } : {},
    },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: { ...core, ...syntax, ...(typed ? typeAware : {}) },
  },
  {
    files: compat,
    languageOptions: { parser: tseslint.parser },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: { ...core, ...syntax },
  },
];
