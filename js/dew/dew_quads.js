// Merge Triangles into Quads: a glTF import arrives as triangles, since the format has no quads, so every
// diagonal is a face border and Blockbench draws it. Pairs of triangles that share an edge, lie in one plane,
// carry the same texture with continuous uvs and make a convex four-sided face become one quad, which is what a
// native model would hold. Folded pairs, uv seams and unpaired triangles stay as they are.
import { THREE } from "../lib/libs";

export const QUADS = {
	MAX_ANGLE: 10,			// degrees between the two triangles' normals for them to count as one plane
	WELD_DISTANCE: 0.001,	// vertices closer than this are one vertex: importers split them wherever normals or uvs differ
	MESSAGE_TIME: 3000,
	EDGE_PICK_PIXELS: 8,
};

function worldNormal(mesh, face) {
	let n = face.getNormal(true);
	return new THREE.Vector3().fromArray(Array.isArray(n) ? n : n.toArray());
}
// Missing uvs (an untextured import has none) are not a seam; two present uvs must agree within a hundredth of a texel
const sameUV = (a, b) => (!a && !b) || (a && b && Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01);
// A flat-colour face from the rig importer has its uvs placed by corner INDEX inside one palette cell (RIG.PALETTE_CELL),
// so two triangles of one quad disagree on their shared corners by construction while every uv in the cell draws the
// same colour. Uvs that all fit in one such cell are no seam; the joined face gets the cell's corners again.
const FLAT_UV_SPAN = 8;
function flatUVBox(faces) {
	let min = [Infinity, Infinity], max = [-Infinity, -Infinity];
	for (let face of faces) for (let v of face.vertices) {
		let uv = face.uv[v];
		if (!uv) return null;
		for (let i = 0; i < 2; i++) { if (uv[i] < min[i]) min[i] = uv[i]; if (uv[i] > max[i]) max[i] = uv[i]; }
	}
	return max[0] - min[0] <= FLAT_UV_SPAN && max[1] - min[1] <= FLAT_UV_SPAN ? [min[0], min[1], max[0], max[1]] : null;
}
const cellUVs = (order, box) => Object.fromEntries(order.map((v, i) => [v, [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]][i % 4]]));

// Is the polygon c, a, d, b convex, seen along its normal
function convex(points, normal) {
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		let p0 = points[i], p1 = points[(i + 1) % 4], p2 = points[(i + 2) % 4];
		let cross = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p1)).dot(normal);
		if (Math.abs(cross) < 1e-6) return false;
		if (!sign) sign = Math.sign(cross);
		else if (Math.sign(cross) != sign) return false;
	}
	return true;
}
// How far the quad's corners are from right angles: 0 for a rectangle, larger for a kite
function skew(points) {
	let worst = 0;
	for (let i = 0; i < 4; i++) {
		let a = new THREE.Vector3().subVectors(points[(i + 3) % 4], points[i]).normalize();
		let b = new THREE.Vector3().subVectors(points[(i + 1) % 4], points[i]).normalize();
		worst = Math.max(worst, Math.abs(a.dot(b)));
	}
	return worst;
}

// Vertices at one position become one vertex, so triangles that only touch start sharing edges. Face uvs are
// per face and per vertex in Blockbench, so nothing is lost by welding.
function weldVertices(mesh) {
	let q = 1 / QUADS.WELD_DISTANCE;
	let by_position = new Map(), remap = new Map();
	for (let vkey in mesh.vertices) {
		let key = mesh.vertices[vkey].map(v => Math.round(v * q)).join(',');
		if (by_position.has(key)) remap.set(vkey, by_position.get(key));
		else by_position.set(key, vkey);
	}
	if (!remap.size) return 0;
	for (let fkey in mesh.faces) {
		let face = mesh.faces[fkey];
		let seen = new Set();
		let vertices = face.vertices.map(vkey => remap.get(vkey) || vkey).filter(vkey => !seen.has(vkey) && seen.add(vkey));
		let uv = {};
		face.vertices.forEach((vkey, i) => { let to = remap.get(vkey) || vkey; if (!uv[to]) uv[to] = face.uv[vkey]; });
		if (vertices.length < 3) { delete mesh.faces[fkey]; continue; }	// a degenerate sliver collapsed
		face.vertices = vertices;
		face.uv = uv;
	}
	for (let vkey of remap.keys()) delete mesh.vertices[vkey];
	return remap.size;
}

