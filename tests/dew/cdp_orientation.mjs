// Custom transform orientation: a stored gizmo frame for working down a limb that lies on no world axis. Set from two
// vertices, a ring, or a bone; Move, Scale and Rotate then work along it, it stays put when the selection changes, it is
// kept per project, and Normal space is left as it was.
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

// A limb: three square rings along D = (1, -1, 0) / sqrt 2, the direction of an A-pose arm, 12 long and 2 across
await ev(`(() => {
	newProject(Formats.free); Modes.options.edit.select();
	let D = new THREE.Vector3(1, -1, 0).normalize(), P = new THREE.Vector3(1, 1, 0).normalize(), Q = new THREE.Vector3(0, 0, 1), C = new THREE.Vector3(0, 20, 0);
	let mesh = new Mesh({name: 'limb', vertices: {}}); let rings = [];
	for (let t of [-6, 0, 6]) rings.push([[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([p, q]) => mesh.addVertices(C.clone().addScaledVector(D, t).addScaledVector(P, p).addScaledVector(Q, q).toArray())[0]));
	for (let r = 0; r < 2; r++) for (let i = 0; i < 4; i++) mesh.addFaces(new MeshFace(mesh, {vertices: [rings[r][i], rings[r][(i + 1) % 4], rings[r + 1][(i + 1) % 4], rings[r + 1][i]]}));
	mesh.init(); mesh.select();
	window.limb = {mesh, rings, D, P, Q, C};
	window.pick = keys => { BarItems.selection_mode.set('vertex'); BarItems.selection_mode.onChange({value: 'vertex'}); Project.mesh_selection[mesh.uuid] = {vertices: keys.slice(), edges: [], faces: []}; updateSelection(); };
	window.frameAxes = () => { let e = mesh.getSelectionRotation(), q = mesh.mesh.getWorldQuaternion(new THREE.Quaternion()).multiply(new THREE.Quaternion().setFromEuler(e));
		return {x: new THREE.Vector3(1, 0, 0).applyQuaternion(q), y: new THREE.Vector3(0, 1, 0).applyQuaternion(q), z: new THREE.Vector3(0, 0, 1).applyQuaternion(q)}; };
	BarItems.move_tool.select(); BarItems.transform_space.set('parent'); BarItems.rotation_space.set('local');
	return true;
})()`);

// A. two vertices down the limb
let a = await json(`(() => { let {rings, D} = limb; pick([rings[0][0], rings[1][0]]);
	let offered = Condition(BarItems.dew_orient_from_selection.condition);
	BarItems.dew_orient_from_selection.click();
	let f = frameAxes();
	return JSON.stringify({offered, along: Math.abs(f.y.dot(D)), z_front: Math.abs(f.z.z), space: BarItems.transform_space.value, rotation_space: BarItems.rotation_space.value, edit_space: getEditTransformSpace(),
		in_menu: MenuBar.menus.transform.structure.includes('dew_orient_from_selection')}); })()`);
check('A. two vertices down the limb give a frame whose Y runs along it, Z kept to the front', a.offered && a.along > 0.9999 && a.z_front > 0.9999, a);
check('   and switch Move, Scale and Rotate to Custom, which takes Normal\'s path', a.space == 'custom' && a.rotation_space == 'custom' && a.edit_space === 3 && a.in_menu, a);
let gizmo = await json(`(() => { Transformer.update(); Preview.selected.render(); let y = new THREE.Vector3(0, 1, 0).applyQuaternion(Transformer.getWorldQuaternion(new THREE.Quaternion())); return JSON.stringify({along: Math.abs(y.dot(limb.D))}); })()`);
check('   the gizmo itself is turned along the limb', gizmo.along > 0.9999, gizmo);

