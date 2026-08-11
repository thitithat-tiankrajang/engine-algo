// The `lint` script has always been in package.json and the dependencies have
// always been installed; the config was the missing piece, so `npm run lint`
// failed to start rather than reporting anything. This is the smallest config
// that makes it run against the code as it stands.
//
// Syntactic rules only, deliberately. The type-aware set is the more valuable
// one here — floating promises around child processes are exactly the class of
// bug this service can afford least — but turning it on today reports several
// dozen findings across files this change does not touch, and fixing those is a
// separate piece of work with its own review. Adopting it is worth doing; doing
// it inside an unrelated change is not.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  // TypeScript already resolves every identifier, so this set turns `no-undef`
  // off rather than needing a globals list for `process`, `setTimeout` and the
  // rest.
  ...tseslint.configs.recommended,
);
