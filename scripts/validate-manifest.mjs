// Offline manifest schema check using the Forge CLI's own validator (no login needed).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const root = execSync('npm root -g').toString().trim();
const require = createRequire(import.meta.url);
const m = require(`${root}/@forge/cli/node_modules/@forge/manifest`);
const r = await m.validate(false, new URL('../manifest.yml', import.meta.url).pathname);
if (!r.success) { for (const e of r.errors ?? []) console.error('✗', e.message); process.exit(1); }
console.log('✓ manifest.yml is valid');
