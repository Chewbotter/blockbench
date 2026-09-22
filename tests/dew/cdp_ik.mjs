// 5.2's inverse kinematics on a rig with zero-length rest helpers (the way the fork's glTF import builds one): the rest
// pose solves to itself, a target at full reach gives a straight chain, a keyed twist and a keyed target rotation
// survive the solve, the bake reproduces the solved pose, the handle's own rotation turns the target, and a plane
// handle of the move gizmo moves the handle on both of its axes.
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
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });

// An arm standing up from the origin: upper (10) straight up, a zero-length helper holding a 60 degree bend, lower (10),
// another helper, hand (2). Deform bones have zero rest rotation, the helpers carry it, as the fork's imports do.
await ev(`(() => {
	newProject(Formats.free); Modes.options.edit.select();
	let armature = new Armature({name: 'rig'}).init();
	let upper = new ArmatureBone({name: 'upper', origin: [0, 0, 0], rotation: [0, 0, 0], length: 10}); upper.addTo(armature).init();
	let h1 = new ArmatureBone({name: 'axis_space.lower', origin: [0, 10, 0], rotation: [0, 0, -60], length: 0}); h1.addTo(upper).init();
	let lower = new ArmatureBone({name: 'lower', origin: [0, 0, 0], rotation: [0, 0, 0], length: 10}); lower.addTo(h1).init();
	let h2 = new ArmatureBone({name: 'axis_space.hand', origin: [0, 10, 0], rotation: [0, 0, 0], length: 0}); h2.addTo(lower).init();
	let hand = new ArmatureBone({name: 'hand', origin: [0, 0, 0], rotation: [0, 0, 0], length: 2}); hand.addTo(h2).init();
	Canvas.updateAll(); scene.updateMatrixWorld(true);
	const worldP = b => b.scene_object.getWorldPosition(new THREE.Vector3());
	let wrist = worldP(hand), elbow = worldP(lower), root = worldP(upper);
	let line = wrist.clone().sub(root).normalize(), bend = elbow.clone().sub(root); bend.sub(line.clone().multiplyScalar(bend.dot(line)));
	let pole = new NullObject({name: 'pole', position: elbow.clone().add(bend.normalize().multiplyScalar(12)).toArray()}).init();
	let handle = new NullObject({name: 'handle', position: wrist.toArray()}).init();
	handle.ik_target = hand.uuid; handle.ik_source = upper.uuid; handle.ik_pole = pole.uuid;
	let anim = new Animation({name: 'pose'}).add(); anim.select();
	Modes.options.animate.select(); unselectAllElements(); updateSelection();
	let p = Preview.selected; p.setProjectionMode(false); p.camera.position.set(0, 12, 70); p.controls.target.set(0, 12, 0); p.controls.update(); p.render();
	window.rig = {armature, upper, h1, lower, h2, hand, pole, handle, anim, wrist: wrist.toArray(), elbow: elbow.toArray()};
	window.display = () => { Animator.showDefaultPose(true); Timeline.time = 0; Animator.stackAnimations([rig.anim], false); scene.updateMatrixWorld(true); };
	window.pose = () => { display(); let out = {}; for (let b of ArmatureBone.all) { let q = b.scene_object.getWorldQuaternion(new THREE.Quaternion()), p = b.scene_object.getWorldPosition(new THREE.Vector3()); out[b.name] = {q: q.toArray(), p: p.toArray()}; } return out; };
	window.poseDiff = (a, b) => { let worst = {angle: 0, position: 0, bone: null, nan: false}; for (let n in a) { let qa = new THREE.Quaternion().fromArray(a[n].q), qb = new THREE.Quaternion().fromArray(b[n].q);
		let ang = Math.radToDeg(2 * Math.acos(Math.min(1, Math.abs(qa.dot(qb))))), d = new THREE.Vector3().fromArray(a[n].p).distanceTo(new THREE.Vector3().fromArray(b[n].p));
		if (isNaN(ang) || isNaN(d)) worst.nan = true; if (ang > worst.angle) { worst.angle = ang; worst.bone = n; } if (d > worst.position) worst.position = d; } return worst; };
	window.fkPose = () => { let t = rig.handle.ik_target; rig.handle.ik_target = undefined; let out = pose(); rig.handle.ik_target = t; return out; };
	window.key = (node, channel, values) => { let an = rig.anim.getBoneAnimator(node); an[channel].slice().forEach(kf => an[channel].remove(kf)); if (values) { let kf = an.createKeyframe({}, 0, channel, false, false); kf.set('x', values[0]); kf.set('y', values[1]); kf.set('z', values[2]); } };
	return true;
})()`);
await sleep(300);

