// Runs every cdp_*.mjs test in this folder in sequence, each against its own dev app on the isolated
// profile (--fresh): the tests were written for a window that has just started. Working on a single
// test instead reuses one shared app, see run_cdp.mjs.
// For milestones. The tests print results next to their "expect" notes rather than asserting, so read
// the output. A test that crashes is listed at the end.
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const failed = [];
for (const file of fs.readdirSync(dir).filter(f => /^cdp_.*\.mjs$/.test(f)).sort()) {
	console.log(`\n=== ${file} ===`);
	const result = spawnSync(process.execPath, [path.join(dir, 'run_cdp.mjs'), path.join(dir, file), '--isolated', '--fresh'], { cwd: dir, stdio: 'inherit' });
	if (result.status !== 0) failed.push(file);
}
console.log(failed.length ? `\nCrashed: ${failed.join(', ')}` : '\nAll tests ran. Compare each result with its expect note.');
process.exit(failed.length ? 1 : 0);
