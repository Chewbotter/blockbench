// Merge Triangles into Quads: a glTF import arrives as triangles, since the format has no quads, so every
// diagonal is a face border and Blockbench draws it. Pairs of triangles that share an edge, lie in one plane,
// carry the same texture with continuous uvs and make a convex four-sided face become one quad, which is what a
// native model would hold. Folded pairs, uv seams and unpaired triangles stay as they are.
import { THREE } from "../lib/libs";

export const QUADS = {
	MAX_ANGLE: 5,			// degrees between the two triangles' normals for them to count as one plane
	WELD_DISTANCE: 0.001,	// vertices closer than this are one vertex: importers split them wherever normals or uvs differ
	MESSAGE_TIME: 3000,
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

Object.assign(window, {DEWQuads: {QUADS, mergeTrianglesToQuads}});