// A. the rest pose solves to itself: no bone moves, the helpers least of all, nothing NaN
let a = await json(`JSON.stringify(poseDiff(fkPose(), pose()))`);
check('A. the rest pose solves to itself with the zero-length helpers in the chain', !a.nan && a.angle < 0.001 && a.position < 0.001, a);

// B. a target at exactly full reach gives a straight chain (the iteration alone only approached it)
let b = await json(`(() => { rig.handle.position = [0, 22, 0]; rig.handle.preview_controller.updateTransform(rig.handle); let p = pose(); rig.handle.position = rig.wrist; rig.handle.preview_controller.updateTransform(rig.handle);
	return JSON.stringify({elbow: p['lower'].p.map(v => +v.toFixed(4)), wrist: p['hand'].p.map(v => +v.toFixed(4))}); })()`);
check('B. a target at full reach gives a straight chain, elbow on the line and wrist at the end', Math.abs(b.elbow[0]) < 0.001 && Math.abs(b.elbow[1] - 10) < 0.001 && Math.abs(b.wrist[1] - 20) < 0.001, b);
let b2 = await json(`(() => { rig.handle.position = [0, 21.999, 0]; rig.handle.preview_controller.updateTransform(rig.handle); let p = pose(); rig.handle.position = rig.wrist; rig.handle.preview_controller.updateTransform(rig.handle);
	return JSON.stringify({elbow: p['lower'].p.map(v => +v.toFixed(4))}); })()`);
check('   and so does one just inside the reach, within the straight tolerance', Math.abs(b2.elbow[0]) < 0.001, b2);

// C. keyed twist about a bone's own axis and a keyed target rotation both survive the solve
await ev(`(() => { key(rig.lower, 'rotation', [0, 40, 0]); key(rig.hand, 'rotation', [20, 0, 0]); return true; })()`);
let c = await json(`JSON.stringify(poseDiff(fkPose(), pose()))`);
check('C. a keyed twist on the lower bone and a keyed rotation on the hand come back exactly through IK', !c.nan && c.angle < 0.001 && c.position < 0.001, c);
let c2 = await json(`(() => { let fk = fkPose(); let q = new THREE.Quaternion().fromArray(fk['lower'].q); let rest = new THREE.Quaternion().fromArray(pose()['upper'].q); return JSON.stringify({twist_present: Math.radToDeg(2 * Math.acos(Math.min(1, Math.abs(q.dot(rest))))) > 30}); })()`);
check('   (the twist really is in the FK pose the comparison is made against)', c2.twist_present, c2);

// D. Bake Inverse Kinematics writes bone keys that reproduce the solved pose without the handle
let d = await json(`(() => { let before = pose(); rig.handle.select(); BarItems.bake_ik_animation.click(); let t = rig.handle.ik_target; rig.handle.ik_target = undefined; let baked = pose(); rig.handle.ik_target = t;
	let keys = Object.values(rig.anim.animators).filter(an => an.rotation && an.rotation.length).map(an => an.name); Undo.undo(); return JSON.stringify({diff: poseDiff(before, baked), keyed: keys}); })()`);
check('D. Bake Inverse Kinematics reproduces the solved pose as bone keys (twist included)', !d.diff.nan && d.diff.angle < 0.01 && d.diff.position < 0.01, d);
await ev(`(() => { key(rig.lower, 'rotation', null); key(rig.hand, 'rotation', null); return true; })()`);

// E. the handle's own rotation turns the target in world space and nothing else
let e = await json(`(() => { let plain = pose(); key(rig.handle, 'rotation', [0, 0, 30]); let turned = pose(); key(rig.handle, 'rotation', null);
	let expect = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.degToRad(30))).multiply(new THREE.Quaternion().fromArray(plain['hand'].q));
	let got = new THREE.Quaternion().fromArray(turned['hand'].q);
	let others = poseDiff(Object.fromEntries(Object.entries(plain).filter(([n]) => n != 'hand')), Object.fromEntries(Object.entries(turned).filter(([n]) => n != 'hand')));
	return JSON.stringify({hand_off_deg: +Math.radToDeg(2 * Math.acos(Math.min(1, Math.abs(expect.dot(got))))).toFixed(4), hand_moved: +new THREE.Vector3().fromArray(plain['hand'].p).distanceTo(new THREE.Vector3().fromArray(turned['hand'].p)).toFixed(5), others, channel: !!NullObjectAnimator.prototype.channels.rotation}); })()`);