export function mergeTrianglesToQuads(meshes = Mesh.selected) {
	meshes = meshes.filter(mesh => mesh instanceof Mesh);
	if (!meshes.length) return null;
	let min_dot = Math.cos(QUADS.MAX_ANGLE * Math.PI / 180);
	let merged = 0, left = 0, welded = 0;
	let why = {shared_edges: 0, texture: 0, angle: 0, uv_seam: 0, concave: 0};
	Undo.initEdit({elements: meshes});
	for (let mesh of meshes) {
		welded += weldVertices(mesh);
		let point = vkey => new THREE.Vector3().fromArray(mesh.vertices[vkey]);
		let edges = new Map();
		for (let fkey in mesh.faces) {
			let face = mesh.faces[fkey];
			if (face.vertices.length != 3) continue;
			for (let i = 0; i < 3; i++) {
				let key = [face.vertices[i], face.vertices[(i + 1) % 3]].sort().join('|');
				if (!edges.has(key)) edges.set(key, []);
				edges.get(key).push(fkey);
			}
		}
		let candidates = [];
		for (let [key, fkeys] of edges) {
			if (fkeys.length != 2) continue;
			why.shared_edges++;
			let [f1, f2] = fkeys.map(fkey => mesh.faces[fkey]);
			if (f1.texture !== f2.texture) { why.texture++; continue; }
			let n1 = worldNormal(mesh, f1), n2 = worldNormal(mesh, f2);
			// Coplanar either way round: an importer does not always keep the winding consistent, and the quad takes f1's
			if (Math.abs(n1.dot(n2)) < min_dot) { why.angle++; continue; }
			let [a, b] = key.split('|');
			let c = f1.vertices.find(v => v != a && v != b), d = f2.vertices.find(v => v != a && v != b);
			if (!c || !d || c == d) continue;
			// A textured face must read the same texels from both sides of the shared edge, or the diagonal is a uv seam.
			// An untextured face has nothing to tear: the glTF importer gives such faces placeholder uvs that differ on
			// every triangle, which is not a seam.
			let textured = f1.texture !== false && f1.texture != null;
			let order = [c, a, d, b];
			let uv = {[a]: f1.uv[a], [b]: f1.uv[b], [c]: f1.uv[c], [d]: f2.uv[d]};
			if (textured && (!sameUV(f1.uv[a], f2.uv[a]) || !sameUV(f1.uv[b], f2.uv[b]))) {
				let box = flatUVBox([f1, f2]);
				if (!box) { why.uv_seam++; continue; }
				uv = cellUVs(order, box);
			}
			let points = order.map(point);
			if (!convex(points, n1)) { why.concave++; continue; }
			candidates.push({fkeys, order, skew: skew(points), normal: n1, texture: f1.texture, uv});
		}
		candidates.sort((p, q) => p.skew - q.skew);
		let used = new Set();
		for (let candidate of candidates) {
			if (candidate.fkeys.some(fkey => used.has(fkey))) continue;
			candidate.fkeys.forEach(fkey => { used.add(fkey); delete mesh.faces[fkey]; });
			let face = new MeshFace(mesh, {vertices: candidate.order, uv: candidate.uv, texture: candidate.texture});
			mesh.addFaces(face);
			if (worldNormal(mesh, face).dot(candidate.normal) < 0) face.invert();
			merged++;
		}
		for (let fkey in mesh.faces) if (mesh.faces[fkey].vertices.length == 3) left++;
	}
	if (!merged && !welded) {
		Undo.cancelEdit();
		// Say why, so a mesh that will not merge can be read: no shared edges means split vertices the weld did not
		// catch (positions differ), the rest are the rules
		Blockbench.showQuickMessage(`No triangle pairs to merge: ${why.shared_edges} shared edges, rejected ${why.angle} by angle, ${why.uv_seam} by uv seam, ${why.texture} by texture, ${why.concave} concave`, QUADS.MESSAGE_TIME * 2);
		return {merged, left, welded, why};
	}
	Undo.finishEdit('Merge triangles into quads');
	Canvas.updateView({elements: meshes, element_aspects: {geometry: true, faces: true, uv: true}, selection: true});
	Blockbench.showQuickMessage(`${welded ? `Welded ${welded} vertices, ` : ''}merged ${merged} pairs into quads, ${left} triangles left`, QUADS.MESSAGE_TIME);
	return {merged, left, welded, why};
}

