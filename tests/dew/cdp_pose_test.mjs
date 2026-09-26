// Pose Test on the user's cat (skipped without the file): the weight brush toolbar lists the project's animations and
// shows one at once; holding the real O key poses the rig at the chosen animation's first keyframe with the weight
// colours kept and the vertex dots hidden; releasing it puts back the exact rest geometry; a press in the viewport ends
// a preview; O does nothing with another tool; no weight changes at any point.
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
const key = (type) => send('Input.dispatchKeyEvent', {type, key: 'o', code: 'KeyO', windowsVirtualKeyCode: 79, nativeVirtualKeyCode: 79, text: type == 'keyDown' ? 'o' : undefined});

if (!fs.existsSync(FILE)) {
	console.log('SKIP: ' + FILE + ' not found');
} else {
	await ev(`(() => { loadModelFile({content: ${JSON.stringify(fs.readFileSync(FILE, 'utf8'))}, path: ${JSON.stringify(FILE)}}); return true; })()`);
	await sleep(5000);
	const a = await json(`(() => {
		Modes.options.edit.select(); window.body = Mesh.all.find(m => m.name == 'body');
		unselectAllElements(); ArmatureBone.all.find(b => b.name == 'spine_2').select(); updateSelection(); BarItems.weight_brush.select();
		let p = Preview.selected; p.setProjectionMode(false); p.camera.position.set(90, 45, 10); p.controls.target.set(0, 38, -8); p.controls.update(); p.render();
		window.snap = () => ({pos: Array.from(body.mesh.geometry.attributes.position.array), col: Array.from(body.mesh.geometry.attributes.color.array), dots: body.mesh.vertex_points.visible});
		window.weights = () => JSON.stringify(ArmatureBone.all.map(b => [b.name, Object.entries(b.vertex_weights || {}).sort()]));
		window.maxDiff = (x, y) => { let d = 0; for (let i = 0; i < x.length; i++) d = Math.max(d, Math.abs(x[i] - y[i])); return x.length == y.length ? d : Infinity; };
		Canvas.updateView({elements: Mesh.all, element_aspects: {geometry: true}});	// picking the brush swaps the material but not the colour buffer
		window.__rest = snap(); window.__w0 = weights();
		let select = BarItems.dew_pose_test_animation, text = (select.node.querySelector('bb-select') || select.node).textContent;
		return JSON.stringify({listed: Object.values(select.options), all: Animation.all.map(x => x.name), value: select.value, shown: text.trim(), on_toolbar: Toolbars.weight_brush.children.some(c => c && c.id == 'dew_pose_test')});
	})()`);
	check('A. the dropdown lists every animation of the project and shows the chosen one at once', a.listed.length == a.all.length && a.listed.length > 0 && a.value && a.shown.length > 0 && a.on_toolbar, a);

	// pick an animation that moves the body, so the check has something to see
	const chosen = await json(`(() => { for (let anim of Animation.all) { BarItems.dew_pose_test_animation.set(anim.uuid); DEWPoseTest.startPoseTest(); let d = maxDiff(__rest.pos, snap().pos); DEWPoseTest.stopPoseTest(); if (d > 0.5) return JSON.stringify({name: anim.name, moved: +d.toFixed(2)}); } return 'null'; })()`);
	check('   an animation that moves the body exists to test with', !!chosen, chosen);

	await key('keyDown'); await sleep(200);
	const held = await json(`(() => { let s = snap(); return JSON.stringify({active: DEWPoseTest.isPoseTestActive(), moved: +maxDiff(__rest.pos, s.pos).toFixed(3), colours_same: maxDiff(__rest.col, s.col) < 1e-6, dots: s.dots}); })()`);
	check('B. holding O poses the body (vertices moved) with the weight colours kept', held.active && held.moved > 0.5 && held.colours_same, held);
	check('   and the vertex dots are hidden while posed', held.dots === false, held);
	// the case that fooled the first version: something refreshes the view while the key is held
	const refreshed = await json(`(() => { let posed = snap().pos; Canvas.updateView({elements: Mesh.all, element_aspects: {geometry: true}}); updateSelection(); Preview.selected.render(); let s = snap(); return JSON.stringify({still_posed: maxDiff(posed, s.pos), dots: s.dots}); })()`);
	check('   a rebuild and a selection update while held are posed again before the next frame, dots still hidden', refreshed.still_posed < 1e-4 && refreshed.dots === false, refreshed);
	await key('keyDown'); await sleep(100);	// key repeat while held
	await key('keyUp'); await sleep(250);
	const released = await json(`(() => { let s = snap(); return JSON.stringify({active: DEWPoseTest.isPoseTestActive(), back: maxDiff(__rest.pos, s.pos), colours: maxDiff(__rest.col, s.col), dots: s.dots}); })()`);
	check('C. releasing O puts back the exact rest geometry and the dots', !released.active && released.back < 1e-6 && released.colours < 1e-6 && released.dots === true, released);

	await key('keyDown'); await sleep(150);
	await send('Input.dispatchMouseEvent', {type: 'mousePressed', x: 900, y: 600, button: 'left', buttons: 1, clickCount: 1}); await sleep(100);
	const pressed = await json(`(() => JSON.stringify({active: DEWPoseTest.isPoseTestActive(), back: maxDiff(__rest.pos, snap().pos)}))()`);
	await send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: 900, y: 600, button: 'left', clickCount: 1}); await key('keyUp'); await sleep(200);
	await ev(`(() => { if (Undo.history.length && Undo.history[Undo.history.length - 1].action == 'Paint vertex weights') Undo.undo(); return true; })()`);
	check('D. a press in the viewport while posed goes back to rest first', !pressed.active && pressed.back < 1e-6, pressed);

	await ev(`(() => { BarItems.move_tool.select(); return true; })()`);
	await key('keyDown'); await sleep(150);
	const other = await json(`(() => JSON.stringify({active: DEWPoseTest.isPoseTestActive(), moved: maxDiff(__rest.pos, Array.from(body.mesh.geometry.attributes.position.array))}))()`);
	await key('keyUp'); await sleep(150);
	check('E. O does nothing with another tool selected', !other.active && other.moved < 1e-6, other);
	check('F. no weight changed at any point', await ev(`weights() == __w0`), null);
}

await sleep(200);
check('no exception was thrown on the page', errors.length == 0, errors);
console.log(`all ${passed} passed`);
