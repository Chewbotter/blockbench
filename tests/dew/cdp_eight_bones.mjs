// Eight bones per vertex, as Godot 4 keeps them (checked with a headless import, 2026-09-25). A box under an armature of
// nine bones, one corner weighted to all nine (0.9 down to 0.1), the rest to bone 0, an animation turning each bone its
// own way. A: the stock skinning and the fork's cache agree. B: they use the biggest eight: dropping the ninth changes
// nothing, changing the eighth does. C: the glTF export writes JOINTS_1 / WEIGHTS_1, biggest first, normalised. D: the
// rig importer reads all eight back. E: a model with at most four bones a vertex exports as before, no second set.
// F: a real weight brush stroke with a ninth bone keeps every vertex at eight, the painted bone among them.
import assert from 'assert';
import fs from 'fs';
import path from 'path';
const out_dir = path.join(process.env.LOCALAPPDATA || '.', 'Temp/dew_rig_export');
fs.mkdirSync(out_dir, {recursive: true});
const out_file = path.join(out_dir, 'eight_bones.gltf');
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

await ev(`(() => {
	newProject(Formats.free); Modes.options.edit.select();
	Mesh.all.slice().forEach(m => m.remove()); Cube.all.slice().forEach(c => c.remove());
	let armature = new Armature({name: 'rig'}).init();
	let bones = [];
	for (let i = 0; i < 9; i++) { let b = new ArmatureBone({name: 'b' + i, origin: [i * 2 - 8, i, 0], rotation: [0, 0, 0], length: 4}); b.addTo(armature).init(); bones.push(b); }
	let mesh = new Mesh({name: 'box'}).addTo(armature).init();
	let vkeys = Object.keys(mesh.vertices);
	window.eight = {armature, bones, mesh, vkeys, corner: vkeys[0]};
	window.setWeights = (n_on_corner) => {
		for (let b of bones) for (let v of vkeys) b.setVertexWeight(mesh, v);
		for (let v of vkeys) bones[0].setVertexWeight(mesh, v, 1);
		for (let i = 0; i < n_on_corner; i++) bones[i].setVertexWeight(mesh, eight.corner, (9 - i) / 10);
		DEWPerf.influence_cache.clear();
	};
	setWeights(9);
	let anim = new Animation({name: 'twist'}).add(); anim.select();
	bones.forEach((b, i) => { let an = anim.getBoneAnimator(b); let kf = an.createKeyframe({}, 0, 'rotation', false, false); kf.set('x', 10 + i * 7); kf.set('y', -5 * i); kf.set('z', 3 + i * 4); });
	Canvas.updateAll();
	window.posed = () => { Animator.showDefaultPose(true); Timeline.time = 0; Animator.stackAnimations([anim], false); scene.updateMatrixWorld(true); };
	window.corner = (fn) => { posed(); DEWPerf.influence_cache.clear(); let o = fn.call(armature, mesh); return (o[eight.corner] || [0, 0, 0]).slice(); };
	window.dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
	return true;
})()`);
await sleep(200);

const a = await json(`(() => { let stock = corner(DEWPerf.stockCalculateVertexDeformation), fork = corner(Armature.prototype.calculateVertexDeformation);
	return JSON.stringify({stock, fork, diff: dist(stock, fork), moved: Math.hypot(...stock), vertices: eight.vkeys.length}); })()`);
check('A. stock skinning and the fork cache agree on a nine-bone vertex', a.diff < 1e-9 && a.moved > 0.1 && a.vertices == 8, a);

const b = await json(`(() => { let base = corner(DEWPerf.stockCalculateVertexDeformation);
	eight.bones[8].setVertexWeight(eight.mesh, eight.corner); let ninth_gone = corner(DEWPerf.stockCalculateVertexDeformation), ninth_gone_fork = corner(Armature.prototype.calculateVertexDeformation);
	eight.bones[7].setVertexWeight(eight.mesh, eight.corner, 0.6); let eighth_changed = corner(DEWPerf.stockCalculateVertexDeformation), eighth_changed_fork = corner(Armature.prototype.calculateVertexDeformation);
	setWeights(9);
	return JSON.stringify({ninth: dist(base, ninth_gone), ninth_fork: dist(base, ninth_gone_fork), eighth: dist(base, eighth_changed), eighth_fork: dist(eighth_changed, eighth_changed_fork)}); })()`);
