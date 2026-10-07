// node --env-file=.env scripts/live/e2e.cjs  (после pnpm build)
const lib = require('../../dist/index.cjs');
const scenario = require('./e2e-scenario.cjs');

void scenario(lib, 'cjs');
