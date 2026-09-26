// The weight brush paints exactly as stock, without the crawl. On the user's cat (cat_common.bbmodel, skipped without
// it): the same real stroke painted with the fast path and with the stock path (WEIGHT_PERF.FAST_STROKE false, the
// control) leaves identical weights on every bone; mid-stroke the in-place colours equal a full rebuild's; after release
// the colours are the rebuild's; the press, each move and the release stay quick; undo puts every weight back.
import assert from 'assert';
import fs from 'fs';
const FILE = 'D:/Work/CatWhisperer/models_working/cat_common.bbmodel';
const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find(t => t.type == 'page' && t.url.includes('index.html')) ?? targets.find(t => t.type == 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.method == 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text); return r.result.result.value; };
const json = async (expr) => JSON.parse(await ev(expr));
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { if (await ev('typeof Blockbench != "undefined" && !!window.Preview && Preview.all.length > 0')) break; await sleep(500); }
await send('Runtime.enable');
let passed = 0;
const check = (name, ok, detail) => { assert.ok(ok, name + (detail !== undefined ? ': ' + JSON.stringify(detail) : '')); console.log('PASS', name); passed++; };
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });

if (!fs.existsSync(FILE)) {
	console.log('SKIP: ' + FILE + ' not found');
} else {
	await ev(`(() => { loadModelFile({content: ${JSON.stringify(fs.readFileSync(FILE, 'utf8'))}, path: ${JSON.stringify(FILE)}}); return true; })()`);
	await sleep(5000);
	const s = await json(`(() => {
		Modes.options.edit.select();
		window.body = Mesh.all.find(m => m.name == 'body');
		let bone = ArmatureBone.all.find(b => b.name == 'spine_2');
		unselectAllElements(); bone.select(); updateSelection();
		BarItems.weight_brush.select();
		let p = Preview.selected; p.setProjectionMode(false); p.camera.position.set(90, 45, 10); p.controls.target.set(0, 38, -8); p.controls.update(); p.render();
		window.weights = () => JSON.stringify(ArmatureBone.all.map(b => [b.name, Object.entries(b.vertex_weights || {}).sort()]));	// flat, keyed 'meshuuid6:vkey'
		window.start_weights = weights();
		let r = p.canvas.getBoundingClientRect(), q = body.getWorldCenter().project(p.camera);
		return JSON.stringify({x: r.left + (q.x + 1) / 2 * r.width, y: r.top + (1 - q.y) / 2 * r.height});
	})()`);
	// one stroke: press, 30 moves, a pause mid-stroke for a look, release; returns the wall times
	const stroke = async (look) => {
		await mouse('mouseMoved', s.x - 100, s.y, { button: 'none' }); await sleep(100);
		let t = Date.now(); await mouse('mousePressed', s.x - 100, s.y, { buttons: 1 }); let press = Date.now() - t;
		let moves = [], seen = null;
		for (let i = 1; i <= 30; i++) { t = Date.now(); await mouse('mouseMoved', s.x - 100 + i * 7, s.y + Math.sin(i / 3) * 18, { buttons: 1 }); moves.push(Date.now() - t); if (i == 20 && look) seen = await json(look); }
		t = Date.now(); await mouse('mouseReleased', s.x + 110, s.y); let release = Date.now() - t;
		await sleep(200); moves.sort((a, b) => a - b);
		return {press, median: moves[15], worst: moves[29], release, seen};
	};
	// mid-stroke: the colours now in the buffer, against a full stock rebuild of the same state
	const look = `(() => { let before = Array.from(body.mesh.geometry.attributes.color.array); Mesh.preview_controller.updateGeometry(body); let after = Array.from(body.mesh.geometry.attributes.color.array);
		let diff = 0; for (let i = 0; i < before.length; i++) diff = Math.max(diff, Math.abs(before[i] - after[i])); return JSON.stringify({slots: before.length / 3, same_length: before.length == after.length, max_diff: diff}); })()`;

	let fast = await stroke(look);
	let fast_weights = await ev(`weights()`);
	let after_release = await json(`(() => { let now = Array.from(body.mesh.geometry.attributes.color.array); Mesh.preview_controller.updateGeometry(body); let rebuilt = Array.from(body.mesh.geometry.attributes.color.array); let d = 0; for (let i = 0; i < now.length; i++) d = Math.max(d, Math.abs(now[i] - rebuilt[i])); return JSON.stringify({max_diff: d}); })()`);
	let undo = await json(`(() => { Undo.undo(); let back = weights() == start_weights; Undo.redo(); let again = weights() == ${JSON.stringify(fast_weights)}; Undo.undo(); return JSON.stringify({back, again, restored: weights() == start_weights}); })()`);
	await ev(`(() => { DEWWeightPerf.WEIGHT_PERF.FAST_STROKE = false; return true; })()`);
	let stock = await stroke(null);
	let stock_weights = await ev(`weights()`);
	await ev(`(() => { DEWWeightPerf.WEIGHT_PERF.FAST_STROKE = true; Undo.undo(); return true; })()`);
	console.log('   fast ', JSON.stringify({press: fast.press, median: fast.median, worst: fast.worst, release: fast.release}));
	console.log('   stock', JSON.stringify({press: stock.press, median: stock.median, worst: stock.worst, release: stock.release}));

	check('A. the stroke painted something', fast_weights != await ev(`start_weights`), null);
	check('   and the same stroke with the stock path (control) leaves identical weights on every bone', fast_weights == stock_weights, null);
	check('B. mid-stroke the in-place colours equal a full rebuild of the same weights', fast.seen && fast.seen.same_length && fast.seen.max_diff < 1e-6, fast.seen);
	check('   and after release the colours are the rebuild\'s', after_release.max_diff < 1e-6, after_release);
	check('C. quick: press under 100 ms, a move under 30 ms at the median, release under 400 ms', fast.press < 100 && fast.median < 30 && fast.release < 400, fast);
	check('   and each move is several times quicker than the stock path', fast.median * 4 < stock.median, {fast: fast.median, stock: stock.median});
	check('D. undo puts every weight back, redo the stroke again', undo.back && undo.again && undo.restored, undo);
}

await sleep(200);
check('no exception was thrown on the page', errors.length == 0, errors);
console.log(`all ${passed} passed`);
