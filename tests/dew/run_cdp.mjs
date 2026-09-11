// Usage: node tests/dew/run_cdp.mjs <test.mjs> [--isolated]
// Launches the dev Electron app with remote debugging on port 9223, runs the test script against it, then kills Electron.
// Build first (npm run build-electron). --isolated uses a separate profile, needed whenever the packaged Blockbench
// is open: its single-instance lock makes the dev app quit right after boot.
import { spawn, execSync } from 'child_process';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const test = process.argv[2];
if (!test) { console.error('missing test script'); process.exit(1); }

const electron = spawn(path.join(root, 'node_modules/.bin/electron.cmd'), ['--remote-debugging-port=9223', ...(process.argv.includes('--isolated') ? ['--user-data-dir=' + path.join(root, '../_electron_test_userdata')] : []), '.'], {
	cwd: root, detached: true, stdio: 'ignore', shell: true,
});
electron.unref();

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ready = false;
for (let i = 0; i < 60; i++) {
	try { await (await fetch('http://127.0.0.1:9223/json')).json(); ready = true; break; } catch {}
	await sleep(500);
}
let code = 0;
if (!ready) { console.error('Electron debugging port never came up'); code = 1; }
else {
	await sleep(4000); // let the renderer finish booting
	// Tests write their screenshots next to themselves
	const test_path = path.resolve(test);
	process.chdir(path.dirname(test_path));
	try { await import(pathToFileURL(test_path).href); }
	catch (e) { console.error(e); code = 1; }
}
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch {}
process.exit(code);
