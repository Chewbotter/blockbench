// Live Mirror: a preview of the selected element flipped across its own pivot, drawn from the element's own geometry
// so it follows every edit, never selectable, kept while you work elsewhere, and dealt with by Discard, Copy or Combine.
// Lock Seam keeps vertices on the mirror plane on it.
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

// Half a box: the +x half of a box 8 wide, 8 tall, 8 deep about the origin, open toward x 0, plus a cap face lying ON x 0
await ev(`(() => {
	newProject(Formats.free); Modes.options.edit.select();
	window.halfBox = (name, cap) => { let mesh = new Mesh({name, vertices: {}, origin: [0, 4, 0]});
		let k = {}; for (let x of [0, 4]) for (let y of [-4, 4]) for (let z of [-4, 4]) k[[x, y, z]] = mesh.addVertices([x, y, z])[0];
		let quad = (...corners) => { let face = new MeshFace(mesh, {vertices: corners.map(c => k[c])}); mesh.addFaces(face); return face; };
		let outward = (face, n) => { let got = face.getNormal(true); if (got[0] * n[0] + got[1] * n[1] + got[2] * n[2] < 0) face.invert(); };
		outward(quad([4,-4,-4],[4,4,-4],[4,4,4],[4,-4,4]), [1,0,0]);
		outward(quad([0,4,-4],[4,4,-4],[4,4,4],[0,4,4]), [0,1,0]); outward(quad([0,-4,-4],[4,-4,-4],[4,-4,4],[0,-4,4]), [0,-1,0]);
		outward(quad([0,-4,4],[4,-4,4],[4,4,4],[0,4,4]), [0,0,1]); outward(quad([0,-4,-4],[4,-4,-4],[4,4,-4],[0,4,-4]), [0,0,-1]);
		if (cap) outward(quad([0,-4,-4],[0,4,-4],[0,4,4],[0,-4,4]), [-1,0,0]);
		mesh.init(); return mesh; };
	window.half = halfBox('fender_left', true); half.select(); BarItems.move_tool.select(); BarItems.selection_mode.set('object'); updateSelection();
	let p = Preview.selected; p.setProjectionMode(false); p.camera.position.set(0, 14, 40); p.controls.target.set(0, 4, 0); p.controls.update(); p.render();
	window.screenOf = point => { let p = Preview.selected; p.render(); let r = p.canvas.getBoundingClientRect(), q = new THREE.Vector3(...point).project(p.camera); return [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height]; };
	window.pixelAt = point => { let p = Preview.selected; p.render(); let gl = p.renderer.getContext(), r = p.canvas.getBoundingClientRect(), q = new THREE.Vector3(...point).project(p.camera);
		let x = Math.round((q.x + 1) / 2 * gl.drawingBufferWidth), y = Math.round((q.y + 1) / 2 * gl.drawingBufferHeight), data = new Uint8Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, data); return [...data]; };
	return true;
})()`);
await sleep(300);

// A. the mirror is drawn, from the element's own geometry, and cannot be picked
let before = await json(`JSON.stringify({there: pixelAt([-2, 4, 4]), real: pixelAt([2, 4, 4]), offered: Condition(BarItems.dew_mirror.condition), exists: Condition(BarItems.dew_mirror_copy.condition)})`);
await ev(`(() => { BarItems.dew_mirror.click(); Preview.selected.render(); return true; })()`);
let a = await json(`(() => { let host = half.mesh, preview = host.children.find(c => c.name == 'dew_mirror');
	return JSON.stringify({made: !!preview, shares_geometry: preview && preview.geometry === host.geometry, shares_material: preview && preview.material === host.material, scale: preview && preview.scale.toArray(), no_export: preview && preview.no_export,
		there: pixelAt([-2, 4, 4]), real: pixelAt([2, 4, 4]), bar: getComputedStyle(document.getElementById('dew_mirror_bar')).display, label: document.querySelector('#dew_mirror_bar .dew_mirror_label').textContent,
		buttons: [...document.querySelectorAll('#dew_mirror_bar button')].map(b => b.textContent), lock: document.getElementById('dew_mirror_lock_box').checked, elements: Outliner.elements.length}); })()`);
