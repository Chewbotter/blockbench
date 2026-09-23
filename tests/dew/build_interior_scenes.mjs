// A model operation, not a test (the suite only runs cdp_*.mjs). Written 2026-09-23 for the store pack
// D:/Work/Model_source/store/interior_props (GLB/Separate_assets_glb and OBJ/Separate_assets_obj). Usage:
//   node tests/dew/run_cdp.mjs tests/dew/build_interior_scenes.mjs --isolated --fresh
// Builds four .bbmodel scenes in OUT_DIR, pieces laid out in rows by category, one outliner group per category:
//   interior_structural  glb + OBJ pairs whose category makes the building's shape (STRUCTURAL below), quads from the OBJ
//   interior_props       every other pair, quads from the OBJ
//   interior_glb_only    glbs with no OBJ, as imported (triangles)
//   interior_obj_only    OBJs with no glb, through the OBJ importer (quads, no texture)
// Pairs are matched by geometry (triangle count and sorted box size) before name, see below; the report says which.
// Writes <scene>.report.csv beside each file: per piece, polygons in the OBJ, joined, and the fit.
import fs from 'fs';
import path from 'path';

const ROOT = 'D:/Work/Model_source/store/interior_props';
const GLB_DIR = `${ROOT}/GLB/Separate_assets_glb`, OBJ_DIR = `${ROOT}/OBJ/Separate_assets_obj`;
const OUT_DIR = process.env.OUT_DIR || `${ROOT}/BBMODEL`;
const STRUCTURAL = ['Walls', 'wall', 'floor', 'Partitions', 'Stairs', 'window', 'door', 'fireplace'];
const LAYOUT = {GAP: 8, ROW_GAP: 24};	// units between pieces in a row, and between category rows
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;	// build only these scenes

const category = name => name.replace(/_[0-9]+(\.[0-9]+)?$/, '');
const glbNames = fs.readdirSync(GLB_DIR).filter(f => f.endsWith('.glb')).map(f => f.slice(0, -4)).sort();
const objNames = fs.readdirSync(OBJ_DIR).filter(f => f.endsWith('.obj')).map(f => f.slice(0, -4)).sort();
const objSet = new Set(objNames), glbSet = new Set(glbNames);

// geometry signatures for the leftovers
const sig = (tris, dims) => tris + '|' + dims.map(d => d.toFixed(2)).sort().join(',');
function glbSig(n) {
	let b = fs.readFileSync(`${GLB_DIR}/${n}.glb`), j = JSON.parse(b.slice(20, 20 + b.readUInt32LE(12)).toString());
	let t = 0, mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
	for (let m of j.meshes) for (let p of m.primitives) { let a = j.accessors[p.attributes.POSITION]; t += p.indices != null ? j.accessors[p.indices].count / 3 : a.count / 3; for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], a.min[i]); mx[i] = Math.max(mx[i], a.max[i]); } }
	return sig(t, mx.map((v, i) => v - mn[i]));
}
function objSig(n) {
	let t = 0, mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
	for (let l of fs.readFileSync(`${OBJ_DIR}/${n}.obj`, 'utf8').split(/\r?\n/)) {
		if (l.startsWith('v ')) { let p = l.trim().split(/\s+/).slice(1, 4).map(Number); for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], p[i]); mx[i] = Math.max(mx[i], p[i]); } }
		else if (l.startsWith('f ')) t += l.trim().split(/\s+/).length - 3;
	}
	return sig(t, mx.map((v, i) => v - mn[i]));
}
// Pairing trusts geometry first: in some categories the pack numbers its two folders differently, so the OBJ with the
// same name can be a different model (Curtains_025.glb is 3.3 m and 228 triangles, Curtains_025.obj 1.5 m and 104).
//   1. same name and same signature: a pair
//   2. an unused OBJ with the same signature, same category first: a pair by geometry (the renamed lamps, and more)
//   3. an unused OBJ of the same name whose geometry differs: kept as a pair, flagged 'name only (geometry differs)'; the
//      conversion then joins what really matches and reports the rest
const glbSigs = new Map(glbNames.map(n => [n, glbSig(n)])), objSigs = new Map(objNames.map(n => [n, objSig(n)]));
const objBySig = new Map();
for (let [n, s] of objSigs) { if (!objBySig.has(s)) objBySig.set(s, []); objBySig.get(s).push(n); }
const usedObj = new Set(), pairOf = new Map();
for (let n of glbNames) if (objSigs.get(n) === glbSigs.get(n)) { pairOf.set(n, {glb: n, obj: n, by: 'name'}); usedObj.add(n); }
for (let n of glbNames) {
	if (pairOf.has(n)) continue;
	let candidates = (objBySig.get(glbSigs.get(n)) || []).filter(o => !usedObj.has(o));
	let pick = candidates.find(o => category(o) == category(n)) || candidates[0];
	if (pick) { pairOf.set(n, {glb: n, obj: pick, by: 'geometry'}); usedObj.add(pick); }
}
for (let n of glbNames) if (!pairOf.has(n) && objSet.has(n) && !usedObj.has(n)) { pairOf.set(n, {glb: n, obj: n, by: 'name only (geometry differs)'}); usedObj.add(n); }
const pairs = glbNames.filter(n => pairOf.has(n)).map(n => pairOf.get(n));
const glbOnly = glbNames.filter(n => !pairOf.has(n)), objOnly = objNames.filter(n => !usedObj.has(n));
const geoPairs = pairs.filter(p => p.by == 'geometry');
const isStructural = name => STRUCTURAL.includes(category(name));
const scenes = [
	{name: 'interior_structural', items: pairs.filter(p => isStructural(p.glb))},
	{name: 'interior_props', items: pairs.filter(p => !isStructural(p.glb))},
	{name: 'interior_glb_only', items: glbOnly.map(n => ({glb: n}))},
	{name: 'interior_obj_only', items: objOnly.map(n => ({obj: n}))},
].filter(s => !ONLY || ONLY.includes(s.name));
console.log(`pairs: ${pairs.filter(p => p.by == 'name').length} by name and geometry, ${geoPairs.length} by geometry under another name, ${pairs.filter(p => p.by.includes('differs')).length} by name only (geometry differs); glb only ${glbOnly.length}, obj only ${objOnly.length}`);
fs.mkdirSync(OUT_DIR, {recursive: true});

