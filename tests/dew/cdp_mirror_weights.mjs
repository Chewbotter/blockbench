// Mirror Weights on the weight brush toolbar, and the Pose Preview panel following the brush. A: a built strip (left
// column at +X on leg_l, centre column, right column at -X with asymmetric weights, one lone vertex): a REAL click on
// the toolbar button opens a menu naming the sides from the rig ("Left onto right"), a real click on it copies the left
// weights onto the right exactly with the bones swapped, evens the centre vertex (leg_r takes leg_l's weight, scaled back
// to its old total), leaves the lone vertex and counts it, one undo entry that puts everything back. B: the other
// direction. C (the user's cat, skipped without it): the right hind leg's weights scrambled, Mirror Weights left onto
// right, every twin pair then equal with the bones swapped. D: the Pose Preview panel hides when another tool is picked
// and comes back with the brush.
import assert from 'assert';
import fs from 'fs';
const CAT = 'D:/Work/CatWhisperer/models_working/cat_common.bbmodel';
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
const click = async (x, y) => { await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y}); await send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1}); await send('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1}); await sleep(150); };
// the toolbar button, then the menu entry whose text starts with `entry`
const pickFromButton = async (entry) => {
	const b = await json(`(() => { let node = [...document.querySelectorAll('[toolbar_item="weight_brush_mirror_weights"]')].find(n => n.offsetParent); let r = node.getBoundingClientRect(); return JSON.stringify({x: r.left + r.width / 2, y: r.top + r.height / 2}); })()`);
	await click(b.x, b.y);
	const m = await json(`(() => { let items = [...document.querySelectorAll('ul.contextMenu li')].filter(li => li.offsetParent && !li.classList.contains('menu_separator'));
		let texts = items.map(li => li.textContent.trim()), hit = items.find(li => li.textContent.includes(${JSON.stringify(entry)}));
		let r = hit ? hit.getBoundingClientRect() : null; return JSON.stringify({texts, at: r && {x: r.left + r.width / 2, y: r.top + r.height / 2}}); })()`);
	if (m.at) await click(m.at.x, m.at.y);
	return m.texts;
};

await ev(`(() => {
	newProject(Formats.free); Modes.options.edit.select(); Mesh.all.slice().forEach(m => m.remove()); Cube.all.slice().forEach(c => c.remove());
	let armature = new Armature({name: 'rig'}).init();
	let spine = new ArmatureBone({name: 'spine', origin: [0, 0, 0], length: 8}); spine.addTo(armature).init();
	let leg_l = new ArmatureBone({name: 'leg_l', origin: [4, 0, 0], length: 8}); leg_l.addTo(armature).init();
	let leg_r = new ArmatureBone({name: 'leg_r', origin: [-4, 0, 0], length: 8}); leg_r.addTo(armature).init();
	let mesh = new Mesh({name: 'strip', vertices: {}}).addTo(armature).init();
	for (let k in mesh.vertices) delete mesh.vertices[k]; for (let k in mesh.faces) delete mesh.faces[k];
	let [A, B, C, D, E, F, G] = mesh.addVertices([4, 0, 0], [4, 8, 0], [0, 0, 0], [0, 8, 0], [-4, 0, 0], [-4, 8, 0], [6, 4, 0]);
	mesh.addFaces(new MeshFace(mesh, {vertices: [A, B, D, C]}), new MeshFace(mesh, {vertices: [C, D, F, E]}));
	window.W = {armature, spine, leg_l, leg_r, mesh, A, B, C, D, E, F, G};
	window.setAll = () => { for (let b of [spine, leg_l, leg_r]) for (let v in mesh.vertices) b.setVertexWeight(mesh, v);
		for (let v of [A, B]) { leg_l.setVertexWeight(mesh, v, 0.7); spine.setVertexWeight(mesh, v, 0.3); }
		for (let v of [E, F]) { leg_r.setVertexWeight(mesh, v, 0.2); spine.setVertexWeight(mesh, v, 0.5); leg_l.setVertexWeight(mesh, v, 0.3); }
		leg_l.setVertexWeight(mesh, C, 0.4); leg_r.setVertexWeight(mesh, C, 0.1); spine.setVertexWeight(mesh, C, 0.5);
		spine.setVertexWeight(mesh, D, 1); leg_l.setVertexWeight(mesh, G, 1); };
	window.weightsOf = v => Object.fromEntries([spine, leg_l, leg_r].map(b => [b.name, +b.getVertexWeight(mesh, v).toFixed(4)]).filter(x => x[1]));
	window.snapshot = () => JSON.stringify([spine, leg_l, leg_r].map(b => Object.entries(b.vertex_weights).sort()));
	setAll(); Canvas.updateAll();
	unselectAllElements(); spine.select(); updateSelection(); BarItems.weight_brush.select(); BarItems.weight_brush_mirror.set('off');
	window.__before = snapshot(); window.__undo = Undo.history.length;
	return true; })()`);
await sleep(300);
const texts = await pickFromButton('Left onto right');
const a = await json(`(() => JSON.stringify({E: weightsOf(W.E), F: weightsOf(W.F), A: weightsOf(W.A), C: weightsOf(W.C), D: weightsOf(W.D), G: weightsOf(W.G), undo: Undo.history.length - __undo, action: Undo.history.at(-1)?.action}))()`);
const cExpect = {leg_l: +(0.4 / 1.3).toFixed(4), leg_r: +(0.4 / 1.3).toFixed(4), spine: +(0.5 / 1.3).toFixed(4)};
check('A. a real click opens a menu naming the sides from the rig', texts.some(t => t.includes('Left onto right (+X onto -X)')) && texts.some(t => t.includes('Right onto left (-X onto +X)')), texts);
check('   left onto right: the right column takes the left weights with the bones swapped, nothing else',
	JSON.stringify(a.E) == JSON.stringify({spine: 0.3, leg_r: 0.7}) && JSON.stringify(a.F) == JSON.stringify({spine: 0.3, leg_r: 0.7}) && JSON.stringify(a.A) == JSON.stringify({spine: 0.3, leg_l: 0.7}), a);
check('   the centre vertex is evened (leg_r takes leg_l\'s weight) and scaled back to its old total; a symmetric one and the lone vertex untouched',
	Math.abs(a.C.leg_l - cExpect.leg_l) < 1e-3 && Math.abs(a.C.leg_r - cExpect.leg_r) < 1e-3 && Math.abs(a.C.spine - cExpect.spine) < 1e-3 && JSON.stringify(a.D) == '{"spine":1}' && JSON.stringify(a.G) == '{"leg_l":1}', {C: a.C, expect: cExpect, D: a.D, G: a.G});
check('   one undo entry, and undo puts every weight back', a.undo == 1 && a.action == 'Mirror weights' && await ev(`(() => { Undo.undo(); return snapshot() == __before; })()`), a);

const b = await json(`(() => { let r = DEWMirrorWeights.mirrorWeights([W.mesh], 0, -1); return JSON.stringify({r, A: weightsOf(W.A), B: weightsOf(W.B), E: weightsOf(W.E)}); })()`);
check('B. right onto left copies the other way, the lone vertex has no twin and keeps its own',
	JSON.stringify(b.A) == JSON.stringify({spine: 0.5, leg_l: 0.2, leg_r: 0.3}) && JSON.stringify(b.B) == JSON.stringify(b.A) && b.r.copied == 2 && b.r.centre == 1, b);

// C: the user's cat
if (fs.existsSync(CAT)) {
	await ev(`(() => { loadModelFile({content: ${JSON.stringify(fs.readFileSync(CAT, 'utf8'))}, path: ${JSON.stringify(CAT)}}); return true; })()`);
	await sleep(5000);
	const c = await json(`(() => {
		Modes.options.edit.select(); let body = Mesh.all.find(m => m.name == 'body'), bones = body.getArmature().getAllBones(), by = n => bones.find(b => b.name == n);
		// scramble the right hind leg: every vertex weighted to a right leg bone swaps its thigh and shin shares
		let right = ['thigh_r', 'shin_r', 'hind_foot_r', 'hind_toes_r'].map(by), scrambled = 0;
		for (let v in body.vertices) { let a = by('thigh_r').getVertexWeight(body, v), s = by('shin_r').getVertexWeight(body, v); if (a || s) { by('thigh_r').setVertexWeight(body, v, s); by('shin_r').setVertexWeight(body, v, a); scrambled++; } }
		let r = DEWMirrorWeights.mirrorWeights(Mesh.all.filter(m => m.getArmature()), 0, 1);
		// every twin pair: the -X vertex's weights equal the +X one's with sides swapped
		let twins = 0, worst = 0, side = n => n.replace(/_l$/, '_R').replace(/_r$/, '_l').replace(/_R$/, '_r');
		for (let mesh of Mesh.all.filter(m => m.getArmature())) {
			let grid = new Map(); for (let v in mesh.vertices) grid.set(mesh.vertices[v].map(x => Math.round(x * 100)).join(','), v);
			for (let v in mesh.vertices) { let p = mesh.vertices[v]; if (p[0] <= 0.01) continue; let t = grid.get([-p[0], p[1], p[2]].map(x => Math.round(x * 100)).join(',')); if (!t) continue; twins++;
				for (let b of bones) { let mine = b.getVertexWeight(mesh, v), theirs = by(side(b.name)).getVertexWeight(mesh, t); worst = Math.max(worst, Math.abs(mine - theirs)); } }
		}
		return JSON.stringify({scrambled, r, twins, worst, positive: DEWMirrorWeights.positiveSideName(bones, 0)}); })()`);
	check('C. on the cat, a scrambled right hind leg is put back from the left: every twin pair equal with sides swapped', c.scrambled > 20 && c.twins > 800 && c.worst < 1e-9 && c.positive == 'left', c);
}

// D: the Pose Preview panel follows the brush
const d = await json(`(async () => {
	unselectAllElements(); ArmatureBone.all[0].select(); updateSelection(); BarItems.weight_brush.select(); if (!BarItems.dew_pose_preview.value) BarItems.dew_pose_preview.trigger();
	let shown = () => { let c = DEWPosePreview.canvas; return !!c && c.isConnected && c.clientWidth > 0; };
	await new Promise(r => setTimeout(r, 300)); let with_brush = shown();
	BarItems.move_tool.select(); await new Promise(r => setTimeout(r, 300)); let other_tool = shown();
	BarItems.weight_brush.select(); await new Promise(r => setTimeout(r, 300)); let back = shown();
	BarItems.dew_pose_preview.trigger();
	return JSON.stringify({with_brush, other_tool, back}); })()`);
check('D. the Pose Preview panel hides when another tool is picked and comes back with the brush', d.with_brush && !d.other_tool && d.back, d);

await sleep(200);
check('no exception was thrown on the page', errors.length == 0, errors);
console.log(`all ${passed} passed`);