BARS.defineActions(function() {
	new Action('dew_merge_triangles', {
		name: 'Merge Triangles into Quads',
		description: 'Join pairs of coplanar triangles that share an edge into one quad, so an imported glTF reads like a native model. Folded pairs, uv seams and unpaired triangles are left alone',
		icon: 'join_full',
		category: 'edit',
		condition: () => Modes.edit && Mesh.selected.length,
		click() { mergeTrianglesToQuads(Mesh.selected); },
	});
});

// Turn Edges on a visible edge: the stock tool flips a quad's hidden diagonal; here a click on an edge shared by
// exactly two triangles flips that edge (the two triangles are rebuilt across the other diagonal). An edge of a
// quad, or between a quad and a triangle, has no other diagonal and is left alone.
export function flipSharedEdge(mesh, a, b) {
	let faces = Object.entries(mesh.faces).filter(([, face]) => face.vertices.length == 3 && face.vertices.includes(a) && face.vertices.includes(b));
	if (faces.length != 2) return false;
	let [[k1, f1], [k2, f2]] = faces;
	let c = f1.vertices.find(v => v != a && v != b), d = f2.vertices.find(v => v != a && v != b);
	if (!c || !d || c == d) return false;
	let normal = worldNormal(mesh, f1);
	let uv = {[a]: f1.uv[a], [b]: f1.uv[b], [c]: f1.uv[c], [d]: f2.uv[d]};
	delete mesh.faces[k1];
	delete mesh.faces[k2];
	for (let order of [[c, d, a], [c, d, b]]) {
		let face = new MeshFace(mesh, {vertices: order, uv: Object.fromEntries(order.map(v => [v, uv[v]])), texture: f1.texture});
		mesh.addFaces(face);
		if (worldNormal(mesh, face).dot(normal) < 0) face.invert();
	}
	return true;
}
// The face edge nearest a world point
function nearestEdge(mesh, face, point) {
	let world = vkey => mesh.mesh.localToWorld(new THREE.Vector3().fromArray(mesh.vertices[vkey]));
	let vertices = face.getSortedVertices();
	let best = null;
	for (let i = 0; i < vertices.length; i++) {
		let a = vertices[i], b = vertices[(i + 1) % vertices.length];
		let segment = new THREE.Line3(world(a), world(b));
		let distance = segment.closestPointToPoint(point, true, new THREE.Vector3()).distanceTo(point);
		if (!best || distance < best.distance) best = {a, b, distance};
	}
	return best;
}
BARS.defineActions(function() {
	let tool = BarItems.turn_edges_tool;
	if (!tool) return;
	let turnDiagonal = tool.onCanvasClick;
	tool.onCanvasClick = function(data) {
		if (!data || !data.intersects) return;
		// A hidden diagonal under the cursor keeps the stock behaviour
		let first_surface = data.intersects.find(intersect => !intersect.object.is_turn_edges);
		let max_distance = first_surface ? first_surface.distance + 0.5 : Infinity;
		if (data.intersects.some(intersect => intersect.object.is_turn_edges && intersect.distance <= max_distance)) return turnDiagonal.call(this, data);
		let hit = data.event && window.DEWTileBrush ? DEWTileBrush.hitFace(Preview.selected, data.event) : null;
		if (!hit || !(hit.element instanceof Mesh)) return;
		let mesh = hit.element;
		let edge = nearestEdge(mesh, mesh.faces[hit.face], hit.point);
		if (!edge) return;
		Undo.initEdit({elements: [mesh]});
		if (!flipSharedEdge(mesh, edge.a, edge.b)) {
			Undo.cancelEdit();
			Blockbench.showQuickMessage('Only an edge between two triangles can be flipped', QUADS.MESSAGE_TIME);
			return;
		}
		Undo.finishEdit('Flip edge');
		Canvas.updateView({elements: [mesh], element_aspects: {geometry: true, uv: true, faces: true}});
	};
});