const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find(t => t.type == 'page' && t.url.includes('index.html')) ?? targets.find(t => t.type == 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.method == 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (!r.result) throw new Error('CDP: ' + JSON.stringify(r.error || r).slice(0, 300)); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text); return r.result.result.value; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// A long awaited call can fail with "Promise was collected": the debugger holds only a weak reference to the pending
// promise, and a garbage collection at the wrong moment drops it (it struck at a different piece on every run). So a
// piece is started with its result parked on window, and polled for.
const evAsync = async (expr) => {
	await ev(`(() => { window.__res = null; (${expr}).then(v => window.__res = {ok: v}, e => window.__res = {err: String(e && e.stack || e)}); return true; })()`);
	for (;;) {
		let r = await ev(`window.__res && JSON.stringify(window.__res)`);
		if (r) { r = JSON.parse(r); if (r.err) throw new Error(r.err); return r.ok; }
		await sleep(5);
	}
};
for (let i = 0; i < 40; i++) { if (await ev('typeof Blockbench != "undefined" && !!window.Preview && Preview.all.length > 0')) break; await sleep(500); }
await send('Runtime.enable');

// page helpers: batch mode holds the whole-scene redraws, the palette texture is shared, one piece is added at a time
await ev(`(() => {
	window.__batch = {updateAll: Canvas.updateAll, updateSelection: window.updateSelection, message: Blockbench.showQuickMessage};
	window.batchOn = () => { Canvas.updateAll = () => {}; window.updateSelection = () => {}; Blockbench.showQuickMessage = () => {}; };
	window.batchOff = () => { Canvas.updateAll = __batch.updateAll; window.updateSelection = __batch.updateSelection; Blockbench.showQuickMessage = __batch.message; };
	// the glTF loader now and then never settles (a texture decode that does not call back); the page then drops the
	// pending promise and the whole call fails. Each import is held on window, raced against a timeout and retried.
	window.importWithRetry = async (path) => {
		for (let attempt = 1; attempt <= 3; attempt++) {
			let before = new Set(Mesh.all);
			window.__import = DEWRig.importRig(path);
			let done = await Promise.race([window.__import.then(() => true), new Promise(r => setTimeout(() => r(false), 15000))]);
			if (done) return attempt;
			Mesh.all.filter(m => !before.has(m)).forEach(m => m.remove());	// a half-finished import is thrown away
			window.__stalls = (window.__stalls || 0) + 1;
		}
		throw new Error('import stalled three times: ' + path);
	};
	window.shareTextures = (meshes) => {	// a texture identical to an earlier one is replaced by it; only the new meshes use it
		let seen = new Map(), dropped = 0;
		for (let t of Texture.all.slice()) {
			let key = t.source || t.img?.src; let first = seen.get(key);
			if (!first) { seen.set(key, t); continue; }
			for (let m of meshes) for (let f of Object.values(m.faces)) if (f.texture == t.uuid) f.texture = first.uuid;
			t.remove(true); dropped++;
		}
		return dropped;
	};
	return true;
})()`);