check('A. nothing is drawn on the far side before, and no mirror action is live', before.offered && !before.exists && JSON.stringify(before.there) != JSON.stringify(before.real), before);
check('   Live Mirror draws the element again across X at its pivot, from its own geometry and materials, adding no element', a.made && a.shares_geometry && a.shares_material && a.scale[0] == -1 && a.no_export && a.elements == 1 && JSON.stringify(a.there) == JSON.stringify(a.real), a);
check('   the bar is up with Discard, Copy, Combine and Lock Seam ticked', a.bar == 'flex' && JSON.stringify(a.buttons) == '["Discard","Copy","Combine"]' && a.lock && /Mirror X: fender_left/.test(a.label), a);
await ev(`(() => { unselectAllElements(); updateSelection(); return true; })()`);
await click(await json(`JSON.stringify(screenOf([-2, 4, 4]))`));
let ghost = await json(`JSON.stringify(Outliner.selected.map(e => e.name))`);
await click(await json(`JSON.stringify(screenOf([2, 4, 4]))`));
let real = await json(`JSON.stringify(Outliner.selected.map(e => e.name))`);
check('   a click on the mirror selects nothing; the same click on the real side selects the element', ghost.length == 0 && real[0] == 'fender_left', {ghost, real});

// B. it follows edits with no copying: a vertex move, then a topology change that rebuilds the geometry
let b = await json(`(() => { let host = half.mesh, preview = host.children.find(c => c.name == 'dew_mirror'); let geometry_before = host.geometry;
	let far = pixelAt([-7, 4, 0]);
	Undo.initEdit({elements: [half]}); for (let vkey in half.vertices) if (half.vertices[vkey][0] > 3) half.vertices[vkey][0] = 8; Undo.finishEdit('widen'); Canvas.updateView({elements: [half], element_aspects: {geometry: true}});
	let after_move = {same_geometry: preview.geometry === host.geometry, far_now: pixelAt([-7, 4, 4]), real_now: pixelAt([7, 4, 4])};
	let extra = half.addVertices([4, 8, 0])[0]; let top = Object.keys(half.vertices).filter(k => half.vertices[k][1] == 4 && half.vertices[k][0] == 8);
	let [added_face] = half.addFaces(new MeshFace(half, {vertices: [top[0], top[1], extra]})); Canvas.updateView({elements: [half], element_aspects: {geometry: true, faces: true}}); Preview.selected.render();
	preview = half.mesh.children.find(c => c.name == 'dew_mirror');
	let out = {...after_move, after_rebuild_same: !!preview && preview.geometry === half.mesh.geometry && preview.material === half.mesh.material, faces: Object.keys(half.faces).length};
	Undo.undo(); delete half.faces[added_face]; delete half.vertices[extra];	// the undo may already have taken them for (let vkey in half.vertices) if (half.vertices[vkey][0] > 3) half.vertices[vkey][0] = 4;
	Canvas.updateView({elements: [half], element_aspects: {geometry: true, faces: true}}); return JSON.stringify(out); })()`);
check('B. widening the real half widens the mirror in the same frame, and a rebuilt geometry is picked up', b.same_geometry && JSON.stringify(b.far_now) == JSON.stringify(b.real_now) && b.after_rebuild_same, b);

// C. work elsewhere: the mirror stays, and the buttons still know what they act on
let c = await json(`(() => { let other = new Cube({name: 'other', from: [20, 0, 0], to: [24, 4, 4]}).init(); other.select(); updateSelection(); Preview.selected.render();
	let out = {still: !!half.mesh.children.find(c => c.name == 'dew_mirror'), targets: DEWMirror.targets().map(e => e.name), usable: Condition(BarItems.dew_mirror_combine.condition)}; other.remove(); return JSON.stringify(out); })()`);
check('C. selecting and editing something else leaves the mirror up, and the bar still acts on it', c.still && c.targets[0] == 'fender_left' && c.usable, c);

// D. Lock Seam: vertices on the mirror plane slide along it and cannot leave it; off, they can
let d = await json(`(() => { half.select(); BarItems.selection_mode.set('vertex'); let seam = Object.keys(half.vertices).filter(k => half.vertices[k][0] == 0);
	Project.mesh_selection[half.uuid] = {vertices: [seam[0], Object.keys(half.vertices).find(k => half.vertices[k][0] == 4)], edges: [], faces: []}; updateSelection();
	let free = Project.mesh_selection[half.uuid].vertices[1]; let y0 = half.vertices[seam[0]][1];
	Undo.initEdit({elements: [half]}); moveElementsInSpace(3, 0, 0); moveElementsInSpace(2, 1, 0); Canvas.updateView({elements: [half], element_aspects: {geometry: true}}); Undo.finishEdit('drag');
	let locked = {seam_x: half.vertices[seam[0]][0], seam_y_moved: half.vertices[seam[0]][1] - y0, free_x: half.vertices[free][0]}; Undo.undo();
	BarItems.dew_mirror_lock_seam.trigger();
	Undo.initEdit({elements: [half]}); moveElementsInSpace(3, 0, 0); Canvas.updateView({elements: [half], element_aspects: {geometry: true}}); Undo.finishEdit('drag');
	let unlocked = {seam_x: half.vertices[seam[0]][0], box: document.getElementById('dew_mirror_lock_box').checked}; Undo.undo();
	BarItems.dew_mirror_lock_seam.trigger(); BarItems.selection_mode.set('object'); delete Project.mesh_selection[half.uuid]; updateSelection();
	return JSON.stringify({locked, unlocked, restored: half.vertices[seam[0]][0], lock_on_again: BarItems.dew_mirror_lock_seam.value}); })()`);
