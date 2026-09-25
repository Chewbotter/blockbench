// Edges stay drawn on their own faces. A line's depth is taken on the line, a face's at each pixel centre up to half a
// pixel beside it, so in a concave crease the faces win the depth test and the edge fades or breaks up, worse at a steep
// view (the user's report on cat_common's ears, in solid view with bones hidden). Measured on that file the same way:
// the pixels the outline adds to a frame, with the polygon offset, without it (the control), and with a much larger one
// (which must add next to nothing, so 1 is enough and back edges do not leak through the thin ear). Skipped without the
// file. Also: the offset reaches the material a view mode swaps in, and it is viewport only.
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

if (fs.existsSync(FILE)) {
	await ev(`(() => { loadModelFile({content: ${JSON.stringify(fs.readFileSync(FILE, 'utf8'))}, path: ${JSON.stringify(FILE)}}); Modes.options.edit.select(); return true; })()`);
	await sleep(4000);
	const views = await json(`(() => {
		let body = Mesh.all.find(m => m.name == 'body'); unselectAllElements(); body.select(); updateSelection();
		BarItems.view_mode.set('solid'); Canvas.updateAll();
		ArmatureBone.all.forEach(b => { if (b.scene_object) b.scene_object.visible = false; });
		let p = Preview.selected, gl = p.renderer.getContext(); p.setProjectionMode(false);
		let ear = ArmatureBone.all.find(b => b.name == 'ear_l'), tip = ArmatureBone.all.find(b => b.name == 'ear_tip_l'); scene.updateMatrixWorld(true);
		let e0 = ear.scene_object.getWorldPosition(new THREE.Vector3()), e1 = tip.scene_object.getWorldPosition(new THREE.Vector3()), c = e0.clone().add(e1).multiplyScalar(0.5), r = e0.distanceTo(e1);
		let W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
		let grab = () => { p.render(); let b = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, b); return b; };
		let coverage = k => { DEWEdgeOffset.EDGE_OFFSET.FACTOR = k; DEWEdgeOffset.EDGE_OFFSET.UNITS = k; let a = grab(); body.mesh.outline.visible = false; let b = grab(); body.mesh.outline.visible = true;
			let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] != b[i] || a[i + 1] != b[i + 1] || a[i + 2] != b[i + 2]) n++; return n; };
		let out = [];
		for (let d of [[0.35, 0.35, 1], [1, 0.3, 0.6], [0.8, 0.9, 0.4]]) {
			let dir = new THREE.Vector3(...d).normalize(); p.camera.position.copy(c.clone().addScaledVector(dir, r * 3.2)); p.controls.target.copy(c); p.controls.update();
			out.push({view: d.join(','), off: coverage(0), on: coverage(1), big: coverage(8)});
		}
		DEWEdgeOffset.EDGE_OFFSET.FACTOR = 1; DEWEdgeOffset.EDGE_OFFSET.UNITS = 1;
		BarItems.view_mode.set('textured'); Canvas.updateAll(); p.render();
		return JSON.stringify(out);
	})()`);
	views.forEach(v => console.log(`   view ${v.view}: line pixels without ${v.off}, with ${v.on}, offset 8 ${v.big}`));
	check('A. round the cat\'s ear the offset draws at least a third more line pixels than without it, from every view', views.every(v => v.on >= v.off * 1.33), views);
	check('   and an offset of 8 adds under 2 percent more, so 1 is enough and the thin ear leaks no back edges', views.every(v => v.big <= v.on * 1.02), views);
} else {
	console.log('SKIP A: ' + FILE + ' not found');
}

// B and C on a small mesh of its own
let mat = await json(`(() => { newProject(Formats.free); Modes.options.edit.select();
	let mesh = new Mesh({name: 'plate', vertices: {}}); let k = mesh.addVertices([0,0,0],[8,0,0],[8,0,8],[0,0,8]); mesh.addFaces(new MeshFace(mesh, {vertices: k})); mesh.init(); mesh.select(); updateSelection(); Canvas.updateAll(); Preview.selected.render();
	let list = m => Array.isArray(m) ? m : [m]; let out = {textured: list(mesh.mesh.material).every(x => x.polygonOffset && x.polygonOffsetFactor == 1 && x.polygonOffsetUnits == 1)};
	BarItems.view_mode.set('solid'); Canvas.updateAll(); Preview.selected.render(); out.solid = list(mesh.mesh.material).every(x => x.polygonOffset);
	BarItems.view_mode.set('textured'); Canvas.updateAll(); Preview.selected.render();
	let before = JSON.stringify(mesh.vertices); let saved = Codecs.project.compile(); out.same = before == JSON.stringify(mesh.vertices); out.mentions = /polygon/i.test(saved);
	return JSON.stringify(out); })()`);
check('B. the face material carries the offset, and so does the one the solid view mode swaps in', mat.textured && mat.solid, mat);
check('C. viewport only: vertices unchanged and nothing about it in the saved file', mat.same && !mat.mentions, mat);

await sleep(200);
check('no exception was thrown on the page', errors.length == 0, errors);
console.log(`all ${passed} passed`);