check('B. both use the biggest eight: dropping the ninth changes nothing, changing the eighth does', b.ninth < 1e-9 && b.ninth_fork < 1e-9 && b.eighth > 1e-3 && b.eighth_fork < 1e-9, b);

// read one accessor of an ascii glTF with embedded buffers
const readAccessors = `window.readAcc = (g, index) => { let acc = g.accessors[index], view = g.bufferViews[acc.bufferView], uri = g.buffers[view.buffer].uri;
	let bin = Uint8Array.from(atob(uri.split(',')[1]), c => c.charCodeAt(0)).buffer; let n = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4}[acc.type] * acc.count;
	let T = {5126: Float32Array, 5123: Uint16Array, 5121: Uint8Array, 5125: Uint32Array}[acc.componentType]; return Array.from(new T(bin, (view.byteOffset || 0) + (acc.byteOffset || 0), n)); }; true`;
await ev(readAccessors);
const exported = await ev(`Codecs.gltf.compile({encoding: 'ascii', armature: false, animations: true, scale: 16, embed_textures: true})`);
fs.writeFileSync(out_file, exported);
const c = await json(`(() => { let g = JSON.parse(${JSON.stringify(exported)}); let prim = g.meshes.map(m => m.primitives).flat().find(p => p.attributes.JOINTS_0 !== undefined);
	let at = prim.attributes; if (at.JOINTS_1 === undefined) return JSON.stringify({second_set: false, attributes: Object.keys(at)});
	let j0 = readAcc(g, at.JOINTS_0), w0 = readAcc(g, at.WEIGHTS_0), j1 = readAcc(g, at.JOINTS_1), w1 = readAcc(g, at.WEIGHTS_1), count = w0.length / 4;
	let joint_names = g.skins[0].joints.map(j => g.nodes[j].name), worst_sum = 0, eight_bone = null, descending = true;
	for (let i = 0; i < count; i++) { let w = w0.slice(i*4, i*4+4).concat(w1.slice(i*4, i*4+4)), j = j0.slice(i*4, i*4+4).concat(j1.slice(i*4, i*4+4));
		worst_sum = Math.max(worst_sum, Math.abs(w.reduce((t, x) => t + x, 0) - 1)); for (let k = 1; k < 8; k++) if (w[k] > w[k-1] + 1e-6) descending = false;
		if (w[7] > 0 && !eight_bone) eight_bone = {names: j.map(x => joint_names[x]), weights: w.map(x => +x.toFixed(4))}; }
	let expect = [9, 8, 7, 6, 5, 4, 3, 2].map(x => +(x / 44).toFixed(4));
	return JSON.stringify({second_set: true, worst_sum, descending, eight_bone, expect, matches: !!eight_bone && eight_bone.weights.every((w, k) => Math.abs(w - expect[k]) < 1e-3)}); })()`);
check('C. the glTF export writes JOINTS_1 / WEIGHTS_1: the corner has b0 to b7, biggest first, normalised; every vertex sums to 1', c.second_set && c.worst_sum < 1e-5 && c.descending && c.matches && c.eight_bone.names.join() == 'b0,b1,b2,b3,b4,b5,b6,b7', c);

const d = await json(`(async () => { newProject(Formats.free); Mesh.all.slice().forEach(m => m.remove()); Cube.all.slice().forEach(c => c.remove());
	await DEWRig.importRig(${JSON.stringify(out_file)}); let mesh = Mesh.all.find(m => m.getArmature && m.getArmature()), bones = mesh.getArmature().getAllBones();
	let best = null; for (let v in mesh.vertices) { let on = bones.filter(b => b.getVertexWeight(mesh, v)).map(b => [b.name, b.getVertexWeight(mesh, v)]); if (!best || on.length > best.length) best = on; }
	best.sort((x, y) => y[1] - x[1]); let total = best.reduce((t, x) => t + x[1], 0);
	return JSON.stringify({count: best.length, names: best.map(x => x[0]), weights: best.map(x => +(x[1] / total).toFixed(4))}); })()`);
check('D. the rig importer reads all eight back, with their weights', d.count == 8 && d.names.join() == 'b0,b1,b2,b3,b4,b5,b6,b7' && d.weights.every((w, k) => Math.abs(w - c.expect[k]) < 1e-3), d);
await ev(`(() => { newProject(Formats.free); return true; })()`);

