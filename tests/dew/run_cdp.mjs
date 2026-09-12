// Usage: node tests/dew/run_cdp.mjs <test.mjs> [--isolated] [--fresh]
//        node tests/dew/run_cdp.mjs --stop
// Working on one test reuses one dev app: if the debugging port already answers the test runs against the app
// that is up, and it is left running afterwards, so a window is not reopened every run. --stop closes it.
// --fresh is what run_all uses: its own app for the test, closed afterwards. The suite's tests were written
// for a window that has just started, and sharing one left a few of them reading stale camera and UV state,
// so the suite keeps the old behaviour. A --fresh run closes a shared app first, since there is one port.
// Build first (npm run build-electron). --isolated uses a separate profile, needed whenever the packaged
// Blockbench is open: its single instance lock makes the dev app quit right after boot. A shared app records
// which profile it booted with and is restarted when a run asks for the other one, so probe_keymap still
// reads the user's own keymap.
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const mode_file = path.join(here, '.dev_app_mode');
const args = process.argv.slice(2);
const test = args.find(arg => !arg.startsWith('--'));
const mode = args.includes('--isolated') ? 'isolated' : 'profile';
const fresh = args.includes('--fresh');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const endpoint = 'http://127.0.0.1:9223/json';
const alive = async () => { try { await (await fetch(endpoint)).json(); return true; } catch { return false; } };
const kill = () => {
	try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch {}
	try { fs.unlinkSync(mode_file); } catch {}
};

if (args.includes('--stop')) {
	kill();
	console.log('dev app closed');
	process.exit(0);
}
if (!test) { console.error('missing test script'); process.exit(1); }

async function start() {
	const electron = spawn(path.join(root, 'node_modules/.bin/electron.cmd'), [
		'--remote-debugging-port=9223',
		// A window sitting behind the terminal is otherwise treated as occluded and stops producing frames,
		// which leaves Page.captureScreenshot at the end of a test waiting a minute or more for one
		'--disable-backgrounding-occluded-windows',
		'--disable-renderer-backgrounding',
		'--disable-background-timer-throttling',
		...(mode == 'isolated' ? ['--user-data-dir=' + path.join(root, '../_electron_test_userdata')] : []),
		'.',
	], { cwd: root, detached: true, stdio: 'ignore', shell: true });
	electron.unref();
	for (let i = 0; i < 60; i++) {
		if (await alive()) { await sleep(4000); return true; }  // let the renderer finish booting
		await sleep(500);
	}
	console.error('Electron debugging port never came up');
	process.exit(1);
}

async function cdp(method, params = {}) {
	const targets = await (await fetch(endpoint)).json();
	const page = targets.find(t => t.type == 'page' && t.url.includes('index.html')) ?? targets.find(t => t.type == 'page');
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
	const answer = await new Promise(resolve => {
		ws.onmessage = e => { const message = JSON.parse(e.data); if (message.id == 1) resolve(message); };
		ws.send(JSON.stringify({ id: 1, method, params }));
	});
	ws.close();
	return answer;
}
async function evaluate(expression) {
	let answer = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
	return answer.result;
}

const booted = async () => await evaluate('typeof Blockbench != "undefined" && !!window.Preview && Preview.all.length > 0').then(r => r?.result?.value).catch(() => false);
// A running app keeps the bundle it started with, so a build since then has to be loaded before the test runs
async function reloadIfStale() {
	let bundle = path.join(root, 'dist/bundle.js');
	let built = fs.existsSync(bundle) ? fs.statSync(bundle).mtimeMs : 0;
	// The page knows when it loaded, which beats bookkeeping in a file that can drift out of step
	let loaded = await evaluate('performance.timeOrigin').then(r => r?.result?.value).catch(() => 0);
	if (!built || !loaded || built <= loaded) return;
	console.log('note: the bundle was rebuilt since this app loaded it, reloading');
	// Ignoring the cache, or the reload hands back the same file:// bundle the app already had
	await cdp('Page.reload', { ignoreCache: true }).catch(() => {});
	await sleep(1500);
	for (let i = 0; i < 60; i++) { if (await booted()) break; await sleep(500); }
	await sleep(1500);  // the renderer finishes setting itself up after that flag goes true
}

// Whatever the last test left behind, so a shared app starts one looking like a fresh one
async function reset() {
	const targets = await (await fetch(endpoint)).json();
	const page = targets.find(t => t.type == 'page' && t.url.includes('index.html')) ?? targets.find(t => t.type == 'page');
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
	const answer = await new Promise(resolve => {
		ws.onmessage = e => { const message = JSON.parse(e.data); if (message.id == 1) resolve(message); };
		ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
			expression: `(async () => {
				if (typeof Dialog != 'undefined' && Dialog.open) Dialog.open.cancel();
				if (typeof Project != 'undefined' && Project && BarItems.move_tool) BarItems.move_tool.select();
				// The view carries over as well, and a test that drags across the screen picks whatever is under
				// the path, so every run starts from the same camera
				let preview = typeof Preview != 'undefined' && Preview.selected;
				if (preview && preview.controls) {
					preview.controls.target.set(0, 0, 0);
					preview.camera.position.set(-40, 40, 80);
					preview.controls.update();
					if (preview.render) preview.render();
				}
				if (typeof DEWTileBrush != 'undefined') {
					Object.assign(DEWTileBrush.state, {axis: 'y', depth: 0, size: (typeof DEW != 'undefined' ? DEW.TILE : 32), sign: null, edge_flip: false, hover_point: null});
					DEWTileBrush.texture_state.atlas = null;
				}
				// Saved, so closing cannot stop on a save prompt
				for (let project of ModelProject.all.slice()) { project.saved = true; await project.close(true); }
				let left = ModelProject.all.length;
				// Never leave the app with no project: the UV editor keeps rendering the elements of the one
				// that just went and throws out of getSelectedFaces
				if (!left) newProject(Formats.free);
				return left;
			})()`,
			awaitPromise: true, returnByValue: true,
		}}));
	});
	ws.close();
	if (answer.result?.exceptionDetails) console.log('note: reset failed:', answer.result.exceptionDetails.exception?.description ?? answer.result.exceptionDetails.text);
	else if (answer.result?.result?.value) console.log(`note: ${answer.result.result.value} project(s) would not close`);
}

if (fresh) {
	kill();
	await sleep(800);
	await start();
} else {
	let running = await alive();
	if (running) {
		// An app booted on the other profile would read the wrong settings and keymap
		let booted = fs.existsSync(mode_file) ? fs.readFileSync(mode_file, 'utf8').trim() : null;
		if (booted !== mode) {
			console.log(`dev app was on the ${booted ?? 'unknown'} profile, restarting it on ${mode}`);
			kill();
			await sleep(1200);
			running = false;
		}
	}
	if (!running) {
		await start();
		fs.writeFileSync(mode_file, mode);
		console.log(`dev app started on the ${mode} profile, left running (npm run test:dew:stop closes it)`);
	}
	await reloadIfStale();
	await reset();
	await sleep(400); // settle before the test starts listening for page errors
}

let code = 0;
const test_path = path.resolve(test);
process.chdir(path.dirname(test_path)); // tests write their screenshots next to themselves
try { await import(pathToFileURL(test_path).href); }
catch (e) { console.error(e); code = 1; }
if (fresh) kill();
process.exit(code);
