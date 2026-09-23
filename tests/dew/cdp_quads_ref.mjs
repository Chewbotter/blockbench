// Quads from OBJ Reference: a triangulated mesh (as a glb import leaves it) gets its quads and n-gons back from an OBJ
// of the same asset, matched by position after fitting units and offset; uvs, texture and winding kept; polygons the
// mesh cannot honour are counted and left as triangles; one undo entry. Then, with Blender present, the real round
// trip: an OBJ with quads goes through Blender to a glb, the glb is opened in the fork and the OBJ puts the quads back.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
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

// The asset, in metres: a 2 x 1 grid of quads on the ground (6 corners), a hexagon, a quad the mesh will carry with a
// uv seam through it, and a quad whose corners the mesh does not have. The mesh version is the same thing at 16 units
// per metre, shifted by (5, 0, -3), triangulated with each vertex duplicated per face as an importer leaves it.
const P = {
	grid: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 0, 1], [1, 0, 1], [2, 0, 1]],
	hex: [...Array(6)].map((_, i) => [4 + Math.cos(i / 6 * Math.PI * 2), 0, 1 + Math.sin(i / 6 * Math.PI * 2)]),
	seam: [[7, 0, 0], [8, 0, 0], [8, 0, 1], [7, 0, 1]],
	ghost: [[10, 0, 0], [11, 0, 0], [11, 0, 1], [10, 0, 1]],
};
const all = [...P.grid, ...P.hex, ...P.seam, ...P.ghost];
const idx = (list, i) => all.indexOf(list[i]) + 1;
const obj = [
	...all.map(v => `v ${v[0]} ${v[1]} ${v[2]}`),
	`f ${idx(P.grid, 0)} ${idx(P.grid, 1)} ${idx(P.grid, 4)} ${idx(P.grid, 3)}`,
	`f ${idx(P.grid, 1)} ${idx(P.grid, 2)} ${idx(P.grid, 5)} ${idx(P.grid, 4)}`,
	'f ' + P.hex.map((_, i) => idx(P.hex, i)).join(' '),
	'f ' + P.seam.map((_, i) => idx(P.seam, i)).join(' '),
	'f ' + P.ghost.map((_, i) => idx(P.ghost, i)).join(' '),
].join('\n');
// mesh triangles: grid quads split on their 0-2 diagonal, the hexagon as a strip (NOT a fan from corner 0), the seam quad
// with different uvs on its two halves; the ghost quad absent
const tri = (pts, uv) => ({pts, uv});
const T = [
	tri([P.grid[0], P.grid[1], P.grid[4]], [[0, 0], [16, 0], [16, 16]]), tri([P.grid[0], P.grid[4], P.grid[3]], [[0, 0], [16, 16], [0, 16]]),
	tri([P.grid[1], P.grid[2], P.grid[5]], [[16, 0], [32, 0], [32, 16]]), tri([P.grid[1], P.grid[5], P.grid[4]], [[16, 0], [32, 16], [16, 16]]),
	tri([P.hex[0], P.hex[1], P.hex[5]], [[40, 0], [48, 0], [40, 8]]), tri([P.hex[1], P.hex[2], P.hex[5]], [[48, 0], [56, 0], [40, 8]]),
	tri([P.hex[2], P.hex[4], P.hex[5]], [[56, 0], [48, 8], [40, 8]]), tri([P.hex[2], P.hex[3], P.hex[4]], [[56, 0], [56, 8], [48, 8]]),
	tri([P.seam[0], P.seam[1], P.seam[2]], [[0, 32], [16, 32], [16, 48]]), tri([P.seam[0], P.seam[2], P.seam[3]], [[64, 64], [80, 80], [64, 80]]),
];
const S = 16, O = [5, 0, -3];
const built = await json(`(() => {
	newProject(Formats.free); Modes.options.edit.select();
	let tex = new Texture({name: 'tex'}).fromDataURL(document.createElement('canvas').toDataURL()).add(false);
	let mesh = new Mesh({name: 'asset', vertices: {}});
	for (let t of ${JSON.stringify(T)}) {
		let keys = mesh.addVertices(...t.pts.map(p => [p[0] * ${S} + ${O[0]}, p[1] * ${S} + ${O[1]}, p[2] * ${S} + ${O[2]}]));
		mesh.addFaces(new MeshFace(mesh, {vertices: keys, uv: Object.fromEntries(keys.map((k, i) => [k, t.uv[i]])), texture: tex.uuid}));
	}
	for (let f of Object.values(mesh.faces)) if (f.getNormal()[1] < 0) f.vertices.reverse();	// every triangle faces up, whatever order it was typed in
	mesh.init(); mesh.select(); Canvas.updateAll();
	window.rig = {mesh, tex};
	window.normals = () => Object.fromEntries(Object.entries(rig.mesh.faces).map(([k, f]) => [k, new THREE.Vector3().fromArray(f.getNormal()).normalize().y > 0]));
	return JSON.stringify({faces: Object.keys(mesh.faces).length, vertices: Object.keys(mesh.vertices).length, up: Object.values(normals()).every(Boolean)});
})()`);
check('setup: 10 triangles, 30 split vertices, all facing up', built.faces == 10 && built.vertices == 30 && built.up, built);