// Explicitly join/split a boundary, keeping the same rendered triangles. Unlike the bulk
// importer cleanup this never welds vertices: rig weights keep their original vertex keys.
// `force` (Ctrl) skips the three texture rules for modelling before the unwrap exists. The
// geometric rules always stand: they decide whether the quad can exist, not how it reads.
export function toggleEdgeBoundary(mesh, a, b, force = false) {
	let adjacent = [], diagonal = null;
	for (let [key, face] of Object.entries(mesh.faces)) {
		let vs = face.getSortedVertices();
		if (!vs.includes(a) || !vs.includes(b)) continue;
		if (vs.length == 4 && [vs[0], vs[2]].includes(a) && [vs[0], vs[2]].includes(b)) {
			diagonal = [key, face];
		} else if (vs.some((v, i) => v == a && (vs[(i + 1) % vs.length] == b || vs[(i + vs.length - 1) % vs.length] == b))) {
			adjacent.push([key, face]);
		}
	}
	let removed, replacements;
	if (diagonal && !adjacent.length) {
		let [key, face] = diagonal, vs = face.getSortedVertices();
		removed = [key];
		replacements = [[vs[0], vs[1], vs[2]], [vs[0], vs[2], vs[3]]].map(vertices => new MeshFace(mesh, {...face, vertices}));
	} else {
		if (diagonal || adjacent.length != 2 || adjacent.some(([, face]) => face.vertices.length != 3)) {
			return {error: 'Only the edge between two triangles or a quad diagonal can be toggled'};
		}
		let [[k1, f1], [k2, f2]] = adjacent;
		// The quad keeps f1's texture, face settings and uvs, so a forced join across any of
		// these reads wrong on f2's half until the mesh is unwrapped again.
		if (!force) {
			if (f1.texture !== f2.texture) return {error: 'This edge separates different textures. Hold Ctrl to join anyway'};
			for (let property in MeshFace.properties) {
				if (property != 'vertices' && property != 'uv' && JSON.stringify(f1[property]) !== JSON.stringify(f2[property])) {
					return {error: 'This edge separates different face settings, such as smoothing groups. Hold Ctrl to join anyway'};
				}
			}
			if (f1.getTexture() && (!sameUV(f1.uv[a], f2.uv[a]) || !sameUV(f1.uv[b], f2.uv[b]))) {
				return {error: 'This edge is a UV seam; joining it would change the texture. Hold Ctrl to join anyway'};
			}
		}
		let c = f1.vertices.find(v => v != a && v != b), d = f2.vertices.find(v => v != a && v != b);
		if (!c || !d || c == d) return {error: 'These triangles do not form a four-corner face'};
		let i = f1.vertices.indexOf(c);
		let order = [f1.vertices[(i + 2) % 3], c, f1.vertices[(i + 1) % 3], d];
		if (f2.vertices[(f2.vertices.indexOf(order[2]) + 1) % 3] != d) {
			return {error: 'These triangles face opposite ways; fix their winding first'};
		}
		let quad = new MeshFace(mesh, {...f1, vertices: order, uv: {...f1.uv, [d]: f2.uv[d]}});
		// Blockbench sorts quad corners geometrically. Reject a pair it would reorder,
		// instead of silently changing the diagonal on a folded or overlapping face.
		if (!quad.getSortedVertices().every((v, j) => v == order[j]) || !worldNormal(mesh, f1).lengthSq() || !worldNormal(mesh, f2).lengthSq()) {
			return {error: 'These triangles cannot form a quad with the same diagonal'};
		}
		removed = [k1, k2];
		replacements = [quad];
	}
	Undo.initEdit({elements: [mesh], selection: true});
	let selected = mesh.getSelectedFaces(true), was_selected = removed.some(key => selected.includes(key));
	removed.forEach(key => { delete mesh.faces[key]; selected.remove(key); });
	// Retain the first face key; only a split needs a second key.
	mesh.faces[removed[0]] = replacements[0];
	let added = [removed[0], ...mesh.addFaces(...replacements.slice(1))];
	if (was_selected) selected.safePush(...added);
	if (replacements.length == 1) {
		let edges = mesh.getSelectedEdges(true);
		for (let i = edges.length - 1; i >= 0; i--) if (edges[i].includes(a) && edges[i].includes(b)) edges.splice(i, 1);
	}
	Undo.finishEdit(replacements.length == 1 ? 'Hide edge boundary' : 'Show edge boundary');
	Canvas.updateView({elements: [mesh], element_aspects: {geometry: true, uv: true, faces: true}, selection: true});
	return {split: replacements.length == 2, faces: added};
}

