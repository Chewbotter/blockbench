// The weight brush paints exactly as stock, without the crawl. On the user's cat (cat_common.bbmodel, skipped without
// it): the same real stroke painted with the fast path and with the stock path (WEIGHT_PERF.FAST_STROKE false, the
// control) leaves identical weights on every bone; mid-stroke the in-place colours equal a full rebuild's; after release
// the colours are the rebuild's; the press, each move and the release stay quick; undo puts every weight back. And the
// Strength slider: at 20 a dab moves a vertex a fifth of the way to the limit, and dabs build up by that rule. And the
// Falloff halo: at 100 a dab reaches past the ring to twice the radius with at most HALO_PEAK of the way; at 0 nothing
// past the ring changes.
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
	// pause: the stock path takes ~240 ms a move, and a browser that busy MERGES queued pointer moves, so its stroke got
	// fewer dabs than the fast one and the weights compared unequal now and then; pacing it delivers every move
	const stroke = async (look, pause = 0) => {
		await mouse('mouseMoved', s.x - 100, s.y, { button: 'none' }); await sleep(100);
		let t = Date.now(); await mouse('mousePressed', s.x - 100, s.y, { buttons: 1 }); let press = Date.now() - t;
		let moves = [], seen = null;
		for (let i = 1; i <= 30; i++) { t = Date.now(); await mouse('mouseMoved', s.x - 100 + i * 7, s.y + Math.sin(i / 3) * 18, { buttons: 1 }); moves.push(Date.now() - t); if (pause) await sleep(pause); if (i == 20 && look) seen = await json(look); }
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
	let stock = await stroke(null, 350);
	let stock_weights = await ev(`weights()`);
	await ev(`(() => { DEWWeightPerf.WEIGHT_PERF.FAST_STROKE = true; Undo.undo(); return true; })()`);
	console.log('   fast ', JSON.stringify({press: fast.press, median: fast.median, worst: fast.worst, release: fast.release}));
	console.log('   stock', JSON.stringify({press: stock.press, median: stock.median, worst: stock.worst, release: stock.release}));

	check('A. the stroke painted something', fast_weights != await ev(`start_weights`), null);
	let wdiff = null;
	if (fast_weights != stock_weights) { let a = JSON.parse(fast_weights), b = JSON.parse(stock_weights); wdiff = []; a.forEach(([name, list], i) => { let m = Object.fromEntries(list), n = Object.fromEntries(b[i][1]); for (let k of new Set([...Object.keys(m), ...Object.keys(n)])) if (m[k] !== n[k]) wdiff.push([name, k, m[k], n[k]]); }); wdiff = {count: wdiff.length, first: wdiff.slice(0, 6), sliders: await json(`JSON.stringify({strength: BarItems.slider_weight_brush_strength.get(), falloff: BarItems.slider_weight_brush_falloff.get(), limit: BarItems.slider_weight_brush_limit.get(), size: BarItems.slider_weight_brush_size.get()})`)}; }
	check('   and the same stroke with the stock path (control) leaves identical weights on every bone', fast_weights == stock_weights, wdiff);
	check('B. mid-stroke the in-place colours equal a full rebuild of the same weights', fast.seen && fast.seen.same_length && fast.seen.max_diff < 1e-6, fast.seen);
	check('   and after release the colours are the rebuild\'s', after_release.max_diff < 1e-6, after_release);
	check('C. quick: press under 100 ms, a move under 30 ms at the median, release under 400 ms', fast.press < 100 && fast.median < 30 && fast.release < 400, fast);
	check('   and each move is several times quicker than the stock path', fast.median * 4 < stock.median, {fast: fast.median, stock: stock.median});
	check('D. undo puts every weight back, redo the stroke again', undo.back && undo.again && undo.restored, undo);

	// E. strength: dabs without moving, at the same spot, strength 20, limit 100
	// aim at a vertex the camera sees, near the body's middle on screen, so it sits in the brush's full-strength centre
	const spot = await json(`(() => { BarItems.slider_weight_brush_strength.setValue(20); BarItems.slider_weight_brush_limit.setValue(100);
		window.bone_w = () => { let b = ArmatureBone.selected[0]; return Object.fromEntries(Object.keys(body.vertices).map(k => [k, b.getVertexWeight(body, k)])); }; window.__w = [bone_w()];
		let p = Preview.selected, r = p.canvas.getBoundingClientRect(), ray = new THREE.Raycaster(), cam = p.camera.getWorldPosition(new THREE.Vector3()); let best = null;
		for (let k in body.vertices) { let w = body.mesh.localToWorld(new THREE.Vector3().fromArray(body.vertices[k])); let q = w.clone().project(p.camera); let x = r.left + (q.x + 1) / 2 * r.width, y = r.top + (1 - q.y) / 2 * r.height;
			let d = Math.hypot(x - ${s.x}, y - ${s.y}); if (best && d >= best.d) continue; let dir = w.clone().sub(cam); let len = dir.length(); ray.set(cam, dir.normalize()); let hit = ray.intersectObject(body.mesh, false)[0];
			if (hit && hit.distance < len - 0.001) continue; best = {k, x, y, d}; }
		return JSON.stringify(best); })()`);
	const dab = async () => { await mouse('mouseMoved', spot.x, spot.y, { button: 'none' }); await sleep(50); await mouse('mousePressed', spot.x, spot.y, { buttons: 1 }); await sleep(40); await mouse('mouseReleased', spot.x, spot.y); await sleep(150); await ev(`(() => { __w.push(bone_w()); return true; })()`); };
	for (let i = 0; i < 5; i++) await dab();
	const e = await json(`(() => { let w0 = __w[0], w1 = __w[1];
		let ratios = Object.keys(w0).filter(k => w0[k] < 0.999).map(k => [k, (w1[k] - w0[k]) / (1 - w0[k])]).filter(r => r[1] > 1e-6);
		ratios.sort((a, b) => b[1] - a[1]); let [key, first] = ratios[0] || [null, 0];
		let expected = [0, 1, 2, 3, 4, 5].map(n => 1 - (1 - w0[key]) * Math.pow(0.8, n)), got = __w.map(w => w[key]);
		return JSON.stringify({touched: ratios.length, key, first_step: +first.toFixed(4), got: got.map(v => +v.toFixed(4)), expected: expected.map(v => +v.toFixed(4)), on_toolbar: Toolbars.weight_brush.children.some(c => c && c.id == 'slider_weight_brush_strength')}); })()`);
	for (let i = 0; i < 5; i++) await ev(`(() => { Undo.undo(); return true; })()`);
	await ev(`(() => { BarItems.slider_weight_brush_strength.setValue(100); return true; })()`);
	// F. falloff: one dab at full strength, falloff 0 then 100, every changed vertex measured by its screen distance
	const halo = await json(`(async () => {
		let p = Preview.selected, r = p.canvas.getBoundingClientRect(), radius = BarItems.slider_weight_brush_size.get(), out = {};
		BarItems.slider_weight_brush_strength.setValue(100);
		for (let f of [0, 100]) {
			BarItems.slider_weight_brush_falloff.setValue(f);
			out['f' + f] = {radius, before: bone_w()};
		}
		return JSON.stringify({radius, outline: !!document.getElementById('weight_brush_outline')});
	})()`);
	const dabAt = async (f) => { await ev(`(() => { BarItems.slider_weight_brush_falloff.setValue(${f}); window.__pre = bone_w(); return true; })()`); await mouse('mouseMoved', spot.x, spot.y, { button: 'none' }); await sleep(50); await mouse('mousePressed', spot.x, spot.y, { buttons: 1 }); await sleep(40); await mouse('mouseReleased', spot.x, spot.y); await sleep(150);
		let r = await json(`(() => { let p = Preview.selected, rect = p.canvas.getBoundingClientRect(), radius = BarItems.slider_weight_brush_size.get(), post = bone_w(), rows = [];
			for (let k in post) { if (Math.abs(post[k] - __pre[k]) < 1e-9) continue; let sc = p.vectorToScreenPosition(body.mesh.localToWorld(new THREE.Vector3().fromArray(body.vertices[k]))); let d = Math.hypot(sc.x - (${spot.x} - rect.left), sc.y - (${spot.y} - rect.top));
				rows.push({d: +(d / radius).toFixed(3), step: +((post[k] - __pre[k]) / Math.max(1e-9, 1 - __pre[k])).toFixed(4)}); }
			let halo_on = document.getElementById('weight_brush_outline')?.classList.contains('has_halo'); Undo.undo(); return JSON.stringify({rows, halo_on}); })()`);
		return r; };
	const f0 = await dabAt(0), f100 = await dabAt(100);
	await ev(`(() => { BarItems.slider_weight_brush_falloff.setValue(0); return true; })()`);
	const beyond = f100.rows.filter(r => r.d > 1);
	console.log('   falloff 0 reached', f0.rows.length, 'vertices, furthest', Math.max(0, ...f0.rows.map(r => r.d)), 'radii; falloff 100 reached', f100.rows.length, ', of them', beyond.length, 'past the ring, steps', beyond.map(r => r.step).join(' '));
	check('F. with Falloff 0 nothing past the ring changes (stock)', f0.rows.every(r => r.d <= 1.0001) && !f0.halo_on, f0);
	check('   with Falloff 100 the dab reaches vertices past the ring, none past twice the radius', beyond.length > 0 && f100.rows.every(r => r.d < 2.0001), f100);
	check('   and past the ring each moves at most HALO_PEAK (0.3) of the way, less the further out', beyond.every(r => r.step <= 0.3 + 1e-4 && r.step > 0) && f100.halo_on, beyond);
	console.log('   strength 20, the centre vertex over five dabs:', e.got.join(' '), ' expected', e.expected.join(' '));
	check('E. at strength 20 one dab moves a vertex at most a fifth of the way to the limit, the centre ones exactly', e.touched > 0 && Math.abs(e.first_step - 0.2) < 0.005, e);
	check('   and five dabs build it up by the same rule, through the blue and green of the ramp', e.got.every((v, i) => Math.abs(v - e.expected[i]) < 0.01), e);
	check('   the Strength slider is on the weight brush toolbar', e.on_toolbar, e);
}

await sleep(200);
check('no exception was thrown on the page', errors.length == 0, errors);
console.log(`all ${passed} passed`);
