// Animate mode picks the bone nearest the pointer, through the mesh in front of it and on a near miss; the mesh is
// still selectable where no bone is near; at a joint the bone that starts there wins; Edit mode is left as it was.
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
const click = async ([x, y]) => { for (let i = 0; i < 2; i++) { await mouse('mouseMoved', x, y, { button: 'none' }); await sleep(50); } await mouse('mousePressed', x, y, { buttons: 1 }); await sleep(40); await mouse('mouseReleased', x, y); await sleep(150); };
const selected = () => json(`JSON.stringify(Outliner.selected.map(e => e.name))`);

// A rig with a skin standing IN FRONT of its bones: root straight up, an arm off its top down to the right, and a wide
// flat mesh at z 3 between them and the camera
await ev(`(() => {
	newProject(Formats.free); Modes.options.edit.select();
	let armature = new Armature({name: 'rig'}).init();
	let root = new ArmatureBone({name: 'root', origin: [0, 0, 0], rotation: [0, 0, 0], length: 8}); root.addTo(armature).init();
	let helper = new ArmatureBone({name: 'axis_space.arm', origin: [0, 8, 0], rotation: [0, 0, 0], length: 0}); helper.addTo(root).init();
	let arm = new ArmatureBone({name: 'arm', origin: [0, 0, 0], rotation: [0, 0, -120], length: 10}); arm.addTo(helper).init();
	let mesh = new Mesh({name: 'skin', vertices: {}}); let keys = mesh.addVertices([-24, -4, 3], [24, -4, 3], [24, 14, 3], [-24, 14, 3]);
	mesh.addFaces(new MeshFace(mesh, {vertices: keys})); mesh.addTo(armature).init();
	keys.forEach(k => root.setVertexWeight(mesh, k, 1));
	Canvas.updateAll(); unselectAllElements(); updateSelection();
	let p = Preview.selected; p.setProjectionMode(false); p.camera.position.set(0, 5, 70); p.controls.target.set(0, 5, 0); p.controls.update(); p.render();
	window.rig = {root, helper, arm, mesh};
	window.screenOf = point => { let p = Preview.selected; p.render(); let r = p.canvas.getBoundingClientRect(), q = new THREE.Vector3(...point).project(p.camera); return [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height]; };
	window.boneMid = (bone, t) => { scene.updateMatrixWorld(true); return bone.scene_object.localToWorld(new THREE.Vector3(0, bone.length * t, 0)).toArray(); };
	return true;
})()`);
await sleep(300);
// Entering Animate opens the timeline and resizes the viewport, so aim points are taken AFTER each mode switch
const aims = () => json(`JSON.stringify({armMid: screenOf(boneMid(rig.arm, 0.5)), rootMid: screenOf(boneMid(rig.root, 0.5)), joint: screenOf(boneMid(rig.arm, 0)), far: screenOf([-20, 10, 3])})`);
let {armMid, rootMid, joint, far} = await aims();
const covered = await json(`(() => { let p = Preview.selected; let hit = at => { let r = p.canvas.getBoundingClientRect(); p.raycaster.setFromCamera(new THREE.Vector2((at[0] - r.left) / r.width * 2 - 1, -((at[1] - r.top) / r.height) * 2 + 1), p.camera); return p.raycaster.intersectObject(rig.mesh.mesh, false).length > 0; };
	return JSON.stringify({arm: hit(${JSON.stringify(armMid)}), root: hit(${JSON.stringify(rootMid)}), far: hit(${JSON.stringify(far)}), on_canvas: [${JSON.stringify(armMid)}, ${JSON.stringify(far)}].every(at => document.elementFromPoint(at[0], at[1]) === p.canvas)}); })()`);
check('the skin really is in front of both bones, and every aim point is on the canvas', covered.arm && covered.root && covered.far && covered.on_canvas, covered);

