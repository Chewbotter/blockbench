// Tidies the vertex placement on the front of the soldier's arms between the armpit and the upper forearm, without
// changing topology or shape. The arm is a straight line since the A-pose bake, so the patch is worked in the arm's own
// frame: t along the arm, theta around it (0 at the front), r out from it.
//   - lines running down the arm are straightened (a vertex's theta moves to the mean of its neighbours ALONG the arm)
//   - rings across the arm are squared up (a vertex's t moves to the mean of its neighbours ACROSS the arm)
//   - a little plain smoothing evens the spacing
//   - every moved vertex is put back on the ORIGINAL surface (ray from the arm's axis), so the silhouette is kept
//   - the rim of the patch is pinned, so it meets the untouched mesh exactly
//   - weights are re-sampled from the original surface at the new spot, so the bends stay what they were; checked by
//     posing both versions and measuring how far the new vertices sit from the old deformed surface
//   - left side worked, right side mirrored from it (positions, and weights with .L and .R swapped)
// Usage as bake_rest_pose.mjs: PROBE_FILE, OUT_FILE, SHOT_DIR. RELAX below holds the knobs.
import fs from 'fs';
const file = process.env.PROBE_FILE, out_file = process.env.OUT_FILE, shots = process.env.SHOT_DIR;
const RELAX = {
	T_START: 0.8,			// units down the arm from the shoulder joint where the patch begins
	FOREARM_FRACTION: 0.4,	// how far past the elbow it runs, as a fraction of the forearm
	R_MAX: 4,				// vertices further than this from the arm's axis belong to the torso
	FACING: -0.2,			// a vertex is in the patch when its normal leans this much toward the front (z) or more
	ALONG_DEG: 35,			// an edge within this of the arm's direction runs down the arm
	ACROSS_DEG: 55,			// an edge beyond this runs around it; between the two it is a diagonal and is ignored
	STRAIGHTEN: 0.5,		// step toward straight lines and square rings per pass, 0 to 1
	EVEN_OUT: 0.15,			// step of plain smoothing per pass, evens the spacing
	PASSES: 30,
	MIN_NORMAL_DOT: 0.3,	// a face may not turn further than this from its old normal (pins its vertices and re-runs)
	MAX_BEND_ERROR: 0.35,	// units a posed new vertex may sit off the old posed surface before nothing is written
	JOIN_MAX_TILT: 28,		// two triangles become a quad when the quad's four sides sit within this of along / across the arm, on average
};

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
const shot = async name => { await ev(`Preview.selected.render()`); await sleep(300); const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${shots}/${name}.png`, Buffer.from(s.result.data, 'base64')); };
const view = () => ev(`(() => { let mesh = Mesh.all.find(m => m.name == 'body_base'); mesh.select(); BarItems.selection_mode.set('vertex'); BarItems.selection_mode.onChange({value: 'vertex'});
	Project.mesh_selection[mesh.uuid] = {vertices: (window.__patch || []).slice(), edges: [], faces: []}; updateSelection();
	ArmatureBone.all.forEach(b => b.scene_object.visible = false);
	let p = Preview.selected; p.setProjectionMode(false); p.camera.position.set(12.5, 33, 26); p.controls.target.set(12.5, 33, 0); p.controls.update(); p.render(); return true; })()`);

// Stage 1: triangle pairs into quads. A large part of the untidy look is diagonals. The fork's Edge Boundary join makes
// a quad of two triangles and KEEPS the rendered triangulation, so the surface, the weights and the bends cannot change.
// A pair is joined when the quad it makes has its sides along and across the arm; the most square pairs go first, each
// triangle is used once, and every join is repeated on the right arm (undone on the left if the right refuses).
const joins = JSON.parse(await ev(`(() => {
	const K = ${JSON.stringify(RELAX)};
	const mesh = Mesh.all.find(m => m.name == 'body_base');
	const bone = name => ArmatureBone.all.find(b => b.name == name);
	const V = p => new THREE.Vector3().fromArray(p);
	scene.updateMatrixWorld(true);
	const O = mesh.mesh.worldToLocal(bone('upper_arm.L').scene_object.getWorldPosition(new THREE.Vector3()));
	const E = mesh.mesh.worldToLocal(bone('forearm.L').scene_object.getWorldPosition(new THREE.Vector3()));
	const Wr = mesh.mesh.worldToLocal(bone('axis_space.palm.L').scene_object.getWorldPosition(new THREE.Vector3()));
	const d = Wr.clone().sub(O).normalize(), w = new THREE.Vector3(0, 0, 1), u = new THREE.Vector3().crossVectors(w, d).normalize();
	const T1 = E.clone().sub(O).dot(d) + K.FOREARM_FRACTION * (Wr.clone().sub(O).dot(d) - E.clone().sub(O).dot(d));
	const toFrame = p => { let v = V(p).sub(O); let a = v.dot(w), b = v.dot(u); return {t: v.dot(d), theta: Math.atan2(b, a), r: Math.hypot(a, b)}; };
	const tilt = (a, b) => { let A = toFrame(mesh.vertices[a]), B = toFrame(mesh.vertices[b]); let dt = B.t - A.t, ds = (A.r + B.r) / 2 * (B.theta - A.theta); let deg = Math.atan2(Math.abs(ds), Math.abs(dt)) * 180 / Math.PI; return Math.min(deg, 90 - deg); };
	const normal = {};
	for (let fkey in mesh.faces) { let f = mesh.faces[fkey]; if (f.vertices.length < 3) continue; let n = f.getNormal(true); for (let vkey of f.vertices) { normal[vkey] = normal[vkey] || [0, 0, 0]; normal[vkey].V3_add(n); } }
	const patch = new Set();
	for (let vkey in mesh.vertices) { let p = mesh.vertices[vkey]; if (p[0] <= 0) continue; let c = toFrame(p), n = V(normal[vkey] || [0, 0, 1]).normalize();
		if (c.t >= K.T_START && c.t <= T1 && c.r < K.R_MAX && n.dot(w) > K.FACING) patch.add(vkey); }
	const key = p => p.map(v => Math.round(v * 1000)).join(','), index = new Map(); for (let vkey in mesh.vertices) index.set(key(mesh.vertices[vkey]), vkey);
	const twin = vkey => { let p = mesh.vertices[vkey]; return index.get(key([-p[0], p[1], p[2]])); };
	// candidate pairs: two triangles inside the patch sharing an edge
	const by_edge = new Map();
	for (let fkey in mesh.faces) { let f = mesh.faces[fkey]; if (f.vertices.length != 3 || !f.vertices.every(vkey => patch.has(vkey))) continue;
		f.vertices.forEach((a, i) => { let b = f.vertices[(i + 1) % 3], id = [a, b].sort().join('|'); (by_edge.get(id) || by_edge.set(id, []).get(id)).push(fkey); }); }
	let candidates = [];
	for (let [id, list] of by_edge) { if (list.length != 2) continue; let [a, b] = id.split('|');
		let others = list.map(fkey => mesh.faces[fkey].vertices.find(vkey => vkey != a && vkey != b));
		let sides = [[a, others[0]], [others[0], b], [b, others[1]], [others[1], a]];
		let score = sides.reduce((s, [p, q]) => s + tilt(p, q), 0) / 4;
		candidates.push({a, b, faces: list, score, removed_tilt: tilt(a, b)}); }
	candidates.sort((x, y) => x.score - y.score);
	let triangles_before = Object.values(mesh.faces).filter(f => f.vertices.length == 3 && f.vertices.every(vkey => patch.has(vkey))).length;
	let used = new Set(), joined = 0, refused = {}, too_tilted = 0;
	for (let c of candidates) {
		if (c.faces.some(fkey => used.has(fkey))) continue;
		if (c.score > K.JOIN_MAX_TILT) { too_tilted++; continue; }
		let ta = twin(c.a), tb = twin(c.b); if (!ta || !tb) { refused['no mirror twin'] = (refused['no mirror twin'] || 0) + 1; continue; }
		let left = DEWQuads.toggleEdgeBoundary(mesh, c.a, c.b, false);
		if (left.error) { refused[left.error] = (refused[left.error] || 0) + 1; continue; }
		let right = DEWQuads.toggleEdgeBoundary(mesh, ta, tb, false);
		if (right.error) { DEWQuads.toggleEdgeBoundary(mesh, c.a, c.b, false); refused['right arm: ' + right.error] = (refused['right arm: ' + right.error] || 0) + 1; continue; }
		c.faces.forEach(fkey => used.add(fkey)); joined++;
	}
	let triangles_after = Object.values(mesh.faces).filter(f => f.vertices.length == 3 && f.vertices.every(vkey => patch.has(vkey))).length;
	Mesh.preview_controller.updateGeometry(mesh);
	return JSON.stringify({candidate_pairs: candidates.length, joined_per_arm: joined, left_as_too_tilted: too_tilted, refused, triangles_in_patch: [triangles_before, triangles_after]});
})()`));
console.log('joins:', JSON.stringify(joins));

const report = JSON.parse(await ev(`(async () => {
	const K = ${JSON.stringify(RELAX)};
	const mesh = Mesh.all.find(m => m.name == 'body_base'), armature = Armature.all[0];
	const bone = name => ArmatureBone.all.find(b => b.name == name);
	const skin = DEWPerf.stockCalculateVertexDeformation;
	const V = p => new THREE.Vector3().fromArray(p);
	const out = {checks: {}};
	scene.updateMatrixWorld(true);

	// The arm's frame, in the mesh's own space
	const O = mesh.mesh.worldToLocal(bone('upper_arm.L').scene_object.getWorldPosition(new THREE.Vector3()));
	const E = mesh.mesh.worldToLocal(bone('forearm.L').scene_object.getWorldPosition(new THREE.Vector3()));
	const Wr = mesh.mesh.worldToLocal(bone('axis_space.palm.L').scene_object.getWorldPosition(new THREE.Vector3()));
	const d = Wr.clone().sub(O).normalize(), w = new THREE.Vector3(0, 0, 1), u = new THREE.Vector3().crossVectors(w, d).normalize();
	const elbow = E.clone().sub(O).dot(d), wrist = Wr.clone().sub(O).dot(d);
	const T1 = elbow + K.FOREARM_FRACTION * (wrist - elbow);
	const toFrame = p => { let v = V(p).sub(O); let a = v.dot(w), b = v.dot(u); return {t: v.dot(d), theta: Math.atan2(b, a), r: Math.hypot(a, b)}; };
	const direction = theta => w.clone().multiplyScalar(Math.cos(theta)).addScaledVector(u, Math.sin(theta));
	const fromFrame = c => O.clone().addScaledVector(d, c.t).addScaledVector(direction(c.theta), c.r);

	// The patch
	const old = {}; for (let vkey in mesh.vertices) old[vkey] = mesh.vertices[vkey].slice();
	const normal = {}, neighbours = {};
	const faces = Object.keys(mesh.faces).filter(fkey => mesh.faces[fkey].vertices.length >= 3);
	for (let fkey of faces) { let f = mesh.faces[fkey], n = f.getNormal(true), s = f.getSortedVertices();
		for (let vkey of f.vertices) { normal[vkey] = normal[vkey] || [0, 0, 0]; normal[vkey].V3_add(n); }
		s.forEach((a, i) => { let b = s[(i + 1) % s.length]; (neighbours[a] = neighbours[a] || new Set()).add(b); (neighbours[b] = neighbours[b] || new Set()).add(a); }); }
	const patch = new Set();
	for (let vkey in old) { let p = old[vkey]; if (p[0] <= 0) continue; let c = toFrame(p), n = V(normal[vkey] || [0, 0, 1]).normalize();
		if (c.t >= K.T_START && c.t <= T1 && c.r < K.R_MAX && n.dot(w) > K.FACING) patch.add(vkey); }
	const rim = new Set([...patch].filter(vkey => [...(neighbours[vkey] || [])].some(other => !patch.has(other))));
	out.patch = {vertices: patch.size, pinned_rim: rim.size, free: patch.size - rim.size};
	window.__patch = [...patch];

	// Original surface around the patch, as triangles, for putting vertices back on it and for sampling weights
	const near = new Set(); for (let vkey of patch) { near.add(vkey); for (let a of neighbours[vkey] || []) { near.add(a); for (let b of neighbours[a] || []) near.add(b); } }
	const triangles = [];
	for (let fkey of faces) { let f = mesh.faces[fkey]; if (!f.vertices.some(vkey => near.has(vkey))) continue; let s = f.getSortedVertices();
		triangles.push([s[0], s[1], s[2]]); if (s.length == 4) triangles.push([s[0], s[2], s[3]]); }
	const touch = new Set(near); for (let keys of triangles) keys.forEach(vkey => touch.add(vkey));	// every corner the surface uses
	const surface = positions => triangles.map(keys => ({keys, tri: new THREE.Triangle(V(positions[keys[0]]), V(positions[keys[1]]), V(positions[keys[2]]))}));
	const rest_surface = surface(old);
	const closest = (list, point) => { let best = null, target = new THREE.Vector3(); for (let item of list) { item.tri.closestPointToPoint(point, target); let dist = target.distanceToSquared(point); if (!best || dist < best.dist) best = {dist, item, point: target.clone()}; } return best; };

	// Original weights of every vertex the sampling can touch, and the posed original surface for the bend check
	const weights_of = {};
	for (let vkey of touch) { weights_of[vkey] = {}; for (let b of ArmatureBone.all) { let value = b.getVertexWeight(mesh, vkey); if (value) weights_of[vkey][b.uuid] = value; } }
	const POSES = {
		'elbow bent 90 about x': () => { bone('forearm.L').scene_object.rotation.x += Math.PI / 2; },
		'elbow bent 90 about z': () => { bone('forearm.L').scene_object.rotation.z += Math.PI / 2; },
		'arm raised 60 about z': () => { bone('upper_arm.L').scene_object.rotation.z += Math.PI / 3; },
		'arm swung 60 about x': () => { bone('upper_arm.L').scene_object.rotation.x += Math.PI / 3; },
	};
	const posed = apply => { Animator.showDefaultPose(true); apply(); scene.updateMatrixWorld(true); let offsets = skin.call(armature, mesh), result = {};
		for (let vkey of touch) result[vkey] = mesh.vertices[vkey].slice().V3_add(offsets[vkey] || [0, 0, 0]); Animator.showDefaultPose(true); scene.updateMatrixWorld(true); return result; };
	const posed_before = {}; for (let name in POSES) posed_before[name] = posed(POSES[name]);

	// How far the edge lines wander, before and after
	const edges = new Map(); for (let vkey of patch) for (let other of neighbours[vkey] || []) if (patch.has(other)) edges.set([vkey, other].sort().join('|'), [vkey, other]);
	const classify = positions => { let along = [], across = [], kinds = new Map();
		for (let [key, [a, b]] of edges) { let A = toFrame(positions[a]), B = toFrame(positions[b]); let dt = B.t - A.t, ds = (A.r + B.r) / 2 * (B.theta - A.theta);
			let tilt = Math.atan2(Math.abs(ds), Math.abs(dt)) * 180 / Math.PI;
			if (tilt < K.ALONG_DEG) { along.push(tilt); kinds.set(key, 'along'); } else if (tilt > K.ACROSS_DEG) { across.push(90 - tilt); kinds.set(key, 'across'); } }
		let mean = list => list.length ? Math.round(list.reduce((s, v) => s + v, 0) / list.length * 100) / 100 : null;
		return {kinds, stats: {edges_down_the_arm: along.length, mean_tilt_deg: mean(along), edges_around_the_arm: across.length, mean_tilt_deg_: mean(across)}}; };
	const before = classify(old);
	out.before = before.stats;
	const along_of = {}, across_of = {};
	for (let [key, kind] of before.kinds) { let [a, b] = edges.get(key); let table = kind == 'along' ? along_of : across_of; (table[a] = table[a] || []).push(b); (table[b] = table[b] || []).push(a); }

	// Relax, pinning whatever turns a face too far, until a run comes through clean
	const pinned = new Set(rim); let result = null, rounds = 0;
	const areaNormal = (positions, keys) => { let tri = new THREE.Triangle(V(positions[keys[0]]), V(positions[keys[1]]), V(positions[keys[2]])); return {normal: tri.getNormal(new THREE.Vector3()), area: tri.getArea()}; };
	while (rounds++ < 6) {
		let c = {}; for (let vkey of patch) c[vkey] = toFrame(old[vkey]);
		for (let pass = 0; pass < K.PASSES; pass++) {
			let next = {};
			for (let vkey of patch) { let me = c[vkey]; if (pinned.has(vkey)) { next[vkey] = me; continue; }
				let t = me.t, theta = me.theta;
				let ring = across_of[vkey], line = along_of[vkey], all = [...(neighbours[vkey] || [])].filter(other => patch.has(other));
				if (ring) t += K.STRAIGHTEN * (ring.reduce((s, o) => s + c[o].t, 0) / ring.length - me.t);
				if (line) theta += K.STRAIGHTEN * (line.reduce((s, o) => s + c[o].theta, 0) / line.length - me.theta);
				if (all.length) { t += K.EVEN_OUT * (all.reduce((s, o) => s + c[o].t, 0) / all.length - me.t); theta += K.EVEN_OUT * (all.reduce((s, o) => s + c[o].theta, 0) / all.length - me.theta); }
				next[vkey] = {t, theta, r: me.r};
			}
			c = next;
		}
		// Back onto the original surface: a ray out from the arm's axis, the hit nearest the old radius
		let positions = {}; for (let vkey in old) positions[vkey] = old[vkey];
		let ray = new THREE.Ray(), hit = new THREE.Vector3(), missed = 0;
		for (let vkey of patch) { if (pinned.has(vkey)) continue; let me = c[vkey];
			ray.origin.copy(O).addScaledVector(d, me.t); ray.direction.copy(direction(me.theta));
			let best = null;
			for (let item of rest_surface) { if (ray.intersectTriangle(item.tri.a, item.tri.b, item.tri.c, false, hit) || ray.intersectTriangle(item.tri.c, item.tri.b, item.tri.a, false, hit)) {
				let r = hit.distanceTo(ray.origin); if (!best || Math.abs(r - me.r) < Math.abs(best.r - me.r)) best = {r, point: hit.clone()}; } }
			if (!best) { missed++; best = {point: closest(rest_surface, fromFrame(me)).point}; }
			positions[vkey] = best.point.toArray();
		}
		let bad = new Set();
		for (let keys of triangles) { if (!keys.some(vkey => patch.has(vkey))) continue; let was = areaNormal(old, keys), now = areaNormal(positions, keys);
			if (now.area < 1e-4 || (was.area > 1e-4 && now.normal.dot(was.normal) < K.MIN_NORMAL_DOT)) keys.forEach(vkey => { if (!pinned.has(vkey) && patch.has(vkey)) bad.add(vkey); }); }
		result = {positions, missed};
		if (!bad.size) break;
		bad.forEach(vkey => pinned.add(vkey));
	}
	out.relax = {rounds, pinned_for_turning_a_face: pinned.size - rim.size, rays_that_missed: result.missed};

	// Apply, re-sample weights at the new spots
	let moved = [], furthest = 0, total = 0;
	for (let vkey of patch) { let dist = V(result.positions[vkey]).distanceTo(V(old[vkey])); if (dist > 1e-5) { moved.push(vkey); furthest = Math.max(furthest, dist); total += dist; mesh.vertices[vkey].V3_set(result.positions[vkey]); } }
	out.moved = {vertices: moved.length, furthest: Math.round(furthest * 1000) / 1000, mean: Math.round(total / Math.max(1, moved.length) * 1000) / 1000};
	let off_surface = 0; for (let vkey of moved) off_surface = Math.max(off_surface, Math.sqrt(closest(rest_surface, V(mesh.vertices[vkey])).dist));
	out.checks.furthest_off_the_original_surface = off_surface;
	const new_weights = {}; let bary = new THREE.Vector3();
	for (let vkey of moved) { let at = closest(rest_surface, V(mesh.vertices[vkey])), tri = at.item.tri; THREE.Triangle.getBarycoord(at.point, tri.a, tri.b, tri.c, bary);
		let blend = {}; at.item.keys.forEach((corner, i) => { let share = [bary.x, bary.y, bary.z][i]; for (let uuid in weights_of[corner]) blend[uuid] = (blend[uuid] || 0) + share * weights_of[corner][uuid]; });
		let top = Object.entries(blend).filter(([, value]) => value > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4), sum = top.reduce((s, [, value]) => s + value, 0);
		new_weights[vkey] = Object.fromEntries(top.map(([uuid, value]) => [uuid, Math.round(value / sum * 100000) / 100000])); }
	const setWeights = (vkey, table) => { for (let b of ArmatureBone.all) { let value = table[b.uuid] || 0; if (value || b.getVertexWeight(mesh, vkey)) b.setVertexWeight(mesh, vkey, value); } };
	for (let vkey of moved) setWeights(vkey, new_weights[vkey]);
	if (DEWPerf.influence_cache) DEWPerf.influence_cache.clear();

	// The bends: each posed new vertex against the posed ORIGINAL surface
	out.bend_error = {};
	for (let name in POSES) { let now = posed(POSES[name]), was = surface(posed_before[name]), worst = 0, sum = 0;
		for (let vkey of moved) { let dist = Math.sqrt(closest(was, V(now[vkey])).dist); worst = Math.max(worst, dist); sum += dist; }
		out.bend_error[name] = {worst: Math.round(worst * 1000) / 1000, mean: Math.round(sum / Math.max(1, moved.length) * 1000) / 1000}; }

	// Mirror to the right arm: positions, and weights with .L and .R swapped
	const key = p => p.map(v => Math.round(v * 1000)).join(','), index = new Map(); for (let vkey in old) index.set(key(old[vkey]), vkey);
	const by_name = new Map(ArmatureBone.all.map(b => [b.name, b])), swap = name => name.endsWith('.L') ? name.slice(0, -2) + '.R' : name.endsWith('.R') ? name.slice(0, -2) + '.L' : name;
	let mirrored = 0, unmatched = 0;
	for (let vkey of moved) { let twin = index.get(key([-old[vkey][0], old[vkey][1], old[vkey][2]])); if (!twin) { unmatched++; continue; }
		let p = mesh.vertices[vkey]; mesh.vertices[twin].V3_set([-p[0], p[1], p[2]]);
		let table = {}; for (let uuid in new_weights[vkey]) { let b = ArmatureBone.all.find(x => x.uuid == uuid), other = by_name.get(swap(b.name)); if (!other) { unmatched++; continue; } table[other.uuid] = new_weights[vkey][uuid]; }
		setWeights(twin, table); mirrored++; }
	out.mirror = {mirrored, unmatched};
	if (DEWPerf.influence_cache) DEWPerf.influence_cache.clear();

	// After
	let now_positions = {}; for (let vkey in mesh.vertices) now_positions[vkey] = mesh.vertices[vkey];
	out.after = classify(now_positions).stats;
	let twins_ok = 0, twins_bad = 0; for (let vkey in mesh.vertices) { let p = mesh.vertices[vkey]; if (p[0] <= 1e-4) continue; let twin = index.get(key([-old[vkey][0], old[vkey][1], old[vkey][2]])); if (!twin) { twins_bad++; continue; } let q = mesh.vertices[twin];
		if (Math.abs(p[0] + q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) < 1e-9) twins_ok++; else twins_bad++; }
	out.checks.mirror_pairs_exact = twins_ok; out.checks.mirror_pairs_broken = twins_bad;
	let unweighted = 0, over_four = 0, not_normal = 0;
	for (let vkey in mesh.vertices) { let values = ArmatureBone.all.map(b => b.getVertexWeight(mesh, vkey)).filter(Boolean); if (!values.length) unweighted++; if (values.length > 4) over_four++; if (values.length && Math.abs(values.reduce((s, v) => s + v, 0) - 1) > 1e-3) not_normal++; }
	out.checks.weights = {unweighted, over_four, not_normal};
	out.checks.nan = Object.values(mesh.vertices).some(p => p.some(n => !isFinite(n)));
	let tex = Texture.all[0], colours = null; try { let data = tex.canvas.getContext('2d').getImageData(0, 0, tex.canvas.width, tex.canvas.height).data, seen = new Set(); for (let i = 0; i < data.length; i += 4 * 97) seen.add(data[i] + ',' + data[i + 1] + ',' + data[i + 2]); colours = seen.size; } catch (err) {}
	out.texture_colours_sampled = colours;
	Mesh.preview_controller.updateGeometry(mesh); Canvas.updateAll();
	return JSON.stringify(out);
})()`));
console.log(JSON.stringify(report, null, 1));
await view(); await shot('arm_after');
await ev(`(() => { let b = ArmatureBone.all.find(b => b.name == 'forearm.L'); Animator.showDefaultPose(true); b.scene_object.rotation.x += Math.PI / 2; scene.updateMatrixWorld(true);
	let mesh = Mesh.all.find(m => m.name == 'body_base'); Mesh.preview_controller.displayDeformation(mesh, DEWPerf.stockCalculateVertexDeformation.call(Armature.all[0], mesh));
	for (let name of ['hand left']) { let m = Mesh.all.find(x => x.name == name); Mesh.preview_controller.displayDeformation(m, DEWPerf.stockCalculateVertexDeformation.call(Armature.all[0], m)); } return true; })()`);
await shot('arm_after_bent');
await ev(`(() => { Animator.showDefaultPose(true); scene.updateMatrixWorld(true); for (let mesh of Mesh.all) Mesh.preview_controller.updateGeometry(mesh); unselectAllElements(); updateSelection(); return true; })()`);

const c = report.checks;
const ok = !c.nan && c.mirror_pairs_broken == 0 && c.weights.unweighted == 0 && c.weights.over_four == 0 && c.weights.not_normal == 0 && report.mirror.unmatched == 0
	&& c.furthest_off_the_original_surface < 0.01 && Object.values(report.bend_error).every(e => e.worst < RELAX.MAX_BEND_ERROR) && errors.length == 0;
console.log('page errors:', errors.length ? errors : 'none');
if (!ok) { console.log('CHECKS FAILED: nothing written'); ws.close(); process.exit(1); }
const compiled = await ev(`Codecs.project.compile()`);
const count = m => ({elements: m.elements.length, animations: (m.animations || []).length, faces: m.elements.filter(e => e.type == 'mesh').reduce((n, e) => n + Object.keys(e.faces).length, 0), vertices: m.elements.filter(e => e.type == 'mesh').reduce((n, e) => n + Object.keys(e.vertices).length, 0)});
// each join turns two faces into one, on both arms
const expected = count(JSON.parse(original)); expected.faces -= 2 * joins.joined_per_arm;
const a = JSON.stringify(expected), b = JSON.stringify(count(JSON.parse(compiled)));
console.log('file expected:', a); console.log('file after: ', b);
if (a != b) { console.log('COUNTS DIFFER: nothing written'); ws.close(); process.exit(1); }
fs.writeFileSync(out_file, compiled);
console.log('written', out_file);
ws.close();