BARS.defineActions(function() {
	new Tool('dew_edge_boundary', {
		name: 'Edge Boundary',
		description: 'Click a triangle edge to join a quad, or an orange quad diagonal to split it into triangles. Hold Ctrl to join across a texture or UV seam',
		icon: 'border_inner',
		category: 'tools',
		transformerMode: 'hidden',
		selectElements: false,
		cursor: 'pointer',
		raycast_options: {turn_edges: true},
		modes: ['edit'],
		condition: () => Modes.edit && !Modes.block && Format.meshes,
		onCanvasClick(data) {
			if (!data?.event) return;
			let preview = Preview.selected;
			// Read the actual front surface so a guide behind another face cannot be edited.
			let hit = DEWTileBrush.hitFace(preview, data.event);
			if (!hit || !(hit.element instanceof Mesh) || !hit.element.selected) return;
			let mesh = hit.element, vs = mesh.faces[hit.face].getSortedVertices();
			let rect = preview.canvas.getBoundingClientRect();
			let mouse = new THREE.Vector3(data.event.clientX - rect.left, data.event.clientY - rect.top, 0);
			let screen = v => {
				let p = mesh.mesh.localToWorld(new THREE.Vector3().fromArray(mesh.vertices[v])).project(preview.camera);
				return new THREE.Vector3((p.x + 1) * rect.width / 2, (1 - p.y) * rect.height / 2, 0);
			};
			let edges = vs.map((v, i) => [v, vs[(i + 1) % vs.length]]);
			if (vs.length == 4) edges.push([vs[0], vs[2]]);
			let best, distance = QUADS.EDGE_PICK_PIXELS;
			for (let edge of edges) {
				let line = new THREE.Line3(...edge.map(screen));
				let d = line.closestPointToPoint(mouse, true, new THREE.Vector3()).distanceTo(mouse);
				if (d < distance) { best = edge; distance = d; }
			}
			if (!best) return;
			let result = toggleEdgeBoundary(mesh, ...best, data.event.ctrlKey);
			if (result.error) Blockbench.showQuickMessage(result.error, QUADS.MESSAGE_TIME);
		},
		onSelect() { Mesh.selected.forEach(mesh => mesh.preview_controller.updateSelection(mesh)); },
		onUnselect() { setTimeout(() => Mesh.selected.forEach(mesh => mesh.preview_controller.updateSelection(mesh)), 0); },
	});
});

