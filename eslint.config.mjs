import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // A LEADING UNDERSCORE IS THE "DELIBERATELY UNUSED" MARKER, and this repo
    // uses it for one specific structural reason: every gate check is wired in
    // `lib/gate/runGate.ts` with the SAME `(listing, pack)` call shape, so the
    // forty-one `guarded(...)` rows read as one table. A check that happens not
    // to need the pack (`c20Structure`) still takes it, named `_pack`, rather
    // than becoming the one row in that table with a different arity.
    //
    // This narrows the rule to that convention only: an unused binding WITHOUT
    // the underscore is still an error/warning exactly as before, so nothing is
    // hidden that was not explicitly marked.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
]);

export default eslintConfig;
