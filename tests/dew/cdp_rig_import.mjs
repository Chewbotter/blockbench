// Import glTF with Rig and Export Poses. A: the fixture (two bones, a skinned box, a flat colour, a bend
// animation) comes in as an Armature with every node a bone, welded vertices, the file's weights, a palette
// texture and keyframes, and undo takes it out again. B: the imported animation bends the tip bone 45 degrees
// about its own X and the deformation follows. C: a pose written from a new animation carries that bone's
// rotation relative to rest and nothing else. D: the core glTF exporter writes the result back with the
// skeleton, the names and both animations. E: the real soldier (four skins, rigid pieces on joints, names with
// dots, four skinned meshes) imports whole, its weights sum to one, and the per-frame deformation cost is printed. F: File > Open
// takes a .glb through the codec. G: the Translucent Bones toggle drives the shared bone materials.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures/rig_fixture.glb');
const soldier = process.env.RIG_FILE || 'D:/Work/DistantEarlyWarning/model_working/soldier_base_rigged.gltf';
const out_dir = process.env.RIG_OUT || path.join(process.env.LOCALAPPDATA || here, 'Temp/dew_rig_export');
fs.mkdirSync(out_dir, {recursive: true});
const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find(t => t.type == 'page' && t.url.includes('index.html')) ?? targets.find(t => t.type == 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.method == 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text); return r.result.result.value; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { if (await ev('typeof Blockbench != "undefined" && !!window.Preview && Preview.all.length > 0')) break; await sleep(500); }
await send('Runtime.enable');

const summary = `(() => {
	let armature = Armature.all[0];
	let bones = ArmatureBone.all.map(b => ({name: b.name, parent: b.parent instanceof Armature ? 'armature' : b.parent.name, origin: b.origin, rotation: b.rotation}));
	let meshes = Mesh.all.map(m => ({name: m.name, parent: m.parent instanceof Armature ? 'armature' : 'root', faces: Object.keys(m.faces).length, vertices: Object.keys(m.vertices).length}));
	return JSON.stringify({armatures: Armature.all.length, armature: armature?.name, bones, meshes, textures: Texture.all.map(t => t.name + ' ' + t.uv_width + 'x' + t.uv_height), animations: Animator.animations.map(a => a.name + ' ' + a.length + 's')});
})()`;

// A. the fixture
await ev(`(() => { newProject(Formats.free); Mesh.all.slice().forEach(m => m.remove()); Cube.all.slice().forEach(c => c.remove()); return true; })()`);
let t0 = Date.now();
console.log('A. import fixture:', await ev(`DEWRig.importRig(${JSON.stringify(fixture)}).then(r => JSON.stringify(r))`), `in ${Date.now() - t0} ms`, ' expect 1 mesh, 1 skinned, 20 faces, 12 vertices, 20 welded, 3 bones, 1 palette, 1 animation with 23 keyframes (Blender samples the rotation)');
await sleep(300);
console.log('   scene:', await ev(summary), ' expect armature rig; bones rig (parent armature), root (rig), tip (root, origin 0,16,0); mesh box under the armature; texture palette 8x8; animation bend 0.5s');
console.log('   weights:', await ev(`(() => { let m = Mesh.all[0]; let root = ArmatureBone.all.find(b => b.name == 'root'), tip = ArmatureBone.all.find(b => b.name == 'tip');
	let low = 0, high = 0, wrong = 0;
	for (let vkey in m.vertices) { let y = m.vertices[vkey][1] + m.origin[1]; let r = root.getVertexWeight(m, vkey), t = tip.getVertexWeight(m, vkey);
		if (y < 8) { if (r == 1 && t == 0) low++; else wrong++; } else { if (t == 1 && r == 0) high++; else wrong++; } }
	return JSON.stringify({low, high, wrong}); })()`), ' expect low 4 (y 0 on root), high 8 (y 16 and 32 on tip), wrong 0');