check('E. a rotation key of 30 about Z on the handle turns the hand by exactly that in world space, the chain untouched', e.channel && e.hand_off_deg < 0.001 && e.hand_moved < 0.001 && e.others.angle < 0.001, e);
let e2 = await json(`(() => { key(rig.handle, 'rotation', [0, 0, 30]); let one = pose(); let two = pose(); key(rig.handle, 'rotation', null); return JSON.stringify(poseDiff(one, two)); })()`);
check('   and showing the frame twice gives the same pose (the rotation does not accumulate)', e2.angle < 0.001, e2);

// F. a real drag on the XY plane handle of the move gizmo moves the handle on both axes, in Parent space (the default,
// which the user had) and in Global
for (let space of ['parent', 'global']) {
console.log('   transform space:', space);
await ev(`(() => { BarItems.move_tool.select(); BarItems.transform_space.set('${space}'); unselectAllElements(); rig.handle.select(); updateSelection(); key(rig.handle, 'position', null); Preview.selected.render(); return true; })()`);
await sleep(300);
const centre = await json(`(() => { let p = Preview.selected, r = p.canvas.getBoundingClientRect(), v = Transformer.position.clone().add(scene.position).project(p.camera);
	return JSON.stringify({x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height, size: Transformer.size}); })()`);
let grab = null;
scan: for (let d = 6; d <= 90; d += 3) for (let [fx, fy] of [[1, 1], [1.4, 0.7], [0.7, 1.4], [1, 0.5], [0.5, 1]]) {
	let x = centre.x + d * fx, y = centre.y - d * fy;
	await mouse('mouseMoved', x, y, { button: 'none' }); await sleep(12);
	if (await ev(`Transformer.axis`) == 'XY') { grab = {x, y}; break scan; }
}
check('F1. the XY plane handle of the move gizmo can be found under the pointer', !!grab, {centre});
const before_keys = await json(`JSON.stringify(rig.handle.position)`);
await mouse('mousePressed', grab.x, grab.y, { buttons: 1 }); await sleep(60);
for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', grab.x - i * 6, grab.y + i * 5, { buttons: 1 }); await sleep(30); }	// toward the body, within reach
await mouse('mouseReleased', grab.x - 60, grab.y + 50); await sleep(250);
let f = await json(`(() => { let an = rig.anim.getBoneAnimator(rig.handle); let kf = an.position[0]; return JSON.stringify({keys: an.position.length, x: kf ? kf.calc('x') : null, y: kf ? kf.calc('y') : null, z: kf ? kf.calc('z') : null}); })()`);
check('F2. the drag wrote one position key with BOTH x and y changed and z untouched', f.keys == 1 && Math.abs(f.x) > 1 && Math.abs(f.y) > 1 && Math.abs(f.z) < 0.001, f);
let f2 = await json(`(() => { let kf = rig.anim.getBoneAnimator(rig.handle).position[0]; let p = pose(); return JSON.stringify({wrist: p['hand'].p.map(v => +v.toFixed(3)), target: [rig.wrist[0] + kf.calc('x'), rig.wrist[1] + kf.calc('y'), rig.wrist[2] + kf.calc('z')].map(v => +v.toFixed(3))}); })()`);
check('   and the chain follows the handle there', Math.hypot(f2.wrist[0] - f2.target[0], f2.wrist[1] - f2.target[1], f2.wrist[2] - f2.target[2]) < 0.01, f2);
}

// G. the motion trail's keyframe marker on the hand sits where IK put the hand (the handle still holds F's position key)
let g = await json(`(() => { key(rig.hand, 'rotation', [20, 0, 0]); BarItems.rotate_tool.select(); unselectAllElements(); rig.hand.select(); updateSelection(); Animator.preview(); Animator.showMotionTrail(); scene.updateMatrixWorld(true);
	let hand = rig.hand.scene_object.getWorldPosition(new THREE.Vector3());
	let marker = Animator.motion_trail.children.find(o => o.isKeyframe && o.geometry.attributes.position.count > 0);
	let at = marker && marker.localToWorld(new THREE.Vector3().fromBufferAttribute(marker.geometry.attributes.position, 0));
	let rest = new THREE.Vector3().fromArray(rig.wrist);
	return JSON.stringify({marker_off_hand: at ? +at.distanceTo(hand).toFixed(4) : null, hand_off_rest: +hand.distanceTo(rest).toFixed(3)}); })()`);
check('G. the motion trail marker of the hand sits where IK put it, not where its own keys would', g.marker_off_hand !== null && g.marker_off_hand < 0.01 && g.hand_off_rest > 1, g);

await sleep(200);
check('no exception was thrown on the page', errors.length == 0, errors);
console.log(`all ${passed} passed`);
