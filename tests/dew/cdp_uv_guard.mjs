// Applying a texture to faces whose uvs have collapsed onto a point warns, selects them and offers Auto Unwrap;
// faces with a real layout pass in silence; the unwrap gives every face area.
import assert from 'assert';
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

// Two boxes: one with every face's uvs on a single point (as Flat Color work leaves them), one properly laid out.
// The message box is stubbed so the test can read it and press a button.
await ev(`(() => {
	newProject(Formats.free); Modes.options.edit.select();
	let tex = new Texture({name: 'tex'}).fromDataURL(document.createElement('canvas').toDataURL()).add(false);
	let box = (name, collapsed) => { let m = new Mesh({name, vertices: {}}); let k = m.addVertices([0,0,0],[8,0,0],[8,8,0],[0,8,0],[0,0,8],[8,0,8],[8,8,8],[0,8,8]);
		let quads = [[0,1,2,3],[4,5,6,7],[0,1,5,4],[2,3,7,6],[0,3,7,4],[1,2,6,5]];
		quads.forEach((q, i) => { let uv = {}; q.forEach((vi, j) => uv[k[vi]] = collapsed ? [50, 50] : [i * 16 + [0, 8, 8, 0][j], [0, 0, 8, 8][j]]); m.addFaces(new MeshFace(m, {vertices: q.map(vi => k[vi]), uv})); });
		m.init(); return m; };
	window.rig = {tex, bad: box('bad', true), good: box('good', false), boxes: []};
	window.__stock = Blockbench.showMessageBox;
	Blockbench.showMessageBox = (options, cb) => { rig.boxes.push({title: options.title, message: options.message, buttons: options.buttons}); rig.answer = cb; };
	Canvas.updateAll();
	return true;
})()`);

// A. the good box: no message, texture on every face
let a = await json(`(() => { unselectAllElements(); rig.good.select(); updateSelection(); rig.tex.apply(true); return JSON.stringify({boxes: rig.boxes.length, textured: Object.values(rig.good.faces).every(f => f.texture == rig.tex.uuid)}); })()`);
check('A. a laid-out mesh takes the texture with no message', a.boxes == 0 && a.textured, a);

// B. the collapsed box: the texture is applied, a message names six faces, and they are selected
let b = await json(`(() => { unselectAllElements(); rig.bad.select(); updateSelection(); rig.tex.apply(true); let sel = Project.mesh_selection[rig.bad.uuid];
	return JSON.stringify({boxes: rig.boxes.length, box: rig.boxes[0], textured: Object.values(rig.bad.faces).every(f => f.texture == rig.tex.uuid), selected_faces: sel ? sel.faces.length : 0, selected_meshes: Mesh.selected.map(m => m.name), collapsed: DEWUVGuard.collapsedFaces(rig.bad, rig.tex.uuid).length, undo: Undo.history[Undo.history.length - 1]?.action}); })()`);
check('B. a collapsed mesh takes the texture and gets one message naming its six faces', b.boxes == 1 && b.textured && /6 faces of bad/.test(b.box.message) && JSON.stringify(b.box.buttons) == '["Auto Unwrap","Keep as is"]', b);
check('   the six faces are selected on that mesh alone', b.selected_faces == 6 && JSON.stringify(b.selected_meshes) == '["bad"]' && b.collapsed == 6, b);

// C. Keep as is: nothing changes. Auto Unwrap: every face gets area, one more undo entry, and it undoes
let c = await json(`(() => { rig.answer(1); let still = DEWUVGuard.collapsedFaces(rig.bad, rig.tex.uuid).length; let before = Undo.history.length;
	rig.answer(0); let areas = Object.values(rig.bad.faces).map(f => +DEWUVGuard.uvArea(f).toFixed(2)); let after = Undo.history.length, action = Undo.history[Undo.history.length - 1]?.action;
	Undo.undo(); let back = DEWUVGuard.collapsedFaces(rig.bad, rig.tex.uuid).length; Undo.redo(); let again = DEWUVGuard.collapsedFaces(rig.bad, rig.tex.uuid).length;
	return JSON.stringify({still, areas, undo_added: after - before, action, back, again, texture_kept: Object.values(rig.bad.faces).every(f => f.texture == rig.tex.uuid)}); })()`);
check('C. Keep as is leaves the faces collapsed; Auto Unwrap gives all six an area as one undo entry that undoes and redoes', c.still == 6 && c.areas.every(x => x > 1) && c.undo_added == 1 && c.action == 'Auto unwrap' && c.back == 6 && c.again == 0 && c.texture_kept, c);

// D. a mesh where only some faces are collapsed reports just those
let d = await json(`(() => { rig.boxes = []; let keys = Object.keys(rig.good.faces); let f = rig.good.faces[keys[0]]; for (let k of f.vertices) f.uv[k] = [3, 3];
	unselectAllElements(); rig.good.select(); updateSelection(); rig.tex.apply(true); return JSON.stringify({boxes: rig.boxes.length, message: rig.boxes[0] && rig.boxes[0].message, selected: Project.mesh_selection[rig.good.uuid].faces.length}); })()`);
check('D. one collapsed face among good ones is reported and selected on its own', d.boxes == 1 && /^1 face of good has/.test(d.message) && d.selected == 1, d);

await ev(`(() => { Blockbench.showMessageBox = window.__stock; return true; })()`);
await sleep(200);
check('no exception was thrown on the page', errors.length == 0, errors);
console.log(`all ${passed} passed`);