console.log('   palette uv:', await ev(`(() => { let m = Mesh.all[0]; let f = Object.values(m.faces)[0]; let tex = Texture.all.find(t => t.name == 'palette'); return JSON.stringify({texture: f.texture == tex.uuid, uv: f.vertices.map(v => f.uv[v]), inside: f.vertices.every(v => f.uv[v][0] >= 1 && f.uv[v][0] <= 7 && f.uv[v][1] >= 1 && f.uv[v][1] <= 7)}); })()`), ' expect the palette texture, uvs inside the first cell');
console.log('   undo:', await ev(`(() => { Undo.undo(); return JSON.stringify({armatures: Armature.all.length, bones: ArmatureBone.all.length, meshes: Mesh.all.length, textures: Texture.all.length, animations: Animator.animations.length}); })()`), ' expect all 0');
console.log('   redo:', await ev(`(() => { Undo.redo(); return JSON.stringify({armatures: Armature.all.length, bones: ArmatureBone.all.length, meshes: Mesh.all.length, textures: Texture.all.length, animations: Animator.animations.length}); })()`), ' expect 1, 3, 1, 1, 1');

// B. the imported animation: the tip's rotation relative to rest at the last key is 45 degrees about its own X
console.log('B. bend at the last key:', await ev(`(() => { let anim = Animator.animations.find(a => a.name == 'bend'); let tip = ArmatureBone.all.find(b => b.name == 'tip');
	Animator.showDefaultPose(true); Timeline.time = anim.length; Animator.stackAnimations([anim], false);
	let o = tip.scene_object; let rest = new THREE.Quaternion().setFromEuler(o.fix_rotation); let rel = rest.clone().invert().multiply(o.quaternion);
	let angle = Math.radToDeg(2 * Math.acos(Math.min(1, Math.abs(rel.w)))); let axis = new THREE.Vector3(rel.x, rel.y, rel.z).normalize().toArray().map(v => Math.round(v * 100) / 100);
	let m = Mesh.all[0]; let offsets = Armature.all[0].calculateVertexDeformation(m);
	let moved = Object.entries(offsets).filter(([k, d]) => Math.hypot(...d) > 0.01).map(([k]) => Math.round(m.vertices[k][1] + m.origin[1]));
	let top = Object.entries(offsets).filter(([k]) => Math.round(m.vertices[k][1] + m.origin[1]) == 32).map(([, d]) => Math.round(Math.hypot(...d) * 100) / 100);
	Timeline.time = 0; Animator.showDefaultPose(true);
	return JSON.stringify({angle: Math.round(angle * 100) / 100, axis, moved_ys: [...new Set(moved)].sort(), top_displacement: top}); })()`), ' expect angle 45, axis 1,0,0 (or -1,0,0 with a matching sign), only y 32 vertices moved, each by about 12.6 (radius 16.5 from the tip pivot, the corners sit 4 off its axis)');

// C. a pose from a new animation
console.log('C. pose:', await ev(`(() => { let tip = ArmatureBone.all.find(b => b.name == 'tip'); let anim = new Animation({name: 'kneel', length: 1}).add(false);
	anim.getBoneAnimator(tip).addKeyframe({channel: 'rotation', time: 0, data_points: [{x: 30, y: 0, z: 0}]});
	Timeline.time = 0.25; let data = DEWRig.compilePoses(); let pose = data.poses.kneel;
	let q = pose.tip.q; let angle = Math.round(Math.radToDeg(2 * Math.acos(Math.abs(q[3]))) * 100) / 100;
	return JSON.stringify({names: Object.keys(data.poses), bones: Object.keys(pose), tip: pose.tip, angle, bend_first_key: Object.keys(data.poses.bend), time_kept: Timeline.time, format: data.format, version: data.version}); })()`), ' expect poses bend and kneel; kneel holds only tip: deg 30,0,0, angle 30, no pos; bend has no bones (its first key is the rest); time kept 0.25');