await ev(`(() => { Modes.options.animate.select(); unselectAllElements(); updateSelection(); Preview.selected.render(); return Modes.id; })()`);
await sleep(300);
({armMid, rootMid, joint, far} = await aims());
console.log('   state:', await ev(`(() => { let p = Preview.selected, at = ${JSON.stringify(armMid)}, r = p.canvas.getBoundingClientRect(); let b = DEWBonePick.nearestBone(p, {clientX: at[0], clientY: at[1]});
	let data = p.raycast({clientX: at[0], clientY: at[1], offsetX: at[0] - r.left, offsetY: at[1] - r.top, target: p.canvas});
	return JSON.stringify({mode: Modes.id, animate: !!Modes.animate, nearest: b && b.name, raycast: data && data.element && data.element.name, bones: ArmatureBone.all.map(x => [x.name, x.visibility, !!x.locked, !!(x.scene_object && x.scene_object.visible)])}); })()`));
await click(armMid);
check('A. in Animate a click on a bone takes the bone, through the skin in front of it', JSON.stringify(await selected()) == '["arm"]', await selected());
await click(rootMid);
check('   and the other bone likewise', JSON.stringify(await selected()) == '["root"]', await selected());
await click([armMid[0] + 12, armMid[1] - 12]);
check('B. a near miss still takes the nearest bone', JSON.stringify(await selected()) == '["arm"]', await selected());
await click(joint);
check('C. at a joint the bone that STARTS there wins over the one that ends there and over a zero-length helper', JSON.stringify(await selected()) == '["arm"]', await selected());
// An IK handle sits ON the bone it drives (and here behind the skin): a click on it must take the handle, not the bone
await ev(`(() => { let n = new NullObject({name: 'ik', position: boneMid(rig.arm, 0.5)}).init(); window.rig.ik = n; unselectAllElements(); updateSelection(); Preview.selected.render(); return true; })()`);
await sleep(200);
await click(armMid);
check('F. a null object on the bone (and behind the skin) beats the bone under the pointer', JSON.stringify(await selected()) == '["ik"]', await selected());
await click(rootMid);
check('   the other bone is still picked where the null object is not on the ray', JSON.stringify(await selected()) == '["root"]', await selected());
await ev(`(() => { rig.ik.remove(); unselectAllElements(); rig.arm.select(); updateSelection(); return true; })()`);	// back to the state check C left: the arm selected
await click(far);
let with_feature = await selected();
// Control: the same click with the feature off, from the same starting selection, is what stock does
await ev(`(() => { window.__radius = DEWBonePick.BONE_PICK.RADIUS_PX; DEWBonePick.BONE_PICK.RADIUS_PX = 0; unselectAllElements(); rig.arm.select(); updateSelection(); return true; })()`);
await click(far);
let stock = await selected();
await ev(`(() => { DEWBonePick.BONE_PICK.RADIUS_PX = window.__radius; return true; })()`);
check('D. away from every bone the skin can still be selected, exactly as stock selects it', with_feature.includes('skin') && JSON.stringify(with_feature) == JSON.stringify(stock), {with_feature, stock});
let radius = await json(`(() => { let p = Preview.selected, r = p.canvas.getBoundingClientRect(); let at = ${JSON.stringify(armMid)};
	let near = DEWBonePick.nearestBone(p, {clientX: at[0] + DEWBonePick.BONE_PICK.RADIUS_PX * 0.6, clientY: at[1] - DEWBonePick.BONE_PICK.RADIUS_PX * 0.6});
	let beyond = DEWBonePick.nearestBone(p, {clientX: at[0] + DEWBonePick.BONE_PICK.RADIUS_PX * 1.2, clientY: at[1] - DEWBonePick.BONE_PICK.RADIUS_PX * 1.2});
	return JSON.stringify({near: near && near.name, beyond: beyond && beyond.name}); })()`);
check('   the reach is BONE_PICK.RADIUS_PX, measured to the bone\'s line', radius.near == 'arm' && radius.beyond === null, radius);

await ev(`(() => { Modes.options.edit.select(); unselectAllElements(); updateSelection(); Preview.selected.render(); return true; })()`);
await sleep(300);
({armMid, rootMid, joint, far} = await aims());
await click([armMid[0] + 12, armMid[1] - 12]);
check('E. Edit mode is left as it was: the same near miss selects the skin under the pointer', JSON.stringify(await selected()) == '["skin"]', await selected());

await sleep(200);
check('no exception was thrown on the page', errors.length == 0, errors);
console.log(`all ${passed} passed`);
ws.close();
