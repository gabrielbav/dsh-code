/**
 * In-container file helper bundle: one self-contained ES module for Node 24
 * with every dependency inlined, copied into the worker image at
 * `/opt/dsh-code/fs-helper.js`.
 */
import { defineConfig } from 'tsdown'

/** A bundled module reading its own `package.json` at load time would fail in the image; inline the version. */
const PACKAGE_JSON_READ = /createRequire\(import\.meta\.url\)\(["']\.\.\/package\.json["']\)/g

export default defineConfig({
  name: '@gabrielbav/dsh-code/fs-helper',
  entry: { 'fs-helper': 'src/worker/fs-helper.ts', 'browser-bridge': 'src/worker/browser-bridge.ts' },
  outDir: 'worker',
  outExtensions: () => ({ js: '.js' }),
  format: 'esm',
  platform: 'node',
  target: 'node24',
  dts: false,
  sourcemap: false,
  clean: false,
  minify: false,
  // Windows-only native binding, loaded lazily by the local backend; never reached on Linux.
  deps: { neverBundle: (id: string) => id === 'koffi', alwaysBundle: (id: string) => id !== 'koffi' },
  plugins: [{
    name: 'dsh-code:inline-package-json',
    transform(code: string) {
      const next = code.replace(PACKAGE_JSON_READ, '({ version: "bundled" })')
      return next === code ? null : next
    },
  }],
})