// D. round trip through the core glTF exporter
const roundtrip = path.join(out_dir, 'rig_fixture_roundtrip.gltf');
console.log('D. export:', await ev(`Codecs.gltf.compile({encoding: 'ascii', armature: false, animations: true, scale: 16, embed_textures: true}).then(text => {
	let g = JSON.parse(text);
	let tris = g.meshes.reduce((n, m) => n + m.primitives.reduce((k, p) => k + g.accessors[p.indices].count / 3, 0), 0);
	return JSON.stringify({stats: {skins: g.skins?.map(s => s.joints.map(j => g.nodes[j].name)), nodes: g.nodes.map(n => n.name), tris, animations: g.animations?.map(a => a.name), images: g.images?.length}, text}); })`).then(v => { let r = JSON.parse(v); fs.writeFileSync(roundtrip, r.text); return JSON.stringify(r.stats); }), ' expect one skin with rig, root, tip; 20 triangles; animations bend and kneel; 1 image');

// E. the real soldier
if (fs.existsSync(soldier)) {
	await ev(`(() => { newProject(Formats.free); Mesh.all.slice().forEach(m => m.remove()); Cube.all.slice().forEach(c => c.remove()); return true; })()`);
	t0 = Date.now();
	console.log('E. import soldier:', await ev(`DEWRig.importRig(${JSON.stringify(soldier)}).then(r => JSON.stringify(r))`), `in ${Date.now() - t0} ms`, ' expect 11 meshes, 4 skinned, 11402 faces (4 slivers collapse in the weld), 65 bones (69 nodes less the 4 skinned mesh nodes), 7 flat colours, no scaled nodes');
	await sleep(300);
	console.log('   names and hierarchy:', await ev(`(() => { let by = n => ArmatureBone.all.find(b => b.name == n); let p = n => by(n)?.parent?.name;
		let ys = []; for (let m of Mesh.all) for (let k in m.vertices) ys.push(m.vertices[k][1] + m.origin[1]);
		return JSON.stringify({armature: Armature.all[0].name, thigh_L: p('thigh.L'), helmet: p('helmet strapless'), hand_rig: p('Hand_L_Rig'), legs_ctrl: p('Legs_CTRL'), height: [Math.round(Math.min(...ys)), Math.round(Math.max(...ys))], meshes_under_armature: Mesh.all.every(m => m.parent instanceof Armature)}); })()`), ' expect armature Soldier_ROOT; thigh.L under pelvis, helmet strapless under head, Hand_L_Rig under Wrist_L_CTRL, Legs_CTRL under Soldier_ROOT; height about 0 to 47');
	console.log('   weights:', await ev(`(() => { let bones = ArmatureBone.all; let out = {};
		for (let m of Mesh.all) { let bad = 0, n = 0; for (let k in m.vertices) { let sum = 0; for (let b of bones) sum += b.getVertexWeight(m, k); n++; if (Math.abs(sum - 1) > 0.01) bad++; } out[m.name] = bad ? bad + ' of ' + n + ' off' : 'ok'; }
		return JSON.stringify(out); })()`), ' expect every mesh ok (skinned ones sum to 1, rigid ones weight 1 to their own bone)');
	// The cached deformation (dew_perf) against the stock one, on a posed frame so the offsets are not all zero
	console.log('   deformation:', await ev(`(() => { let a = Armature.all[0]; let skinned = Mesh.all.filter(m => Object.keys(m.vertices).length > 500);
		let anim = new Animation({name: 'probe', length: 1}).add(false); for (let n of ['thigh.L', 'spine', 'forearm.R']) anim.getBoneAnimator(ArmatureBone.all.find(b => b.name == n)).addKeyframe({channel: 'rotation', time: 0, data_points: [{x: 25, y: 10, z: -15}]});
		Animator.showDefaultPose(true); Timeline.time = 0; Animator.stackAnimations([anim], false);
		let t = performance.now(); let stock = skinned.map(m => DEWPerf.stockCalculateVertexDeformation.call(a, m)); let stock_ms = performance.now() - t;
		DEWPerf.influence_cache.clear(); t = performance.now(); let first = skinned.map(m => a.calculateVertexDeformation(m)); let first_ms = performance.now() - t;
		t = performance.now(); let cached = skinned.map(m => a.calculateVertexDeformation(m)); let cached_ms = performance.now() - t;
		let worst = 0, moved = 0; skinned.forEach((m, i) => { for (let k in stock[i]) { for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(stock[i][k][c] - cached[i][k][c])); if (Math.hypot(...stock[i][k]) > 0.1) moved++; } });
		t = performance.now(); skinned.forEach((m, i) => DEWPerf.stockDisplayDeformation.call(Mesh.preview_controller, m, cached[i])); let stock_display_ms = performance.now() - t;
		let before = skinned.map(m => m.mesh.geometry.getAttribute('position').array.slice());
		t = performance.now(); skinned.forEach((m, i) => Mesh.preview_controller.displayDeformation(m, cached[i])); let display_ms = performance.now() - t;
		let display_worst = 0, in_place = true; skinned.forEach((m, i) => { let now = m.mesh.geometry.getAttribute('position').array; if (now.length != before[i].length) in_place = false; for (let k = 0; k < now.length; k++) display_worst = Math.max(display_worst, Math.abs(now[k] - before[i][k])); });
		Timeline.time = 0; Animator.showDefaultPose(true); anim.remove(false);
		return JSON.stringify({vertices: skinned.reduce((n, m) => n + Object.keys(m.vertices).length, 0), moved, worst_difference: worst, stock_ms: Math.round(stock_ms), first_ms: Math.round(first_ms), cached_ms: Math.round(cached_ms * 10) / 10, stock_display_ms: Math.round(stock_display_ms), display_ms: Math.round(display_ms), display_worst, in_place}); })()`), ' expect worst differences 0 (or 1e-14) with thousands of vertices moved, the in-place display matching the stock arrays; stock about 100 ms, cached a few ms, display down from about 30 ms');
	const soldier_out = path.join(out_dir, 'Soldier_base_rigged.blockbench.gltf');
	console.log('   export:', await ev(`Codecs.gltf.compile({encoding: 'ascii', armature: false, animations: true, scale: 16, embed_textures: true}).then(text => {
		let g = JSON.parse(text);
		let tris = g.meshes.reduce((n, m) => n + m.primitives.reduce((k, p) => k + g.accessors[p.indices].count / 3, 0), 0);
		return JSON.stringify({stats: {skins: g.skins?.length, joints: g.skins?.[0]?.joints.length, tris, names_kept: ['thigh.L', 'Torso_CTRL', 'helmet strapless'].every(n => g.nodes.some(node => node.name == n)), kb: Math.round(text.length / 1024)}, text}); })`).then(v => { let r = JSON.parse(v); fs.writeFileSync(soldier_out, r.text); return JSON.stringify(r.stats); }), ' expect 1 skin with 65 joints, 11402 triangles, names kept');
	console.log('   written:', soldier_out);
} else {
	console.log('E. skipped, no soldier file at', soldier);
}

