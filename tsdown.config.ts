/**
 * tsdown build for dsh-context-window.
 *
 * Host-half only, deliberately: this plugin contributes no browser bundle in
 * v0. lib/index.js is a plain ESM Node bundle whose only externals are the
 * DSH/cordis peers the profile composition already provides (importing them
 * from a bundle would duplicate the service registry).
 *
 * Types ship from lib/types (tsc -p tsconfig.build.json), not from tsdown, so
 * the declaration surface stays a straight projection of src/.
 */
import type { UserConfig } from 'tsdown'

export default {
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: false,
  clean: false,
  sourcemap: false,
  /** DSH resolves `lib/index.js` through the package exports, not `.mjs`. */
  outExtensions: () => ({ js: '.js' }),
  deps: { neverBundle: [/^@deepseek-ai\//, /^node:/] },
} satisfies UserConfig
