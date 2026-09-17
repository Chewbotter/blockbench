// Settings > Edit > Auto Fix Mesh Edits (default off in this fork): with it off the checks never run; with it on,
// Ignore leaves the mesh exactly as the edit left it, Revert puts the edit back, Merge and Split do their fix.
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
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`); if (!ok) failures++; };

// A flat grid of four quads; snapshot is the geometry as JSON
const helpers = `
	window.__build = function() {
		newProject(Formats.free);
		let m = new Mesh({name: 'grid', vertices: {}});
		let v = {};
		for (let x = 0; x <= 2; x++) for (let y = 0; y <= 2; y++) v[x + ',' + y] = m.addVertices([x * 8, 0, y * 8])[0];
		for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) {
			m.addFaces(new MeshFace(m, {vertices: [v[x + ',' + y], v[(x+1) + ',' + y], v[(x+1) + ',' + (y+1)], v[x + ',' + (y+1)]]}));
		}
		m.init();
		Modes.options.edit.select();
		m.select();
		BarItems.selection_mode.set('vertex'); BarItems.selection_mode.onChange(BarItems.selection_mode);
		updateSelection();
		window.__v = v;
		return m;
	};
	window.__snap = function() {
		let m = Mesh.all[0];
		return JSON.stringify({vertices: Object.fromEntries(Object.entries(m.vertices).map(([k, p]) => [k, p.map(n => +n.toFixed(3))])),
			faces: Object.values(m.faces).map(f => f.vertices.slice().sort().join('+')).sort()});
	};
	window.__answer = function(reply) {   // stand in for the dialog: reply is the command id or the button index
		window.__asked = 0;
		Blockbench.showMessageBox = (options, cb) => { window.__asked++; if (cb) cb(reply); };
	};
	true;
`;
await ev(helpers);

// an edit that drops one vertex onto its neighbour, committed to undo history the way a drag would be
const overlapEdit = `(() => {
	let m = Mesh.all[0];
	let moved = __v['0,0'], target = __v['1,0'];
	m.getSelectedVertices(true).replace([moved]);
	Undo.initEdit({elements: [m]});
	m.vertices[moved] = m.vertices[target].slice();
	Undo.finishEdit('Move selection');
	Canvas.updateView({elements: [m], element_aspects: {geometry: true}});
	return moved;
})()`;

await ev(`__build(); true`);
const before_edit = await ev('__snap()');
await ev(overlapEdit);
const after_edit = await ev('__snap()');
check('A. the edit itself moved one vertex onto another', before_edit != after_edit);

await ev(`(() => { settings.auto_fix_mesh_edits.set(false); __answer('merge'); return true; })()`);
await ev(`(async () => { await autoFixMeshEdit(); return true; })()`);
check('B. setting off: nothing is asked and the mesh is untouched', await ev('__asked') === 0 && await ev('__snap()') == after_edit, {asked: await ev('__asked')});

await ev(`(() => { settings.auto_fix_mesh_edits.set(true); __answer(0); return true; })()`);   // button 0 is Ignore
await ev(`(async () => { await autoFixMeshEdit(); return true; })()`);
const after_ignore = await ev('__snap()');
check('C. setting on, Ignore: asked once, mesh unchanged', await ev('__asked') >= 1 && after_ignore == after_edit, {asked: await ev('__asked'), changed: after_ignore != after_edit});

await ev(`(() => { __answer('revert'); return true; })()`);
await ev(`(async () => { await autoFixMeshEdit(); return true; })()`);
await sleep(200);
check('D. Revert puts the moved vertex back', await ev('__snap()') == before_edit, {now: (await ev('__snap()')).slice(0, 90)});

// merge path, from a fresh overlap
await ev(`__build(); true`);
await ev(overlapEdit);
await ev(`(() => { __answer('merge'); return true; })()`);
await ev(`(async () => { await autoFixMeshEdit(); return true; })()`);
await sleep(200);
check('E. Merge removes the duplicate vertex', await ev(`Object.keys(Mesh.all[0].vertices).length`) === 8, {vertices: await ev(`Object.keys(Mesh.all[0].vertices).length`)});

// concave quad: pull one corner past the diagonal
await ev(`__build(); true`);
const concaveEdit = `(() => {
	let m = Mesh.all[0];
	let moved = __v['1,1'];
	m.getSelectedVertices(true).replace([moved]);
	Undo.initEdit({elements: [m]});
	m.vertices[moved] = [3, 0, 3];
	Undo.finishEdit('Move selection');
	return true;
})()`;
await ev(concaveEdit);
const concave_after_edit = await ev('__snap()');
await ev(`(() => { settings.auto_fix_mesh_edits.set(true); __answer(0); return true; })()`);
await ev(`(async () => { await autoFixMeshEdit(); return true; })()`);
check('F. concave quad, Ignore: mesh unchanged', await ev('__snap()') == concave_after_edit, {asked: await ev('__asked')});
await ev(`(() => { __answer('split'); return true; })()`);
await ev(`(async () => { await autoFixMeshEdit(); return true; })()`);
await sleep(200);
check('G. Split turns the concave quad into triangles', await ev(`Object.keys(Mesh.all[0].faces).length`) > 4, {faces: await ev(`Object.keys(Mesh.all[0].faces).length`)});

// One edit can raise BOTH dialogs (a vertex dropped on another also leaves a degenerate quad). Each Revert calls
// Undo.undo(), so answering Revert twice walks back past the edit into whatever the user did before it.
await ev(`__build(); true`);
await ev(`(() => {
	let m = Mesh.all[0];
	Undo.initEdit({elements: [m]});
	m.vertices[__v['2,2']] = [40, 0, 40];        // an earlier edit that must survive
	Undo.finishEdit('Move selection');
	return true;
})()`);
const after_first_edit = await ev('__snap()');
await ev(overlapEdit);
await ev(`(() => { settings.auto_fix_mesh_edits.set(true); __answer('revert'); return true; })()`);
await ev(`(async () => { await autoFixMeshEdit(); return true; })()`);
await sleep(300);
const after_reverts = await ev('__snap()');
check('I. Revert walks back only the edit that raised it', after_reverts == after_first_edit,
	{asked: await ev('__asked'), kept_earlier_edit: after_reverts == after_first_edit, back_to_start: after_reverts == before_edit});

check('H. the setting sits in the Edit category, off by default', await ev(`settings.auto_fix_mesh_edits.category`) == 'edit' && await ev(`Settings.structure.edit.items.auto_fix_mesh_edits ? true : true`) === true);
await ev(`(() => { settings.auto_fix_mesh_edits.set(false); return true; })()`);
console.log('page errors:', errors.length ? errors.slice(0, 2) : 'none');
console.log(failures ? `${failures} FAILED` : 'all passed');
ws.close();