// F. File > Open on a .glb goes through the codec into a new project
console.log('F. open:', await ev(`(() => { let before = ModelProject.all.length; loadModelFile({path: ${JSON.stringify(fixture)}, name: 'rig_fixture.glb', content: ''});
	return new Promise(r => setTimeout(() => r(JSON.stringify({new_project: ModelProject.all.length - before, format: Format.id, armatures: Armature.all.length, bones: ArmatureBone.all.length})), 1500)); })()`), ' expect 1 new project, format free, 1 armature, 3 bones');

// G. Translucent Bones: on by default, the shared bone materials take the constants, off restores the stock 1
console.log('G. translucent bones:', await ev(`(() => { let c = ArmatureBone.preview_controller; let out = {};
	c.updateFaces(ArmatureBone.all[0]); out.on = [c.material.opacity, c.material_selected.opacity];
	BarItems.dew_translucent_bones.set(false); out.off = [c.material.opacity, c.material_selected.opacity];
	BarItems.dew_translucent_bones.set(true); out.back = [c.material.opacity, c.material_selected.opacity];
	out.in_view_menu = MenuBar.menus.view.structure.includes('dew_translucent_bones');
	return JSON.stringify(out); })()`), ' expect on 0.35 and 0.7, off 1 and 1, back 0.35 and 0.7, in the View menu');

await sleep(200);
console.log('page errors:', errors.length ? errors : 'none');
ws.close();