for (let scene of scenes) {
	let t0 = Date.now();
	await ev(`(() => { newProject(Formats.free); Project.name = ${JSON.stringify(scene.name)}; Modes.options.edit.select(); batchOn(); window.__groups = {}; return true; })()`);
	let rows = ['piece,obj,matched_by,category,triangles_in,obj_polygons,joined,kept_triangles_reason,fit'];
	for (let [i, item] of scene.items.entries()) {
		let cat = category(item.glb || item.obj);
		let glbPath = item.glb && `${GLB_DIR}/${item.glb}.glb`;
		let objText = item.obj ? fs.readFileSync(`${OBJ_DIR}/${item.obj}.obj`, 'utf8') : null;
		// an OBJ imported on its own is turned Y up the way this pack's glbs are (the reference fit found +x -z +y on every
		// pair); positions and normals alike, a proper rotation, so the winding the importer reads from the normals holds
		if (objText && !item.glb) objText = objText.split(/\r?\n/).map(l => {
			let m = l.match(/^(vn?)\s+(\S+)\s+(\S+)\s+(\S+)/);
			return m ? `${m[1]} ${m[2]} ${-parseFloat(m[4])} ${m[3]}` : l;
		}).join('\n');
		let r; try { r = JSON.parse(await evAsync(`(async () => {
			let before = new Set(Mesh.all);
			${item.glb ? `await importWithRetry(${JSON.stringify(glbPath)});` : `BarItems.import_obj.click(); let d = Dialog.open; d.onConfirm({obj: {content: ${JSON.stringify(objText)}}, scale: 16}); d.hide();`}
			let meshes = Mesh.all.filter(m => !before.has(m));
			let name = ${JSON.stringify(item.glb || item.obj)};
			meshes.forEach((m, k) => m.name = meshes.length > 1 ? name + '_' + (k + 1) : name);
			let tris = meshes.reduce((n, m) => n + Object.values(m.faces).reduce((a, f) => a + f.vertices.length - 2, 0), 0);
			let report = null;
			${item.glb && item.obj ? `report = DEWQuads.quadsFromOBJ(meshes, ${JSON.stringify(objText)});` : ''}
			let cat = ${JSON.stringify(cat)};
			let group = __groups[cat] || (__groups[cat] = new Group({name: cat}).addTo('root').init());
			meshes.forEach(m => m.addTo(group));
			shareTextures(meshes);
			Undo.history.length = 0; Undo.index = 0;	// a batch build has nothing to undo, and every entry holds a full copy of a mesh
			return JSON.stringify({meshes: meshes.length, tris, report});
		})()`)); } catch (e) { console.log(`FAILED on ${item.glb || item.obj} (${i + 1}/${scene.items.length}): ${e.message}`); throw e; }
		let rep = r.report;
		let reason = rep ? ['unmatched_corner', 'triangles_missing', 'seam_or_texture', 'diagonal'].filter(k => rep[k]).map(k => `${k} ${rep[k]}`).join(' ') : '';
		rows.push([item.glb || item.obj, item.obj || '', item.by || '', cat, r.tris, rep ? rep.polygons : '', rep ? rep.joined : '', reason, rep && rep.fit ? `${rep.fit.axes} x${rep.fit.scale}` : ''].join(','));
		if ((i + 1) % 100 == 0) console.log(`  ${scene.name}: ${i + 1}/${scene.items.length}`);
	}
	// layout: one row per category along X, rows stacked along Z, every piece standing on y 0
	let layout = JSON.parse(await ev(`(() => {
		let z = 0, rows = 0;
		for (let group of Group.all.filter(g => g.parent == 'root').sort((a, b) => a.name.localeCompare(b.name))) {
			let x = 0, depth = 0;
			for (let m of group.children.filter(c => c instanceof Mesh)) {
				let vs = Object.values(m.vertices); if (!vs.length) continue;
				let mn = [0, 1, 2].map(i => Math.min(...vs.map(v => v[i]))), mx = [0, 1, 2].map(i => Math.max(...vs.map(v => v[i])));
				m.origin = [x - mn[0], -mn[1], z - mn[2]];
				x += (mx[0] - mn[0]) + ${LAYOUT.GAP};
				depth = Math.max(depth, mx[2] - mn[2]);
			}
			z += depth + ${LAYOUT.ROW_GAP}; rows++;
		}
		batchOff(); Canvas.updateAll();
		return JSON.stringify({rows, meshes: Mesh.all.length, textures: Texture.all.length, triangles: Mesh.all.reduce((n, m) => n + Object.values(m.faces).reduce((a, f) => a + f.vertices.length - 2, 0), 0)});
	})()`));
	let compiled = await ev(`Codecs.project.compile()`);
	fs.writeFileSync(`${OUT_DIR}/${scene.name}.bbmodel`, compiled);
	fs.writeFileSync(`${OUT_DIR}/${scene.name}.report.csv`, rows.join('\n') + '\n');
	let joinedRows = rows.slice(1).map(r => r.split(','));
	let full = joinedRows.filter(r => r[5] !== '' && r[5] == r[6]).length, partial = joinedRows.filter(r => r[5] !== '' && r[5] != r[6]).length;
	console.log(`${scene.name}: ${scene.items.length} pieces, ${layout.meshes} meshes, ${layout.triangles} triangles, ${layout.textures} texture(s), ${layout.rows} category rows, ${(compiled.length / 1e6).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s` + (scene.items[0]?.obj && scene.items[0]?.glb ? `; OBJ polygons all joined on ${full}, partly on ${partial}` : ''));
}
console.log('import stalls retried:', await ev('window.__stalls || 0'));
console.log('page errors:', errors.length ? errors.slice(0, 5) : 'none');
ws.close();
