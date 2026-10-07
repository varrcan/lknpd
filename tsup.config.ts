import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    // tsup 8 сам выставляет baseUrl при сборке .d.ts, а TS 6 считает его устаревшим.
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    sourcemap: true,
    clean: true,
    target: 'es2022',
    platform: 'neutral',
    esbuildOptions(options) {
        options.charset = 'utf8';
    },
});