check('D. with Lock Seam a seam vertex dragged across the mirror axis stays on the plane, still slides along it, and its neighbour moves freely', d.locked.seam_x === 0 && d.locked.seam_y_moved == 2 && d.locked.free_x == 7, d);
check('   with it off the same drag takes the seam vertex off the plane, and the box in the bar follows the toggle', d.unlocked.seam_x == 3 && d.unlocked.box === false && d.lock_on_again === true, d);

// E. Copy: a real element exactly where the mirror shows, the mirror gone, one undo
let e = await json(`(() => { let count = Outliner.elements.length; BarItems.dew_mirror_copy.click(); let copy = Mesh.all.find(m => m != half);
	let xs = Object.values(copy.vertices).map(v => v[0]), normals = Object.values(copy.faces).map(f => f.getNormal(true)), source = Object.values(half.faces).map(f => f.getNormal(true));
	let mirrored_normals = source.every(n => normals.some(m => Math.abs(m[0] + n[0]) < 1e-6 && Math.abs(m[1] - n[1]) < 1e-6 && Math.abs(m[2] - n[2]) < 1e-6));
	let out = {added: Outliner.elements.length - count, name: copy.name, origin: copy.origin, x_range: [Math.min(...xs), Math.max(...xs)], mirrored_normals, mirror_gone: !DEWMirror.getMirror(half), preview_gone: !half.mesh.children.find(c => c.name == 'dew_mirror') || (Preview.selected.render(), !half.mesh.children.find(c => c.name == 'dew_mirror')),
		bar: getComputedStyle(document.getElementById('dew_mirror_bar')).display, selected: Outliner.selected.map(x => x.name)};
	Undo.undo(); out.after_undo = Outliner.elements.length - count; return JSON.stringify(out); })()`);
check('E. Copy makes the mirror its own element where it showed (x 0 to -4, normals mirrored, name flipped), selects it and drops the mirror', e.added == 1 && e.name == 'fender_right' && e.x_range[0] == -4 && e.x_range[1] == 0 && e.mirrored_normals && e.mirror_gone && e.preview_gone && e.bar == 'none' && e.selected[0] == 'fender_right', e);
check('   and it is one undo', e.after_undo == 0, e);

// F. Combine: one closed box, the seam welded, the cap that lay on the plane gone
let f = await json(`(() => { half.select(); updateSelection(); DEWMirror.setMirror(half, 0); let v0 = Object.keys(half.vertices).length, f0 = Object.keys(half.faces).length;
	BarItems.dew_mirror_combine.click();
	let edges = new Map(); for (let face of Object.values(half.faces)) { let s = face.getSortedVertices(); s.forEach((a, i) => { let id = [a, s[(i + 1) % s.length]].sort().join('|'); edges.set(id, (edges.get(id) || 0) + 1); }); }
	let centre = [0, 0, 0]; let outward = Object.values(half.faces).every(face => { let n = face.getNormal(true), c = face.vertices.reduce((s, k) => s.V3_add(half.vertices[k]), [0, 0, 0]).map(v => v / face.vertices.length); return n[0] * c[0] + n[1] * c[1] + n[2] * c[2] > 0; });
	let out = {vertices: [v0, Object.keys(half.vertices).length], faces: [f0, Object.keys(half.faces).length], closed: [...edges.values()].every(n => n == 2), outward, on_plane_faces: Object.values(half.faces).filter(face => face.vertices.every(k => half.vertices[k][0] == 0)).length,
		elements: Outliner.elements.length, mirror_gone: !DEWMirror.getMirror(half)};
	Undo.undo(); out.after_undo = [Object.keys(half.vertices).length, Object.keys(half.faces).length]; return JSON.stringify(out); })()`);
check('F. Combine gives one closed box: 8 vertices became 12 (the 4 on the seam shared, not doubled), 6 faces became 10 (5 mirrored, the cap on the plane dropped)', f.vertices[1] == 12 && f.faces[1] == 10 && f.closed && f.outward && f.on_plane_faces == 0 && f.elements == 1 && f.mirror_gone, f);
check('   and it is one undo', f.after_undo[0] == 8 && f.after_undo[1] == 6, f);

