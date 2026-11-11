/**
 * Browser bundle for the Code plugin, in the DeepSeek Harness client module
 * format: one CommonJS factory registered through
 * `window.__ModuleLoader__.load({ id, factory })`, whose `require` resolves
 * the Harness platform modules. Everything else is bundled.
 */
import { defineConfig } from 'tsdown'
import manifest from './package.json' with { type: 'json' }

/** Modules the Harness Web shell provides to every plugin bundle. */
const PLATFORM = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
])

export default defineConfig({
  name: `${manifest.name}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  outExtensions: () => ({ js: '.js' }),
  format: 'cjs',
  platform: 'browser',
  inputOptions: { platform: 'browser' },
  dts: false,
  sourcemap: true,
  clean: false,
  minify: false,
  deps: { neverBundle: (id: string) => PLATFORM.has(id), alwaysBundle: (id: string) => !PLATFORM.has(id) },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  outputOptions: {
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
