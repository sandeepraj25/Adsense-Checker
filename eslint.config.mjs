// ESLint flat config. The installed eslint-config-next (16.x) ships flat
// configs only, so the old .eslintrc.json ("extends": ["next/..."]) could
// no longer load ("Converting circular structure to JSON").
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // eslint-plugin-react-hooks 7 (bundled with eslint-config-next 16)
    // adds React Compiler rules. This app does not use the compiler; its
    // server components read the clock per request, and its effects sync
    // with the browser on purpose. Reported, not failed.
    rules: {
      "react-hooks/purity": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
    },
  },
  {
    ignores: [".next/**", "node_modules/**", "data/**", "next-env.d.ts", "public/**"],
  },
];

export default config;