// G. vertices that meet away from the plane are welded too, and a face that mirrors onto itself is not doubled
let g = await json(`(() => { let mesh = new Mesh({name: 'plate', vertices: {}, origin: [0, 0, 0]}); let k = mesh.addVertices([-2, 0, -2], [2, 0, -2], [2, 0, 2], [-2, 0, 2]); mesh.addFaces(new MeshFace(mesh, {vertices: k})); mesh.init();
	DEWMirror.setMirror(mesh, 0); let stats = DEWMirror.combineMirror(mesh); let out = {stats, vertices: Object.keys(mesh.vertices).length, faces: Object.keys(mesh.faces).length}; DEWMirror.discardMirror(mesh); mesh.remove(); return JSON.stringify(out); })()`);
check('G. a plate already symmetric across the axis gains nothing: every mirrored vertex welds to the one standing there', g.vertices == 4 && g.faces == 1 && g.stats.vertices_added == 0 && g.stats.vertices_welded == 4, g);

// H. axes: Z replaces X, Z again drops it; a cube mirrors and copies in its own frame, and Combine on a cube copies
let h = await json(`(() => { half.select(); updateSelection(); BarItems.dew_mirror_x.click(); BarItems.dew_mirror_z.click(); let axis = DEWMirror.getMirror(half).axis; Preview.selected.render();
	let scale = half.mesh.children.find(c => c.name == 'dew_mirror').scale.toArray(); BarItems.dew_mirror_z.click(); let dropped = !DEWMirror.getMirror(half);
	let cube = new Cube({name: 'arm_left', from: [6, 0, 0], to: [10, 2, 2], origin: [4, 0, 0], rotation: [0, 0, 30]}).init(); cube.select(); updateSelection();
	BarItems.dew_mirror_x.click(); BarItems.dew_mirror_combine.click(); let copy = Cube.all.find(c => c != cube);
	let out = {axis, scale, dropped, cube_copy: copy && {name: copy.name, from: copy.from, to: copy.to, origin: copy.origin, rotation: copy.rotation}}; Undo.undo(); cube.remove(); return JSON.stringify(out); })()`);
check('H. picking another axis moves the mirror there, picking it again drops it', h.axis == 2 && h.scale[2] == -1 && h.scale[0] == 1 && h.dropped, h);
check('   a rotated cube copies across its own axis about its pivot: from 6..10 to -2..2 about x 4, rotation kept', h.cube_copy && h.cube_copy.name == 'arm_right' && h.cube_copy.from[0] == -2 && h.cube_copy.to[0] == 2 && h.cube_copy.origin[0] == 4 && h.cube_copy.rotation[2] == 30, h);

// I. rigged: the mirrored half belongs to the other side's bone, and the glTF export never sees a mirror
let i = await json(`(async () => { let armature = new Armature({name: 'rig'}).init(); let root = new ArmatureBone({name: 'root', origin: [0, 0, 0], length: 2}); root.addTo(armature).init();
	let l = new ArmatureBone({name: 'arm.L', origin: [2, 0, 0], length: 4}); l.addTo(root).init(); let r = new ArmatureBone({name: 'arm.R', origin: [-2, 0, 0], length: 4}); r.addTo(root).init();
	let skin = halfBox('skin', false); skin.addTo(armature); for (let vkey in skin.vertices) (skin.vertices[vkey][0] == 0 ? root : l).setVertexWeight(skin, vkey, 1);
	skin.select(); updateSelection(); DEWMirror.setMirror(skin, 0); Preview.selected.render();
	let buffer = await Codecs.gltf.compile({encoding: 'ascii', animations: false}); let gltf = JSON.parse(buffer); let exported = (gltf.nodes || []).filter(n => n.name == 'dew_mirror').length;
	BarItems.dew_mirror_combine.click();
	let sides = {left: 0, right: 0, wrong: 0}; for (let vkey in skin.vertices) { let x = skin.vertices[vkey][0]; if (x > 0) { l.getVertexWeight(skin, vkey) == 1 ? sides.left++ : sides.wrong++; } else if (x < 0) { r.getVertexWeight(skin, vkey) == 1 ? sides.right++ : sides.wrong++; } }
	return JSON.stringify({exported, sides}); })()`);
check('I. the glTF export never contains the mirror, and a combined rigged half is weighted to the other side\'s bone', i.exported == 0 && i.sides.left == 4 && i.sides.right == 4 && i.sides.wrong == 0, i);

await sleep(200);
check('no exception was thrown on the page', errors.length == 0, errors);
console.log(`all ${passed} passed`);
ws.close();
