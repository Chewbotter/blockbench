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
			if (textured && (!sameUV(f1.uv[a], f2.uv[a]) || !sameUV(f1.uv[b], f2.uv[b]))) { why.uv_seam++; continue; }
			let order = [c, a, d, b];
			let points = order.map(point);
			if (!convex(points, n1)) { why.concave++; continue; }
			candidates.push({fkeys, order, skew: skew(points), normal: n1, texture: f1.texture, uv: {[a]: f1.uv[a], [b]: f1.uv[b], [c]: f1.uv[c], [d]: f2.uv[d]}});
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
export function toggleEdgeBoundary(mesh, a, b) {
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
		if (f1.texture !== f2.texture) return {error: 'This edge separates different textures'};
		for (let property in MeshFace.properties) {
			if (property != 'vertices' && property != 'uv' && JSON.stringify(f1[property]) !== JSON.stringify(f2[property])) {
				return {error: 'This edge separates different face settings, such as smoothing groups'};
			}
		}
		if (f1.getTexture() && (!sameUV(f1.uv[a], f2.uv[a]) || !sameUV(f1.uv[b], f2.uv[b]))) {
			return {error: 'This edge is a UV seam; joining it would change the texture'};
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
		description: 'Click a triangle edge to join a quad, or an orange quad diagonal to split it into triangles',
		icon: 'border_inner',
		category: 'tools',
		transformerMode: 'hidden',
		selectElements: false,
		cursor: 'pointer',
		raycast_options: {turn_edges: true},
		modes: ['edit'],
		condition: () => Modes.edit && Format.meshes,
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
			let result = toggleEdgeBoundary(mesh, ...best);
			if (result.error) Blockbench.showQuickMessage(result.error, QUADS.MESSAGE_TIME);
		},
		onSelect() { Mesh.selected.forEach(mesh => mesh.preview_controller.updateSelection(mesh)); },
		onUnselect() { setTimeout(() => Mesh.selected.forEach(mesh => mesh.preview_controller.updateSelection(mesh)), 0); },
	});
});

Object.assign(window, {DEWQuads: {QUADS, mergeTrianglesToQuads, flipSharedEdge, toggleEdgeBoundary}});