// B. Move along the custom Y
let b = await json(`(() => { let {mesh, rings, D} = limb; let keys = [rings[0][0], rings[1][0]]; let before = keys.map(k => mesh.vertices[k].slice());
	Undo.initEdit({elements: [mesh]}); moveElementsInSpace(2, 1); Undo.finishEdit('move');
	let moves = keys.map((k, i) => new THREE.Vector3().fromArray(mesh.vertices[k]).sub(new THREE.Vector3().fromArray(before[i])));
	let out = {length: moves.map(m => Math.round(m.length() * 1e6) / 1e6), parallel: moves.map(m => Math.round(Math.abs(m.clone().normalize().dot(D)) * 1e6) / 1e6)};
	Undo.undo(); return JSON.stringify(out); })()`);
check('B. a move of 2 on Y carries the vertices 2 along the limb and nowhere else', b.length.every(l => Math.abs(l - 2) < 1e-5) && b.parallel.every(p => p > 0.99999), b);

// C. a ring around the limb gives the same direction, and the frame stays when the selection changes
let c = await json(`(() => { let {mesh, rings, D, P} = limb; DEWOrient.setOrientation(new THREE.Quaternion()); pick(rings[1]);
	let found = DEWOrient.directionOfSelection(mesh); BarItems.dew_orient_from_selection.click(); let ring = frameAxes();
	pick([rings[1][0], rings[1][1]]);	// now an edge ACROSS the limb
	let kept = frameAxes();
	BarItems.transform_space.set('normal'); updateSelection(); let normal = frameAxes(); BarItems.transform_space.set('custom'); updateSelection();
	return JSON.stringify({kind: found.kind, ring_along: Math.abs(ring.y.dot(D)), kept_along: Math.abs(kept.y.dot(D)), normal_space_y_along: Math.abs(normal.y.dot(D))}); })()`);
check('C. a ring around the limb gives the limb\'s direction too', c.kind == 'a ring or face' && c.ring_along > 0.9999, c);
check('   the frame stays put when the selection changes, where Normal space follows the selection', c.kept_along > 0.9999 && c.normal_space_y_along < 0.99, c);

// D. Scale along the limb: the ring pair spreads along D only
let d = await json(`(() => { let {mesh, rings, D, P, Q} = limb; BarItems.resize_tool.select(); pick([...rings[0], ...rings[2]]);
	Transformer.update();	// copies the frame into rotation_selection, which resize reads
	let keys = [...rings[0], ...rings[2]], before = Object.fromEntries(keys.map(k => [k, mesh.vertices[k].slice()]));
	mesh.temp_data.oldVertices = {}; for (let k in mesh.vertices) mesh.temp_data.oldVertices[k] = mesh.vertices[k].slice();
	Undo.initEdit({elements: [mesh]}); mesh.resize(3, 1, false, false, true); Undo.finishEdit('scale');
	let along = [], across = [];
	for (let k of keys) { let m = new THREE.Vector3().fromArray(mesh.vertices[k]).sub(new THREE.Vector3().fromArray(before[k])); along.push(Math.abs(m.dot(D))); across.push(Math.hypot(m.dot(P), m.dot(Q))); }
	Undo.undo(); BarItems.move_tool.select();
	return JSON.stringify({along_min: Math.min(...along), across_max: Math.max(...across)}); })()`);
check('D. scaling on Y stretches the selection along the limb and not across it', d.along_min > 0.5 && d.across_max < 1e-5, d);

// E. Rotate about the limb: a ring turns about D, keeping its place along it and its distance from it
let e = await json(`(() => { let {mesh, rings, D, C} = limb; BarItems.rotate_tool.select(); pick(rings[1]); Transformer.update();
	let space = getEditTransformSpace(); let before = rings[1].map(k => new THREE.Vector3().fromArray(mesh.vertices[k]));
	Undo.initEdit({elements: [mesh]}); rotateOnAxis(n => n + 90, 1); Undo.finishEdit('rotate');
	let after = rings[1].map(k => new THREE.Vector3().fromArray(mesh.vertices[k]));
	let radial = v => { let r = v.clone().sub(C); return r.addScaledVector(D, -r.dot(D)); };
	let out = {space, slid_along: Math.max(...after.map((p, i) => Math.abs(p.clone().sub(before[i]).dot(D)))), radius_change: Math.max(...after.map((p, i) => Math.abs(radial(p).length() - radial(before[i]).length()))),
		turned_deg: after.map((p, i) => Math.round(radial(p).angleTo(radial(before[i])) * 180 / Math.PI * 100) / 100)};
	Undo.undo(); BarItems.move_tool.select(); return JSON.stringify(out); })()`);
