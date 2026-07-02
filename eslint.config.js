import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist', 'dev-dist', 'node_modules', '.wrangler'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Die React-Compiler-orientierten Regeln (v6) melden hier etablierte, funktionierende
      // Muster (async laden im Effect + setState, Ref-Lesen für Drag-Styles). Ohne
      // Suspense/Compiler-Umbau sind das Fehlalarme — die klassischen Regeln
      // (rules-of-hooks, exhaustive-deps) bleiben als Fehler aktiv.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/purity': 'off',
    },
  },
);
