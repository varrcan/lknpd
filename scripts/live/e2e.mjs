// node --env-file=.env scripts/live/e2e.mjs  (после pnpm build)
import * as lib from '../../dist/index.js';
import scenario from './e2e-scenario.cjs';

await scenario(lib, 'esm');
