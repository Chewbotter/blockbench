// Port smoke test: the upstream side of the merge. The rest of the suite proves the fork's tools; this proves that
// upstream's release is all there beside them and that the stock workflows run without throwing: version, the
// actions that release added, the fork's own actions, every format making a project, every mode entered, and a
// bbmodel round trip. After taking in a new upstream release, put its new action ids in UPSTREAM_NEW.
import assert from 'assert';
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
let passed = 0;
const check = (name, ok, detail) => { assert.ok(ok, name + (detail !== undefined ? ': ' + JSON.stringify(detail) : '')); console.log('PASS', name); passed++; };

const UPSTREAM_VERSION = '5.2';
const UPSTREAM_NEW = ['brush_lock_mode', 'close_other_projects', 'close_projects_to_right', 'create_layer_group', 'create_variable_placeholder',
	'experimental_settings', 'export_blockmodel', 'export_class_entity', 'export_image', 'extrude_texture_to_model', 'flip_in_place_x',
	'flip_in_place_y', 'flip_in_place_z', 'image_editor_checkerboard', 'keyframe_select_after_playhead', 'keyframe_select_before_playhead',
	'origin_slider_direct_values', 'position_slider_per_element', 'preview_models', 'resolve_layer_group', 'screen_space_brush_projection',
	'set_ik_pole', 'slider_brush_aspect_ratio', 'view_built_in_variables'];	// slider_reference_image_opacity is made on demand
const FORK = ['dew_cage', 'dew_tile_select', 'dew_whole_block', 'dew_tile_brush', 'dew_shave', 'dew_ramp', 'dew_terrain', 'dew_material_brush',
	'dew_texture_brush', 'dew_paint_bucket', 'turn_edges_tool', 'dew_edge_boundary', 'dew_merge_triangles', 'dew_import_rig', 'dew_export_poses',
	'dew_xray', 'dew_select_linked', 'dew_separate_loose_parts', 'split_closed_mesh', 'dew_add_block', 'dew_prop_snap'];

let version = await ev('Blockbench.version');
check('runs upstream ' + UPSTREAM_VERSION, version.startsWith(UPSTREAM_VERSION), version);
let missing_upstream = await ev(`JSON.stringify(${JSON.stringify(UPSTREAM_NEW)}.filter(id => !BarItems[id]))`);
check('every action the release added is defined', missing_upstream == '[]', missing_upstream);
let missing_fork = await ev(`JSON.stringify(${JSON.stringify(FORK)}.filter(id => !BarItems[id]))`);
check('every fork action is defined beside them', missing_fork == '[]', missing_fork);
check('DEW Scene format and the rig codec are registered', await ev('!!Formats.dew_scene && !!Codecs.dew_gltf'));

// Every format that can make a new project makes one, takes a cube or a mesh, and compiles its codec
let formats = JSON.parse(await ev(`(async () => {
	let out = [];
	for (let id in Formats) {
		let format = Formats[id];
		if (format.new === false || !Condition(format.condition)) continue;
		let row = {id};
		try {
			row.created = newProject(format) !== false && Format == format;
			if (row.created) {
				if (format.meshes) { let m = new Mesh({name: 'smoke'}); m.init(); row.element = 'mesh'; }
				else { let c = new Cube({name: 'smoke', from: [0, 0, 0], to: [4, 4, 4]}); c.init(); row.element = 'cube'; }
				Canvas.updateAll();
				Preview.selected.render();
				if (format.codec && format.codec.compile && format.codec.id != 'image') {
					let result = format.codec.compile();
					if (result instanceof Promise) result = await result;
					row.compiled = result !== undefined && result !== null;
				}
			}
		} catch (err) { row.error = String(err && err.stack || err).slice(0, 300); }
		out.push(row);
	}
	return JSON.stringify(out);
})()`));
let broken = formats.filter(row => row.error || !row.created);
console.log('   formats tried:', formats.map(row => row.id).join(' '));
check('every format creates a project and compiles', broken.length == 0, broken);

// Every mode that the generic format allows is entered and left again
let modes = JSON.parse(await ev(`(async () => {
	newProject(Formats.free);
	let cube = new Cube({name: 'smoke', from: [0, 0, 0], to: [8, 8, 8]}); cube.init();
	let mesh = new Mesh({name: 'smoke_mesh'}); mesh.init();
	let out = [];
	for (let id in Modes.options) {
		let mode = Modes.options[id];
		if (!Condition(mode.condition)) continue;
		let row = {id};
		try { mode.select(); Preview.selected.render(); row.selected = Mode.selected == mode; } catch (err) { row.error = String(err && err.stack || err).slice(0, 300); }
		out.push(row);
	}
	Modes.options.edit.select();
	return JSON.stringify(out);
})()`));
console.log('   modes entered:', modes.map(row => row.id).join(' '));
check('every mode can be entered', modes.every(row => row.selected && !row.error), modes.filter(row => !row.selected || row.error));

// A bbmodel written by this build reads back the same, fork tags and meshes included
let trip = JSON.parse(await ev(`(() => {
	newProject(Formats.free);
	let cube = new Cube({name: 'tagged', from: [0, 0, 0], to: [8, 4, 8]}); cube.game = {material: 'brick'}; cube.init();
	let mesh = new Mesh({name: 'quad', vertices: {}});
	let keys = mesh.addVertices([0, 0, 0], [8, 0, 0], [8, 0, 8], [0, 0, 8]);
	mesh.addFaces(new MeshFace(mesh, {vertices: keys})); mesh.init();
	let text = Codecs.project.compile();
	let model = JSON.parse(text);
	newProject(Formats.free);
	Codecs.project.parse(model, '');
	let cube2 = Cube.all.find(c => c.name == 'tagged'), mesh2 = Mesh.all.find(m => m.name == 'quad');
	return JSON.stringify({format_version: model.meta.format_version, cube: !!cube2, material: cube2 && cube2.game && cube2.game.material,
		mesh_faces: mesh2 ? Object.keys(mesh2.faces).length : -1, mesh_vertices: mesh2 ? Object.keys(mesh2.vertices).length : -1});
})()`));
check('bbmodel round trip keeps cubes, game tags and meshes', trip.cube && trip.material == 'brick' && trip.mesh_faces == 1 && trip.mesh_vertices == 4, trip);

// Undo and redo across a stock edit with the fork's lean undo copies in place
let undo = JSON.parse(await ev(`(() => {
	let mesh = Mesh.all.find(m => m.name == 'quad');
	mesh.select();
	Undo.initEdit({elements: [mesh]});
	for (let vkey in mesh.vertices) mesh.vertices[vkey][1] += 5;
	Undo.finishEdit('smoke move');
	let moved = Object.values(mesh.vertices)[0][1];
	Undo.undo(); let undone = Object.values(mesh.vertices)[0][1];
	Undo.redo(); let redone = Object.values(mesh.vertices)[0][1];
	return JSON.stringify({moved, undone, redone});
})()`));
check('undo and redo restore a mesh edit', undo.moved == 5 && undo.undone == 0 && undo.redone == 5, undo);

await sleep(300);
check('no exception was thrown on the page', errors.length == 0, errors);
console.log(`all ${passed} passed`);
ws.close();
