// A model operation, not a test (the suite only runs cdp_*.mjs). Usage, always FROM A BACKUP of the rig:
//   PROBE_FILE=<source.bbmodel> OUT_FILE=<written.bbmodel> SHOT_DIR=<folder for renders> node tests/dew/run_cdp.mjs tests/dew/setup_soldier_ik.mjs --isolated --fresh
// Written for soldier_male_rigged.bbmodel (2026-09-21): deform bones upper_arm / forearm / palm and thigh / shin / foot,
// each under a zero-length axis_space.<name> helper, face toward +Z.
//
// Gives the rig 5.2's inverse kinematics: one IK handle (a Null Object at root level) per hand and foot, driving the chain
// from the upper arm or thigh down to the wrist or ankle, with a pole (a second Null Object) behind each elbow and in
// front of each knee so the joint bends the right way. Feet lock their world rotation, hands do not (IK below is the knob).
//   1. record every bone's world transform in every animation, and where each wrist and ankle is in it
//   2. make the handles at the rest wrist / ankle and the poles beside the rest elbow / knee, wire them up
//   3. IK solves in EVERY animation once a handle has a target, so any animation that moves a wrist or ankle off rest
//      gets a position key on that handle at time 0 putting it where the pose has it (the others need none)
//   4. verify: every preset still gives the same world pose; a handle moved by hand really pulls the chain; the foot
//      lock holds; screenshot; write the file only if every check passed
import fs from 'fs';
const file = process.env.PROBE_FILE, out_file = process.env.OUT_FILE, shots = process.env.SHOT_DIR;
const IK = {
	POLE_DISTANCE: 12,		// units from the joint to its pole
	LOCK_FEET: true,		// a foot keeps its world rotation while the leg bends (Lock IK Target Rotation)
	LOCK_HANDS: false,
	KEY_EPSILON: 0.01,		// a wrist or ankle this far off rest in a preset gets a handle key there
	POSE_TOLERANCE_DEG: 0.5,	// how far a preset may drift once IK solves it (straight limbs: 0; the bent rest knee moves a little)
	POSE_TOLERANCE_UNITS: 0.05,
};
const CHAINS = [
	{handle: 'ik_hand.L', root: 'upper_arm.L', target: 'palm.L', pole: 'pole_elbow.L', joint: 'forearm.L', pole_z: -1, lock: IK.LOCK_HANDS},
	{handle: 'ik_hand.R', root: 'upper_arm.R', target: 'palm.R', pole: 'pole_elbow.R', joint: 'forearm.R', pole_z: -1, lock: IK.LOCK_HANDS},
	{handle: 'ik_foot.L', root: 'thigh.L', target: 'foot.L', pole: 'pole_knee.L', joint: 'shin.L', pole_z: 1, lock: IK.LOCK_FEET},
	{handle: 'ik_foot.R', root: 'thigh.R', target: 'foot.R', pole: 'pole_knee.R', joint: 'shin.R', pole_z: 1, lock: IK.LOCK_FEET},
];

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
const shot = async name => { if (!shots) return; await ev(`Preview.selected.render()`); await sleep(200); const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${shots}/${name}.png`, Buffer.from(s.result.data, 'base64')); };
const frame = (position, target) => ev(`(() => { let p = Preview.selected; p.setProjectionMode(false); p.camera.position.set(${position}); p.controls.target.set(${target}); p.controls.update(); p.render(); return true; })()`);

const report = JSON.parse(await ev(`(() => {
	const IK = ${JSON.stringify(IK)}, CHAINS = ${JSON.stringify(CHAINS)};
	const bone = name => { let b = ArmatureBone.all.find(b => b.name == name); if (!b) throw new Error('no bone ' + name); return b; };
	const worldP = node => node.scene_object.getWorldPosition(new THREE.Vector3());
	const worldQ = node => node.scene_object.getWorldQuaternion(new THREE.Quaternion());
	const angle = (a, b) => Math.radToDeg(2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))));
	const out = {checks: {}, handle_keys: {}, preset_error: {}};
	const display = animation => { Animator.showDefaultPose(true); Timeline.time = 0; if (animation) Animator.stackAnimations([animation], false); scene.updateMatrixWorld(true); };

	// 1. rest positions, and every bone's world pose in every animation
	Modes.options.animate.select();
	display(null);
	const rest = {};
	for (let c of CHAINS) {
		let root = worldP(bone(c.root)), joint = worldP(bone(c.joint)), target = worldP(bone(c.target));
		// the pole sits in the joint's REST bend plane, so the rest pose solves to itself; a straight limb has none and takes the configured side
		let line = target.clone().sub(root).normalize();
		let bend = joint.clone().sub(root); bend.sub(line.clone().multiplyScalar(bend.dot(line)));
		let bend_at_rest = bend.length();
		let pole_dir = bend_at_rest > 0.05 ? bend.normalize() : new THREE.Vector3(0, 0, c.pole_z);
		rest[c.handle] = {target, joint, pole: joint.clone().add(pole_dir.multiplyScalar(IK.POLE_DISTANCE)), bend_at_rest: +bend_at_rest.toFixed(3)};
	}
	out.rest_bend = Object.fromEntries(CHAINS.map(c => [c.handle, rest[c.handle].bend_at_rest]));
	const recorded = new Map();
	for (let animation of Animation.all) {
		display(animation);
		recorded.set(animation, {bones: new Map(ArmatureBone.all.map(b => [b.uuid, {q: worldQ(b), p: worldP(b)}])), targets: Object.fromEntries(CHAINS.map(c => [c.handle, worldP(bone(c.target))]))});
	}

	// 2. handles and poles at root level, wired up
	const handles = {};
	for (let c of CHAINS) {
		let pole = new NullObject({name: c.pole, position: rest[c.handle].pole.toArray()}).init();
		let handle = new NullObject({name: c.handle, position: rest[c.handle].target.toArray()}).init();
		handle.ik_target = bone(c.target).uuid;
		handle.ik_source = bone(c.root).uuid;
		handle.ik_pole = pole.uuid;
		handle.lock_ik_target_rotation = c.lock;
		handles[c.handle] = handle;
	}
	out.checks.handles_at_root = Object.values(handles).every(h => h.parent == 'root') && NullObject.all.length == CHAINS.length * 2;

	// 3. a handle key wherever a preset moves its wrist or ankle off rest
	for (let animation of Animation.all) {
		let rec = recorded.get(animation);
		for (let c of CHAINS) {
			let offset = rec.targets[c.handle].clone().sub(rest[c.handle].target);
			if (offset.length() < IK.KEY_EPSILON) continue;
			animation.select();
			let kf = animation.getBoneAnimator(handles[c.handle]).createKeyframe({}, 0, 'position', false, false);
			kf.set('x', Math.roundTo(offset.x, 5)); kf.set('y', Math.roundTo(offset.y, 5)); kf.set('z', Math.roundTo(offset.z, 5));
			(out.handle_keys[animation.name] = out.handle_keys[animation.name] || []).push(c.handle + ' ' + offset.toArray().map(v => v.toFixed(2)).join(','));
		}
	}

	// 4a. every preset still gives the world pose it gave before IK
	for (let animation of Animation.all) {
		display(animation);
		let rec = recorded.get(animation), worst = {angle: 0, position: 0, bone: null};
		for (let b of ArmatureBone.all) {
			let was = rec.bones.get(b.uuid), a = angle(was.q, worldQ(b)), d = was.p.distanceTo(worldP(b));
			if (a > worst.angle) { worst.angle = a; worst.bone = b.name; }
			if (d > worst.position) worst.position = d;
		}
		out.preset_error[animation.name] = {worst_angle_deg: +worst.angle.toFixed(4), worst_position: +worst.position.toFixed(5), bone: worst.bone};
	}
	// 4b. a handle moved by hand pulls its chain there, the elbow goes back, the knee forward, a locked foot keeps its rotation
	const pull = (c, delta) => {
		let h = handles[c.handle], before = h.position.slice();
		let anim = Animation.all.find(a => a.name == 'Body | Neutral FK') || Animation.all[0];
		display(anim);
		let joint_before = worldP(bone(c.joint)), target_q_before = worldQ(bone(c.target));
		h.position = [before[0] + delta[0], before[1] + delta[1], before[2] + delta[2]]; h.preview_controller.updateTransform(h);
		display(anim);
		let reached = worldP(bone(c.target)).distanceTo(new THREE.Vector3(...h.position));
		let joint_after = worldP(bone(c.joint)), target_q_after = worldQ(bone(c.target));
		h.position = before; h.preview_controller.updateTransform(h);
		display(anim);
		return {reached: +reached.toFixed(4), joint_moved_z: +(joint_after.z - joint_before.z).toFixed(3), target_turned_deg: +angle(target_q_before, target_q_after).toFixed(3), still_at_rest_after: +worldP(bone(c.target)).distanceTo(rest[c.handle].target).toFixed(5)};
	};
	out.pull_hand_L = pull(CHAINS[0], [-3, 4, 4]);		// hand up and toward the body's front: elbow must bend back
	out.pull_foot_L = pull(CHAINS[2], [0, 5, 0]);		// foot up: knee must bend forward, foot rotation held
	Animator.showDefaultPose(true);
	if (Animation.all[0]) Animation.all[0].select();
	return JSON.stringify(out);
})()`));
console.log(JSON.stringify(report, null, 1));

// a look at it: left hand raised through IK
await ev(`(() => { let h = NullObject.all.find(n => n.name == 'ik_hand.L'); window.__pos = h.position.slice(); h.position = [h.position[0] - 3, h.position[1] + 14, h.position[2] + 6]; h.preview_controller.updateTransform(h); h.select(); Animator.preview(); return true; })()`);
await frame('20, 30, 80', '0, 24, 0'); await shot('ik_hand_raised_front');
await frame('80, 30, 10', '0, 24, 0'); await shot('ik_hand_raised_side');
await ev(`(() => { let h = NullObject.all.find(n => n.name == 'ik_hand.L'); h.position = window.__pos; h.preview_controller.updateTransform(h); unselectAllElements(); Animator.preview(); return true; })()`);

const c = report.checks, presets = Object.values(report.preset_error);
const ok = c.handles_at_root && presets.every(e => e.worst_angle_deg < IK.POSE_TOLERANCE_DEG && e.worst_position < IK.POSE_TOLERANCE_UNITS)
	&& report.pull_hand_L.reached < 0.05 && report.pull_hand_L.joint_moved_z < -0.5 && report.pull_hand_L.still_at_rest_after < 0.001
	&& report.pull_foot_L.reached < 0.05 && report.pull_foot_L.joint_moved_z > 0.5 && report.pull_foot_L.target_turned_deg < 0.01 && report.pull_foot_L.still_at_rest_after < 0.001
	&& errors.length == 0;
console.log('page errors:', errors.length ? errors : 'none');
if (!ok) { console.log('CHECKS FAILED: nothing written'); ws.close(); process.exit(1); }

const compiled = await ev(`Codecs.project.compile()`);
const before = JSON.parse(original), after = JSON.parse(compiled);
const count = m => ({elements: m.elements.length, null_objects: m.elements.filter(e => e.type == 'null_object').length, animations: (m.animations || []).length, textures: (m.textures || []).length,
	keyframes: (m.animations || []).reduce((n, a) => n + Object.values(a.animators || {}).reduce((k, an) => k + (an.keyframes || []).length, 0), 0),
	weights: m.elements.filter(e => e.type == 'armature_bone').reduce((n, e) => n + Object.keys(e.vertex_weights || {}).length, 0),
	faces: m.elements.filter(e => e.type == 'mesh').reduce((n, e) => n + Object.keys(e.faces).length, 0), vertices: m.elements.filter(e => e.type == 'mesh').reduce((n, e) => n + Object.keys(e.vertices).length, 0)});
const cb = count(before), ca = count(after);
console.log('file before:', JSON.stringify(cb));
console.log('file after: ', JSON.stringify(ca));
const added_keys = Object.values(report.handle_keys).reduce((n, list) => n + list.length, 0);
if (ca.elements != cb.elements + CHAINS.length * 2 || ca.null_objects != CHAINS.length * 2 || ca.animations != cb.animations || ca.keyframes != cb.keyframes + added_keys || ca.weights != cb.weights || ca.faces != cb.faces || ca.vertices != cb.vertices) { console.log('COUNTS DIFFER: nothing written'); ws.close(); process.exit(1); }
if (out_file) { fs.writeFileSync(out_file, compiled); console.log('written', out_file, compiled.length, 'bytes'); } else console.log('no OUT_FILE: nothing written');
ws.close();