// Quads from OBJ Reference (2026-09-23): a pack that ships the same asset as OBJ (quads and n-gons, no materials worth
// keeping) and as glb (materials, textures, rig; triangles only) gets the best of both. The glb is imported and kept;
// the OBJ is read only for its polygons: every polygon with four or more corners is matched to the mesh's vertices by
// position (after fitting the OBJ's bounding box onto the mesh's, so units and offset do not matter) and the triangles
// the glb exporter cut it into are put back together as that polygon, exactly, with no angle heuristic and no
// guesswork about which pairs belong together. n-gons are fanned into quads and a last triangle like the OBJ importer.
// Kept as triangles and counted in the report: polygons with a corner that matches no vertex, ones whose triangles are
// not all there (the mesh was edited, or triangulated across other corners), ones whose triangles differ in texture,
// face settings or uvs, and quads Blockbench would re-diagonalise (its corner sort would change the shape).
export const QUADS_REF = {
	TOLERANCE: 1e-3,		// of the mesh's bounding box diagonal: a corner matches a vertex within this
	FIT_SAMPLE: 400,		// polygon corners each candidate fit is scored on; the chosen fit then matches them all
};

function parseOBJPolygons(text) {
	let positions = [], polygons = [];
	for (let line of text.split(/\r?\n/)) {
		let args = line.trim().split(/\s+/);
		if (args[0] == 'v') positions.push([parseFloat(args[1]), parseFloat(args[2]), parseFloat(args[3])]);
		else if (args[0] == 'f') {
			let corners = args.slice(1).map(t => parseInt(t.split('/')[0])).map(i => i < 0 ? positions.length + i : i - 1);
			if (corners.length >= 4 && corners.every(i => i >= 0 && i < positions.length)) polygons.push(corners);
		}
	}
	return {positions, polygons};
}

function bounds(points) {
	let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
	for (let p of points) for (let i = 0; i < 3; i++) { if (p[i] < min[i]) min[i] = p[i]; if (p[i] > max[i]) max[i] = p[i]; }
	let size = max.map((v, i) => v - min[i]);
	return {min, max, size, center: min.map((v, i) => v + size[i] / 2), diagonal: Math.hypot(...size)};
}

