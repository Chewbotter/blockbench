// A model operation, not a test (the suite only runs cdp_*.mjs). Usage, always FROM A BACKUP of the rig, never from its own output:
//   PROBE_FILE=<source.bbmodel> OUT_FILE=<written.bbmodel> SHOT_DIR=<folder for renders> node tests/dew/run_cdp.mjs tests/dew/bake_rest_pose.mjs --isolated --fresh
// Written for soldier_male_rigged.bbmodel (2026-09-21): bones named upper_arm.L/R and forearm.L/R pointing along local +Y,
// each under an axis_space.<name> bone that holds the rest rotation, the deform bone itself at zero. A_POSE below is the knob.
//
// Re-rests the soldier's arms into an A-pose, inside Blockbench so the skinning and the bone maths are the app's own.
//   1. record every bone's world transform in each preset that keys the arm bones (Body | T-Pose)
//   2. pose upper_arm and forearm on both sides: swing the upper arm into the side plane at A_POSE.BELOW_HORIZONTAL,
//      then swing the forearm onto the same line (minimal rotations, so no twist is added)
//   3. bake the STOCK vertex deformation of that pose into the rest vertices of every weighted mesh
//   4. fold the pose into the rest rotation of the axis_space bones (the deform bones stay at zero rest rotation,
//      which is this rig's convention), rebuild the bind matrices
//   5. re-solve the arm keys of the recorded presets so they give the same world pose as before
//   6. verify, screenshot, and hand the compiled project back; the file is written only if every check passed
import fs from 'fs';
const file = process.env.PROBE_FILE, out_file = process.env.OUT_FILE, shots = process.env.SHOT_DIR;
const A_POSE = {BELOW_HORIZONTAL: 45, FORWARD: 0, ELBOW_BEND: 0};	// degrees

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
const original = fs.readFileSync(file, 'utf8');
await ev(`(() => { loadModelFile({content: ${JSON.stringify(original)}, path: ${JSON.stringify(file)}}); Project.saved = true; return true; })()`);
await sleep(1500);
const shot = async name => { await ev(`Preview.selected.render()`); await sleep(200); const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${shots}/${name}.png`, Buffer.from(s.result.data, 'base64')); };
const frame = (position, target) => ev(`(() => { let p = Preview.selected; p.setProjectionMode(false); p.camera.position.set(${position}); p.controls.target.set(${target}); p.controls.update(); p.render(); return true; })()`);

await frame('0, 24, 75', '0, 24, 0'); await shot('before_front');
await frame('75, 24, 0', '0, 24, 0'); await shot('before_side');

const report = JSON.parse(await ev(`(async () => {
	const A = ${JSON.stringify(A_POSE)};
	const bone = name => ArmatureBone.all.find(b => b.name == name);
	const armature = Armature.all[0];
	const Y = new THREE.Vector3(0, 1, 0);
	const worldQ = o => o.getWorldQuaternion(new THREE.Quaternion());
	const angle = (a, b) => Math.radToDeg(2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))));
	const out = {checks: {}};
	const ARM = ['upper_arm', 'forearm'];

	// 1. presets that key the arm bones with a rotation, and every bone's world orientation in each
	const display = animation => { Animator.showDefaultPose(true); Timeline.time = 0; Animator.stackAnimations([animation], false); scene.updateMatrixWorld(true); };
	const armKeyed = animation => ['L', 'R'].some(side => ARM.some(part => { let an = animation.animators[bone(part + '.' + side).uuid];
		return an && (an.rotation || []).some(kf => ['x', 'y', 'z'].some(axis => Math.abs(parseFloat(kf.data_points[0][axis]) || 0) > 1e-4)); }));
	const presets = Animation.all.filter(armKeyed);
	out.presets_rekeyed = presets.map(a => a.name);
	const recorded = new Map();
	let key_sign = null;
	for (let animation of presets) {
		display(animation);
		recorded.set(animation, new Map(ArmatureBone.all.map(b => [b.uuid, {q: worldQ(b.scene_object), p: b.scene_object.getWorldPosition(new THREE.Vector3())}])));
		if (!key_sign) {	// how a key value in degrees lands on the scene object's euler, axis by axis
			let b = bone('upper_arm.L'), kf = animation.animators[b.uuid].rotation[0], o = b.scene_object;
			key_sign = ['x', 'y', 'z'].map(axis => Math.sign(o.rotation[axis] / Math.degToRad(parseFloat(kf.data_points[0][axis]))));
			out.key_value_vs_scene_euler = ['x', 'y', 'z'].map((axis, i) => [parseFloat(kf.data_points[0][axis]), Math.round(Math.radToDeg(o.rotation[axis]) * 100) / 100]);
		}
	}
	Animator.showDefaultPose(true); scene.updateMatrixWorld(true);

	// 2. pose. Bones point along their local +Y
	let before_twins = null;
	const dirOf = name => Y.clone().applyQuaternion(worldQ(bone(name).scene_object));
	out.before = {upper_arm: dirOf('upper_arm.L').toArray().map(n => Math.round(n * 1000) / 1000), forearm: dirOf('forearm.L').toArray().map(n => Math.round(n * 1000) / 1000)};
	const posed_local = {};
	for (let side of ['L', 'R']) {
		let sx = side == 'L' ? 1 : -1, down = Math.degToRad(A.BELOW_HORIZONTAL), fwd = Math.degToRad(A.FORWARD);
		let target = new THREE.Vector3(sx * Math.cos(down) * Math.cos(fwd), -Math.sin(down), Math.cos(down) * Math.sin(fwd)).normalize();
		for (let part of ARM) {
			let o = bone(part + '.' + side).scene_object;
			let aim = target;
			if (part == 'forearm' && A.ELBOW_BEND) aim = target.clone().applyAxisAngle(new THREE.Vector3(sx, 0, 0).cross(target).normalize(), Math.degToRad(A.ELBOW_BEND));
			let world = worldQ(o), swing = new THREE.Quaternion().setFromUnitVectors(Y.clone().applyQuaternion(world), aim);
			let local = worldQ(o.parent).invert().multiply(swing.multiply(world));
			o.quaternion.copy(local); o.updateMatrixWorld(true);
			posed_local[part + '.' + side] = local.clone();
		}
	}
	scene.updateMatrixWorld(true);
	const posed_world = new Map(ArmatureBone.all.map(b => [b.uuid, {q: worldQ(b.scene_object), p: b.scene_object.getWorldPosition(new THREE.Vector3())}]));
	out.swing_deg = {upper_arm: Math.round(angle(posed_local['upper_arm.L'], new THREE.Quaternion()) * 10) / 10, forearm: Math.round(angle(posed_local['forearm.L'], new THREE.Quaternion()) * 10) / 10};

	// 3. bake the stock deformation of that pose
	const skin = DEWPerf.stockCalculateVertexDeformation;
	out.baked = {};
	for (let mesh of Mesh.all) {
		if (mesh.getArmature && mesh.getArmature() != armature) continue;
		let offsets = skin.call(armature, mesh), moved = 0, furthest = 0;
		let old = {}; for (let vkey in mesh.vertices) old[vkey] = mesh.vertices[vkey].slice();
		for (let vkey in offsets) { let d = Math.hypot(...offsets[vkey]); if (d > 1e-6) { moved++; furthest = Math.max(furthest, d); mesh.vertices[vkey].V3_add(offsets[vkey]); } }
		if (moved) out.baked[mesh.name + (mesh.visibility === false ? ' (hidden)' : '')] = {moved, of: Object.keys(mesh.vertices).length, furthest: Math.round(furthest * 100) / 100};
		if (mesh.name == 'body_base') {
			// The body is an exact mirror image: keep it one. Twins are found by the OLD positions.
			let key = p => p.map(v => Math.round(v * 1000)).join(','), index = new Map();
			for (let vkey in old) index.set(key(old[vkey]), vkey);
			let worst = 0, centre = 0, pairs = 0;
			for (let vkey in old) { let p = old[vkey];
				if (Math.abs(p[0]) < 1e-4) { worst = Math.max(worst, Math.abs(mesh.vertices[vkey][0])); mesh.vertices[vkey][0] = 0; centre++; continue; }
				if (p[0] < 0) continue;
				let twin = index.get(key([-p[0], p[1], p[2]])); if (!twin) { out.checks.body_twin_missing = vkey; continue; }
				let a = mesh.vertices[vkey], b = mesh.vertices[twin];
				worst = Math.max(worst, Math.abs(a[0] + b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
				b[0] = -a[0]; b[1] = a[1]; b[2] = a[2]; pairs++;
			}
			out.body_mirror = {pairs, centre, skinning_asymmetry_before_snap: worst};
		}
	}

	// 4. fold the pose into the axis_space bones' rest rotation. How an element's degrees land on the scene euler:
	let ref = bone('axis_space.upper_arm.L');
	let rest_sign = [0, 1, 2].map(i => Math.sign(ref.scene_object.fix_rotation.toArray()[i] / Math.degToRad(ref.rotation[i])));
	out.rest_value_vs_scene_euler = [0, 1, 2].map(i => [ref.rotation[i], Math.round(Math.radToDeg(ref.scene_object.fix_rotation.toArray()[i]) * 100) / 100]);
	for (let side of ['L', 'R']) for (let part of ARM) {
		let axis = bone('axis_space.' + part + '.' + side);
		let rest = new THREE.Quaternion().setFromEuler(axis.scene_object.fix_rotation);
		let e = new THREE.Euler().setFromQuaternion(rest.multiply(posed_local[part + '.' + side]), axis.scene_object.rotation.order);
		axis.rotation.V3_set([e.x, e.y, e.z].map((r, i) => Math.round(rest_sign[i] * Math.radToDeg(r) * 10000) / 10000));
	}
	// exact mirror, as the file had it: y and z negated on the right
	for (let part of ARM) { let l = bone('axis_space.' + part + '.L').rotation, r = bone('axis_space.' + part + '.R').rotation;
		out.checks['rest_mirror_' + part] = Math.max(Math.abs(l[0] - r[0]), Math.abs(l[1] + r[1]), Math.abs(l[2] + r[2])); r.V3_set([l[0], -l[1], -l[2]]); }
	out.new_rest = Object.fromEntries(['L', 'R'].flatMap(side => ARM.map(part => ['axis_space.' + part + '.' + side, bone('axis_space.' + part + '.' + side).rotation.slice()])));
	for (let b of ArmatureBone.all) b.preview_controller.updateTransform(b);
	Animator.showDefaultPose(true); scene.updateMatrixWorld(true);
	for (let b of ArmatureBone.all) b.preview_controller.updateTransform(b);	// bind matrices read the parents' fresh world matrices
	scene.updateMatrixWorld(true);
	// The four axis_space bones now hold the rotation the deform bones held while posing: they differ by design
	const folded = new Set(['L', 'R'].flatMap(side => ARM.map(part => bone('axis_space.' + part + '.' + side).uuid)));
	out.checks.folded_bones_carry_weights = [...folded].reduce((n, uuid) => n + Object.keys(ArmatureBone.all.find(b => b.uuid == uuid).vertex_weights || {}).length, 0);
	let rest_q = 0, rest_p = 0;
	for (let b of ArmatureBone.all) { if (folded.has(b.uuid)) continue; let want = posed_world.get(b.uuid); rest_q = Math.max(rest_q, angle(worldQ(b.scene_object), want.q)); rest_p = Math.max(rest_p, b.scene_object.getWorldPosition(new THREE.Vector3()).distanceTo(want.p)); }
	out.checks.new_rest_vs_posed = {worst_angle_deg: rest_q, worst_position: rest_p};
	out.checks.bones_off = ArmatureBone.all.filter(b => !folded.has(b.uuid) && angle(worldQ(b.scene_object), posed_world.get(b.uuid).q) > 0.01).map(b => b.name + ' ' + Math.round(angle(worldQ(b.scene_object), posed_world.get(b.uuid).q) * 100) / 100);
	let residual = 0;
	for (let mesh of Mesh.all) { if (mesh.visibility === false) continue; let offsets = skin.call(armature, mesh); for (let vkey in offsets) residual = Math.max(residual, Math.hypot(...offsets[vkey])); }
	out.checks.deformation_at_new_rest = residual;
	for (let mesh of Mesh.all) Mesh.preview_controller.updateGeometry(mesh);

	// 5. the recorded presets keep their world pose: re-solve the deform bones' keys, parent first
	out.preset_error_deg = {};
	for (let animation of presets) {
		for (let part of ARM) for (let side of ['L', 'R']) {
			display(animation);
			let b = bone(part + '.' + side), o = b.scene_object, want = recorded.get(animation).get(b.uuid).q;
			let local = worldQ(o.parent).invert().multiply(want);
			let e = new THREE.Euler().setFromQuaternion(local, o.rotation.order);
			for (let kf of animation.animators[b.uuid].rotation) ['x', 'y', 'z'].forEach((axis, i) => kf.data_points[0][axis] = Math.round(key_sign[i] * Math.radToDeg(e[axis]) * 10000) / 10000);
		}
		display(animation);
		let worst = 0, worst_p = 0;
		for (let b of ArmatureBone.all) { if (folded.has(b.uuid)) continue; let want = recorded.get(animation).get(b.uuid); worst = Math.max(worst, angle(worldQ(b.scene_object), want.q)); worst_p = Math.max(worst_p, b.scene_object.getWorldPosition(new THREE.Vector3()).distanceTo(want.p)); }
		out.preset_error_deg[animation.name] = {worst_angle_deg: worst, worst_position: worst_p};
		out.preset_keys = out.preset_keys || {}; out.preset_keys[animation.name] = Object.fromEntries(ARM.map(part => [part + '.L', ['x', 'y', 'z'].map(axis => animation.animators[bone(part + '.L').uuid].rotation[0].data_points[0][axis])]));
	}
	Animator.showDefaultPose(true); scene.updateMatrixWorld(true);

	// 6. what the arms are now
	out.after = {upper_arm: dirOf('upper_arm.L').toArray().map(n => Math.round(n * 10000) / 10000), forearm: dirOf('forearm.L').toArray().map(n => Math.round(n * 10000) / 10000),
		elbow_bend_deg: Math.round(Math.radToDeg(dirOf('upper_arm.L').angleTo(dirOf('forearm.L'))) * 1000) / 1000};
	let hand = m => { let p = Object.values(Mesh.all.find(x => x.name == m).vertices); return [0, 1, 2].map(i => Math.round(p.reduce((s, v) => s + v[i], 0) / p.length * 100) / 100); };
	out.after.hand_left_centre = hand('hand left'); out.after.hand_right_centre = hand('hand right');
	let body = Mesh.all.find(m => m.name == 'body_base'); let xs = Object.values(body.vertices);
	out.after.body_bounds = [0, 1, 2].map(i => [Math.round(Math.min(...xs.map(v => v[i])) * 10) / 10, Math.round(Math.max(...xs.map(v => v[i])) * 10) / 10]);
	out.after.nan = Mesh.all.some(m => Object.values(m.vertices).some(v => v.some(n => !isFinite(n))));
	Canvas.updateAll(); updateSelection();
	return JSON.stringify(out);
})()`));
console.log(JSON.stringify(report, null, 1));

await frame('0, 24, 75', '0, 24, 0'); await shot('after_front');
await frame('75, 24, 0', '0, 24, 0'); await shot('after_side');
await frame('0, 110, 0.01', '0, 24, 0'); await shot('after_top');
await ev(`(() => { let a = Animation.all.find(a => a.name == 'Body | T-Pose'); Animator.showDefaultPose(true); Timeline.time = 0; Animator.stackAnimations([a], false); scene.updateMatrixWorld(true);
	for (let mesh of Mesh.all) if (mesh.visibility !== false && mesh.getArmature()) Mesh.preview_controller.displayDeformation(mesh, DEWPerf.stockCalculateVertexDeformation.call(Armature.all[0], mesh)); return true; })()`);
await frame('0, 24, 75', '0, 24, 0'); await shot('after_tpose_front');
await ev(`(() => { Animator.showDefaultPose(true); for (let mesh of Mesh.all) Mesh.preview_controller.updateGeometry(mesh); return true; })()`);

const c = report.checks;
const ok = !report.after.nan && !c.body_twin_missing && c.folded_bones_carry_weights == 0 && c.bones_off.length == 0 && c.new_rest_vs_posed.worst_angle_deg < 0.01 && c.new_rest_vs_posed.worst_position < 0.001 && c.deformation_at_new_rest < 0.001
	&& Object.values(report.preset_error_deg).every(e => e.worst_angle_deg < 0.01 && e.worst_position < 0.001) && report.after.elbow_bend_deg < 0.01 + A_POSE.ELBOW_BEND && errors.length == 0;
console.log('page errors:', errors.length ? errors : 'none');
if (!ok) { console.log('CHECKS FAILED: nothing written'); ws.close(); process.exit(1); }

const compiled = await ev(`Codecs.project.compile()`);
const before = JSON.parse(original), after = JSON.parse(compiled);
const count = m => ({elements: m.elements.length, animations: (m.animations || []).length, textures: (m.textures || []).length, groups: (m.groups || []).length,
	weights: m.elements.filter(e => e.type == 'armature_bone').reduce((n, e) => n + Object.keys(e.vertex_weights || {}).length, 0),
	faces: m.elements.filter(e => e.type == 'mesh').reduce((n, e) => n + Object.keys(e.faces).length, 0), vertices: m.elements.filter(e => e.type == 'mesh').reduce((n, e) => n + Object.keys(e.vertices).length, 0)});
console.log('file before:', JSON.stringify(count(before)));
console.log('file after: ', JSON.stringify(count(after)));
if (JSON.stringify(count(before)) != JSON.stringify(count(after))) { console.log('COUNTS DIFFER: nothing written'); ws.close(); process.exit(1); }
fs.writeFileSync(out_file, compiled);
console.log('written', out_file, compiled.length, 'bytes');
ws.close();