const r = await json(`(() => { let report = DEWQuads.quadsFromOBJ([rig.mesh], ${JSON.stringify(obj)}); let faces = Object.values(rig.mesh.faces);
	let sizes = faces.map(f => f.vertices.length).sort(); let up = Object.values(normals()).every(Boolean);
	let quads = faces.filter(f => f.vertices.length == 4); let uv_kept = quads.every(f => f.vertices.every(v => f.uv[v] && f.uv[v].length == 2)) && faces.every(f => f.texture == rig.tex.uuid);
	// the first grid quad's uvs are the ones its two triangles carried
	let g0 = quads.find(f => f.vertices.every(v => rig.mesh.vertices[v][0] <= ${S + O[0]} + 1e-6 && rig.mesh.vertices[v][2] < ${S + O[2]} + 1e-6 && rig.mesh.vertices[v][0] >= ${O[0]} - 1e-6));
	let g0_uvs = g0 && g0.vertices.map(v => [rig.mesh.vertices[v][0], rig.mesh.vertices[v][2], ...g0.uv[v]]);
	return JSON.stringify({report, sizes, up, uv_kept, vertices: Object.keys(rig.mesh.vertices).length, g0_uvs, undo: Undo.history[Undo.history.length - 1]?.action}); })()`);
check('A. the two grid quads and the hexagon (as two quads) are rebuilt; the seam quad and the ghost stay out', r.report.joined == 3 && r.report.polygons == 5 && r.report.faces_made == 4 && JSON.stringify(r.sizes) == '[3,3,4,4,4,4]', r);
check('   the report says why: one uv seam, one polygon with no matching corners', r.report.seam_or_texture == 1 && r.report.unmatched_corner == 1 && r.report.triangles_missing == 0 && r.report.diagonal == 0, r.report);
check('   the mesh was welded first (30 split vertices to 16), and units and offset were fitted', r.report.welded == 14 && r.vertices == 16, r);
check('   every rebuilt face faces the way its triangles did, keeps the texture and a uv per corner', r.up && r.uv_kept, r);
check('   the grid quad carries its triangles\' uvs: (x, z) to (u, v) is the 16 per metre mapping', r.g0_uvs && r.g0_uvs.every(([x, z, u, v]) => Math.abs((x - O[0]) - u) < 1e-6 && Math.abs((z - O[2]) - v) < 1e-6), r.g0_uvs);
check('   one undo entry', r.undo == 'Quads from OBJ reference', r);
const u = await json(`(() => { Undo.undo(); let a = Object.values(rig.mesh.faces).map(f => f.vertices.length).sort(); Undo.redo(); let b = Object.values(rig.mesh.faces).map(f => f.vertices.length).sort(); return JSON.stringify({a, b}); })()`);
check('   undo gives the ten triangles back (the weld is part of the entry), redo the quads', u.a.length == 10 && u.a.every(n => n == 3) && JSON.stringify(u.b) == '[3,3,4,4,4,4]', u);