export function quadsFromOBJ(meshes, obj_text) {
	let {positions, polygons} = parseOBJPolygons(obj_text);
	let report = {polygons: polygons.length, joined: 0, faces_made: 0, welded: 0, unmatched_corner: 0, triangles_missing: 0, seam_or_texture: 0, diagonal: 0, meshes: meshes.length};
	if (!polygons.length) { Blockbench.showQuickMessage('The OBJ has no polygon with four or more corners', QUADS.MESSAGE_TIME); return report; }
	Undo.initEdit({elements: meshes});
	let obj_box = bounds(positions);
	for (let mesh of meshes) {
		report.welded += weldVertices(mesh);
		let keys = Object.keys(mesh.vertices);
		if (keys.length < 4) continue;
		let mesh_box = bounds(keys.map(k => mesh.vertices[k]));
		let tolerance = Math.max(mesh_box.diagonal * QUADS_REF.TOLERANCE, 1e-6);
		let cell = tolerance * 2;
		let grid = new Map();
		let cellKey = p => p.map(v => Math.floor(v / cell)).join(',');
		for (let k of keys) { let c = cellKey(mesh.vertices[k]); if (!grid.has(c)) grid.set(c, []); grid.get(c).push(k); }
		let nearest = p => {
			let base = p.map(v => Math.floor(v / cell)), best = null, best_d = tolerance;
			for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
				for (let k of grid.get([base[0] + dx, base[1] + dy, base[2] + dz].join(',')) || []) {
					let v = mesh.vertices[k], d = Math.hypot(v[0] - p[0], v[1] - p[1], v[2] - p[2]);
					if (d < best_d) { best_d = d; best = k; }
				}
			}
			return best;
		};
		// Fit the OBJ onto the mesh. Exporters disagree on the up axis (Blender's OBJ writes Z up, glTF is Y up) and on
		// units, and the two bounding boxes differ whenever one side has faces the other lacks, so no single box-to-box
		// fit is trusted. Candidates: the 48 axis-aligned orientations (axis swaps with any signs, mirrors included), and
		// per orientation a few scales (box ratios per axis and diagonal, plus the usual unit factors) and offsets (boxes
		// aligned by centre, by minimum corner, or not at all). Each is scored on a sample of the polygon corners by how
		// many DISTINCT vertices they land on (raw hits would let a tiny scale win by piling every corner onto one vertex).
		let used = [...new Set(polygons.flat())];
		let stride = Math.max(1, Math.floor(used.length / QUADS_REF.FIT_SAMPLE));
		let sample = used.filter((_, i) => i % stride == 0);
		let score = place => { let matched = new Set(); for (let i of sample) { let k = nearest(place(positions[i])); if (k) matched.add(k); } return matched.size; };
		let fit = null;
		for (let perm of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) for (let signs = 0; signs < 8; signs++) {
			let sign = [0, 1, 2].map(i => signs & (1 << i) ? -1 : 1);
			let orient = p => [p[perm[0]] * sign[0], p[perm[1]] * sign[1], p[perm[2]] * sign[2]];
			let box = bounds(used.map(i => orient(positions[i])));
			let scales = new Set([1, 16, 1 / 16, 100, 0.01]);
			if (box.diagonal > 0) scales.add(mesh_box.diagonal / box.diagonal);
			for (let i = 0; i < 3; i++) if (box.size[i] > 0 && mesh_box.size[i] > 0) scales.add(mesh_box.size[i] / box.size[i]);
			for (let scale of scales) {
				for (let offset of [mesh_box.center.map((c, i) => c - box.center[i] * scale), mesh_box.min.map((c, i) => c - box.min[i] * scale), [0, 0, 0]]) {
					let place = p => orient(p).map((v, j) => v * scale + offset[j]);
					let hits = score(place);
					if (!fit || hits > fit.hits) fit = {place, hits, scale, offset, perm, sign};
				}
			}
		}
		let axis = i => (fit.sign[i] < 0 ? '-' : '+') + 'xyz'[fit.perm[i]];
		report.fit = {axes: [0, 1, 2].map(axis).join(' '), scale: +fit.scale.toPrecision(6), offset: fit.offset.map(v => +v.toFixed(4)), sample_matched: fit.hits, of: sample.length};
		let corner_key = positions.map(p => nearest(fit.place(p)));
		let faces_of = new Map();	// vertex key -> triangle face keys using it
		for (let fkey in mesh.faces) {
			let face = mesh.faces[fkey];
			if (face.vertices.length != 3) continue;
			for (let v of face.vertices) { if (!faces_of.has(v)) faces_of.set(v, new Set()); faces_of.get(v).add(fkey); }
		}
		let consumed = new Set();
		for (let polygon of polygons) {
			let corners = polygon.map(i => corner_key[i]);
			if (corners.some(k => !k) || new Set(corners).size != corners.length) { report.unmatched_corner++; continue; }
			let corner_set = new Set(corners);
			let tri_keys = new Set();
			for (let k of corners) for (let fkey of faces_of.get(k) || []) {
				if (!consumed.has(fkey) && mesh.faces[fkey] && mesh.faces[fkey].vertices.every(v => corner_set.has(v))) tri_keys.add(fkey);
			}
			if (tri_keys.size != corners.length - 2) { report.triangles_missing++; continue; }
			let tris = [...tri_keys].map(k => mesh.faces[k]), first = tris[0];
			let same = tris.every(t => t.texture === first.texture && Object.keys(MeshFace.properties).every(p => p == 'vertices' || p == 'uv' || JSON.stringify(t[p]) === JSON.stringify(first[p])));
			let uv = {}, uv_ok = true;
			let textured = !!first.getTexture();
			for (let t of tris) for (let v of t.vertices) {
				if (uv[v] === undefined) uv[v] = t.uv[v];
				else if (textured && !sameUV(uv[v], t.uv[v])) uv_ok = false;
			}
			let flat_box = !uv_ok && same ? flatUVBox(tris) : null;
			if (!same || (!uv_ok && !flat_box)) { report.seam_or_texture++; continue; }
			// pieces: the polygon itself for four corners, else a fan from the first corner
			let pieces = corners.length == 4 ? [corners] : [];
			for (let start = 1; corners.length > 4 && start < corners.length - 1; start += 2) pieces.push([corners[0], ...corners.slice(start, Math.min(start + 3, corners.length))]);
			let first_normal = worldNormal(mesh, first);
			let faces = [], ok = true;
			for (let order of pieces) {
				let face = new MeshFace(mesh, {...first, vertices: order, uv: flat_box ? cellUVs(order, flat_box) : Object.fromEntries(order.map(v => [v, uv[v]]))});
				if (worldNormal(mesh, face).dot(first_normal) < 0) { face.vertices = order.slice().reverse(); order = face.vertices; }
				if (order.length == 4 && !face.getSortedVertices().every((v, j) => v == order[j])) { ok = false; break; }
				faces.push(face);
			}
			if (!ok) { report.diagonal++; continue; }
			let removed = [...tri_keys];
			removed.forEach(k => { delete mesh.faces[k]; consumed.add(k); });
			mesh.faces[removed[0]] = faces[0];
			mesh.addFaces(...faces.slice(1));
			report.joined++;
			report.faces_made += faces.length;
		}
	}
	Undo.finishEdit('Quads from OBJ reference');
	Canvas.updateView({elements: meshes, element_aspects: {geometry: true, uv: true, faces: true}, selection: true});
	let skipped = [];
	if (report.unmatched_corner) skipped.push(`${report.unmatched_corner} with a corner matching no vertex`);
	if (report.triangles_missing) skipped.push(`${report.triangles_missing} whose triangles were not all there`);
	if (report.seam_or_texture) skipped.push(`${report.seam_or_texture} across a texture or uv seam`);
	if (report.diagonal) skipped.push(`${report.diagonal} that would change diagonal`);
	Blockbench.showQuickMessage(`${report.joined} of ${report.polygons} reference polygons joined${skipped.length ? '; kept as triangles: ' + skipped.join(', ') : ''}`, QUADS.MESSAGE_TIME * 2);
	return report;
}

BARS.defineActions(function() {
	new Action('dew_quads_from_obj', {
		name: 'Quads from OBJ Reference',
		description: 'Rebuild the selected meshes\' quads and n-gons from an OBJ of the same asset: its polygons are matched by position and the triangles a glTF export cut them into are joined back exactly. Materials, textures and rig stay as imported',
		icon: 'grid_on',
		category: 'edit',
		condition: () => Modes.edit && Mesh.selected.length,
		click() {
			Blockbench.import({resource_id: 'model', extensions: ['obj'], type: 'OBJ reference', readtype: 'text'}, files => {
				if (files[0]?.content) quadsFromOBJ(Mesh.selected, files[0].content);
			});
		},
	});
});

Object.assign(window, {DEWQuads: {QUADS, QUADS_REF, mergeTrianglesToQuads, flipSharedEdge, toggleEdgeBoundary, quadsFromOBJ}});