// E and F on a fresh build of the same rig
await ev(`(() => {
	newProject(Formats.free); Modes.options.edit.select(); Mesh.all.slice().forEach(m => m.remove()); Cube.all.slice().forEach(c => c.remove());
	let armature = new Armature({name: 'rig'}).init(); let bones = [];
	for (let i = 0; i < 9; i++) { let b = new ArmatureBone({name: 'b' + i, origin: [i * 2 - 8, i, 0], rotation: [0, 0, 0], length: 4}); b.addTo(armature).init(); bones.push(b); }
	let mesh = new Mesh({name: 'box'}).addTo(armature).init(); let vkeys = Object.keys(mesh.vertices);
	window.eight = {armature, bones, mesh, vkeys, corner: vkeys[0]};
	for (let v of vkeys) for (let i = 0; i < 4; i++) bones[i].setVertexWeight(mesh, v, 0.4 - i * 0.05);
	Canvas.updateAll(); return true; })()`);
const e = await json(`Codecs.gltf.compile({encoding: 'ascii', armature: false, animations: false, scale: 16, embed_textures: true}).then(text => { let g = JSON.parse(text);
	let prim = g.meshes.map(m => m.primitives).flat().find(p => p.attributes.JOINTS_0 !== undefined); return JSON.stringify({attributes: Object.keys(prim.attributes), weights: readAcc(g, prim.attributes.WEIGHTS_0).slice(0, 4).map(x => +x.toFixed(4))}); })`);
check('E. at most four bones a vertex: no second set, the four weights as before', !e.attributes.includes('JOINTS_1') && !e.attributes.includes('WEIGHTS_1') && e.weights.join() == [0.4, 0.35, 0.3, 0.25].map(x => +(x / 1.3).toFixed(4)).join(), e);

// F: every vertex on eight bones (b0..b7), paint b8 in Add mode with a real stroke across the box
const f0 = await json(`(() => {
	let {bones, mesh, vkeys} = eight; for (let v of vkeys) { for (let b of bones) b.setVertexWeight(mesh, v); for (let i = 0; i < 8; i++) bones[i].setVertexWeight(mesh, v, 0.9 - i * 0.1); }
	unselectAllElements(); bones[8].select(); updateSelection(); BarItems.weight_brush.select();
	BarItems.weight_brush_blend_mode.set('add'); if (BarItems.weight_brush_smooth?.value) BarItems.weight_brush_smooth.trigger();
	let p = Preview.selected; p.setProjectionMode(false); p.camera.position.set(20, 16, 30); p.controls.target.set(0, 0, 0); p.controls.update(); p.render();
	Canvas.updateAll(); scene.updateMatrixWorld(true);
	let r = p.canvas.getBoundingClientRect(), q = mesh.getWorldCenter().project(p.camera);
	return JSON.stringify({x: r.left + (q.x + 1) / 2 * r.width, y: r.top + (1 - q.y) / 2 * r.height}); })()`);
await sleep(300);
await mouse('mouseMoved', f0.x - 30, f0.y, {buttons: 0}); await sleep(60);
await mouse('mousePressed', f0.x - 30, f0.y, {buttons: 1});
for (let k = -30; k <= 30; k += 6) { await mouse('mouseMoved', f0.x + k, f0.y, {buttons: 1}); await sleep(60); }
await mouse('mouseReleased', f0.x + 30, f0.y, {buttons: 0}); await sleep(300);
const f = await json(`(() => { let {bones, mesh, vkeys} = eight; let painted = 0, worst = 0, dropped = [];
	for (let v of vkeys) { let on = bones.filter(b => b.getVertexWeight(mesh, v)); worst = Math.max(worst, on.length); if (bones[8].getVertexWeight(mesh, v)) { painted++; if (on.includes(bones[7])) dropped.push('b7 kept on ' + v); } }
	return JSON.stringify({painted, worst, dropped, undo: Undo.history.at(-1)?.action}); })()`);
check('F. a real Add stroke with a ninth bone: the painted vertices take it, the smallest (b7) goes, none holds more than eight', f.painted > 0 && f.worst <= 8 && f.dropped.length == 0, f);

await sleep(200);
check('no exception was thrown on the page', errors.length == 0, errors);
console.log(`all ${passed} passed`);