// B. a second run finds nothing left to do and changes nothing
const again = await json(`(() => { let before = JSON.stringify(Object.values(rig.mesh.faces).map(f => f.vertices.length).sort()); let report = DEWQuads.quadsFromOBJ([rig.mesh], ${JSON.stringify(obj)}); return JSON.stringify({report, same: before == JSON.stringify(Object.values(rig.mesh.faces).map(f => f.vertices.length).sort())}); })()`);
check('B. run again, the joined polygons no longer have triangles to gather and nothing changes', again.report.joined == 0 && again.same, again);

// C. the real round trip through Blender: OBJ (quads, a 7-gon) -> glb -> opened in the fork -> quads back from the OBJ
const blender = 'D:/Blender 5.2/blender.exe';
if (fs.existsSync(blender)) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dew_quads_ref_'));
	const hept = [...Array(7)].map((_, i) => [Math.cos(i / 7 * Math.PI * 2), 2, Math.sin(i / 7 * Math.PI * 2)]);
	const box = [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1], [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]];
	const src = [
		'o piece', ...box.map(v => `v ${v.join(' ')}`), ...hept.map(v => `v ${v.join(' ')}`),
		'vt 0 0', 'vt 1 0', 'vt 1 1', 'vt 0 1',
		'f 1/1 2/2 6/3 5/4', 'f 2/1 3/2 7/3 6/4', 'f 3/1 4/2 8/3 7/4', 'f 4/1 1/2 5/3 8/4', 'f 5/1 6/2 7/3 8/4', 'f 4/1 3/2 2/3 1/4',
		'f ' + hept.map((_, i) => `${9 + i}/1`).join(' '),
	].join('\n');
	const obj_path = path.join(dir, 'piece.obj'), glb_path = path.join(dir, 'piece.glb');
	fs.writeFileSync(obj_path, src);
	const py = path.join(dir, 'convert.py');
	fs.writeFileSync(py, `import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.wm.obj_import(filepath=${JSON.stringify(obj_path)})\nbpy.ops.export_scene.gltf(filepath=${JSON.stringify(glb_path)}, export_format='GLB', export_apply=True)\n`);
	execFileSync(blender, ['-b', '--python', py], {stdio: 'ignore', timeout: 120000});
	check('C1. Blender turned the OBJ into a glb', fs.existsSync(glb_path), {glb_path});
	await ev(`(() => { loadModelFile({content: null, path: ${JSON.stringify(glb_path)}}); return true; })()`);
	await sleep(2500);
	const c = await json(`(() => { let mesh = Mesh.all[0]; if (!mesh) return JSON.stringify({no_mesh: true}); Modes.options.edit.select(); unselectAllElements(); mesh.select(); updateSelection();
		let before = Object.values(mesh.faces).map(f => f.vertices.length); let report = DEWQuads.quadsFromOBJ([mesh], ${JSON.stringify(src)}); let after = Object.values(mesh.faces).map(f => f.vertices.length).sort();
		return JSON.stringify({project: Project.name, before_all_tris: before.every(n => n == 3), before_count: before.length, report, after}); })()`);
	check('C2. the glb opened as triangles (12 for the box, 5 for the 7-gon)', !c.no_mesh && c.before_all_tris && c.before_count == 17, c);
	check('C3. the OBJ put every polygon back: 6 quads and the 7-gon as quad, quad, triangle', c.report.joined == 7 && c.report.polygons == 7 && JSON.stringify(c.after) == '[3,4,4,4,4,4,4,4,4]', c);
	fs.rmSync(dir, {recursive: true, force: true});
} else {
	console.log('SKIP C: Blender not found at ' + blender);
}

await sleep(200);
check('no exception was thrown on the page', errors.length == 0, errors);
console.log(`all ${passed} passed`);