check('E. the Rotate tool turns a ring 90 degrees about the limb', e.space === 3 && e.slid_along < 1e-5 && e.radius_change < 1e-5 && e.turned_deg.every(t => Math.abs(t - 90) < 0.01), e);
let whole = await json(`(() => { BarItems.rotate_tool.select(); BarItems.selection_mode.set('object'); delete Project.mesh_selection[limb.mesh.uuid]; limb.mesh.select(); updateSelection();
	let space = getEditTransformSpace(); BarItems.move_tool.select(); return JSON.stringify({space}); })()`);
check('   with no vertices selected the Rotate tool falls back to Local for the whole element', whole.space !== 3, whole);

// E2. the same with the real gizmo: stock Rotate never ran in this space, so the drag itself is the thing to prove.
// The Y ring is found by hovering outward from the gizmo until the transformer reports that axis, then dragged round.
await ev(`(() => { let {rings} = limb; BarItems.rotate_tool.select(); pick(rings[1]);
	let p = Preview.selected; p.setProjectionMode(false); p.camera.position.set(30, 45, 60); p.controls.target.set(0, 20, 0); p.controls.update(); p.render(); Transformer.update(); p.render(); return true; })()`);
await sleep(300);
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
const centre = await json(`(() => { let p = Preview.selected, r = p.canvas.getBoundingClientRect(), v = Transformer.position.clone().add(scene.position).project(p.camera);
	return JSON.stringify({x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height}); })()`);
let grab = null;
scan: for (let radius = 30; radius <= 260; radius += 8) for (let step = 0; step < 24; step++) {
	let angle = step / 24 * Math.PI * 2, x = centre.x + Math.cos(angle) * radius, y = centre.y + Math.sin(angle) * radius;
	await mouse('mouseMoved', x, y, { button: 'none' }); await sleep(12);
	if (await ev(`Transformer.axis`) == 'Y') { grab = {x, y, angle, radius}; break scan; }
}
check('E2. the Y ring of the tilted rotate gizmo can be found under the pointer', !!grab, {centre});
await ev(`(() => { window.__ring_before = limb.rings[1].map(k => limb.mesh.vertices[k].slice()); return true; })()`);
await mouse('mousePressed', grab.x, grab.y, { buttons: 1 }); await sleep(60);
for (let i = 1; i <= 10; i++) { let a = grab.angle + i * 0.06; await mouse('mouseMoved', centre.x + Math.cos(a) * grab.radius, centre.y + Math.sin(a) * grab.radius, { buttons: 1 }); await sleep(30); }
await mouse('mouseReleased', centre.x + Math.cos(grab.angle + 0.6) * grab.radius, centre.y + Math.sin(grab.angle + 0.6) * grab.radius); await sleep(250);
let dragged = await json(`(() => { let {mesh, rings, D, C} = limb; let radial = v => { let r = v.clone().sub(C); return r.addScaledVector(D, -r.dot(D)); };
	let before = window.__ring_before.map(p => new THREE.Vector3().fromArray(p)), after = rings[1].map(k => new THREE.Vector3().fromArray(mesh.vertices[k]));
	let out = {slid_along: Math.max(...after.map((p, i) => Math.abs(p.clone().sub(before[i]).dot(D)))), radius_change: Math.max(...after.map((p, i) => Math.abs(radial(p).length() - radial(before[i]).length()))),
		turned_deg: after.map((p, i) => Math.round(radial(p).angleTo(radial(before[i])) * 180 / Math.PI * 10) / 10), undo_entry: Undo.history[Undo.history.length - 1]?.action};
	Undo.undo(); BarItems.move_tool.select(); return JSON.stringify(out); })()`);
check('    a real drag round it turns the ring about the limb, all four vertices by the same angle', dragged.slid_along < 1e-4 && dragged.radius_change < 1e-4 && dragged.turned_deg[0] > 1 && dragged.turned_deg.every(t => Math.abs(t - dragged.turned_deg[0]) < 0.2), dragged);

// F. from the bone that carries the selection
let f = await json(`(() => {
	newProject(Formats.free); Modes.options.edit.select();
	let armature = new Armature({name: 'rig'}).init();
	let root = new ArmatureBone({name: 'root', origin: [0, 0, 0], rotation: [0, 0, 0], length: 4}); root.addTo(armature).init();
	let arm = new ArmatureBone({name: 'upper_arm.L', origin: [0, 4, 0], rotation: [0, 0, -135], length: 8}); arm.addTo(root).init();
	let mesh = new Mesh({name: 'skin', vertices: {}}); let keys = mesh.addVertices([1, 3, 0], [2, 2, 0], [3, 1, 1], [0, 1, 0], [0, 2, 0], [0, 3, 1]);
	mesh.addFaces(new MeshFace(mesh, {vertices: keys.slice(0, 3)}), new MeshFace(mesh, {vertices: keys.slice(3, 6)})); mesh.addTo(armature).init();
	keys.slice(0, 3).forEach(k => { arm.setVertexWeight(mesh, k, 0.8); root.setVertexWeight(mesh, k, 0.2); }); keys.slice(3, 6).forEach(k => root.setVertexWeight(mesh, k, 1));
	Canvas.updateAll(); scene.updateMatrixWorld(true);
	mesh.select(); BarItems.selection_mode.set('vertex'); Project.mesh_selection[mesh.uuid] = {vertices: keys.slice(0, 3), edges: [], faces: []}; updateSelection();
	let before = DEWOrient.getOrientation();
	let offered = Condition(BarItems.dew_orient_from_bone.condition), bone = DEWOrient.boneOfSelection(mesh);
	BarItems.dew_orient_from_bone.click();
	let want = arm.scene_object.getWorldQuaternion(new THREE.Quaternion()), got = DEWOrient.getOrientation();
	let bone_y = new THREE.Vector3(0, 1, 0).applyQuaternion(want);
	Project.mesh_selection[mesh.uuid] = {vertices: keys.slice(3, 6), edges: [], faces: []}; updateSelection();
	return JSON.stringify({fresh_project_had_none: before === null, offered, bone: bone && bone.name, same: Math.abs(want.dot(got)), bone_points: bone_y.toArray().map(n => Math.round(n * 1000) / 1000), other_bone: DEWOrient.boneOfSelection(mesh).name}); })()`);
check('F. a new project starts with no custom frame: it is kept per project', f.fresh_project_had_none, f);
check('   on a rigged mesh the frame is the bone carrying most of the selection', f.offered && f.bone == 'upper_arm.L' && f.same > 0.99999 && f.other_bone == 'root', f);
let g = await json(`(() => { let first = ModelProject.all.find(p => p != Project); let here = DEWOrient.getOrientation().clone(); first.select();
	let there = DEWOrient.getOrientation(); let y = new THREE.Vector3(0, 1, 0).applyQuaternion(there);
	return JSON.stringify({differs: Math.abs(there.dot(here)) < 0.999, first_still_along_limb: Math.abs(y.dot(new THREE.Vector3(1, -1, 0).normalize()))}); })()`);
check('G. switching back to the first project finds its own frame', g.differs && g.first_still_along_limb > 0.9999, g);

await sleep(200);
check('no exception was thrown on the page', errors.length == 0, errors);
console.log(`all ${passed} passed`);
ws.close();
