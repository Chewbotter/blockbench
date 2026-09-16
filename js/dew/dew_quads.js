// Merge Triangles into Quads: a glTF import arrives as triangles, since the format has no quads, so every
// diagonal is a face border and Blockbench draws it. Pairs of triangles that share an edge, lie in one plane,
// carry the same texture with continuous uvs and make a convex four-sided face become one quad, which is what a
// native model would hold. Folded pairs, uv seams and unpaired triangles stay as they are.
import { THREE } from "../lib/libs";

export const QUADS = {
	MAX_ANGLE: 5,			// degrees between the two triangles' normals for them to count as one plane
	MESSAGE_TIME: 3000,
};

function worldNormal(mesh, face) {
	let n = face.getNormal(true);
	return new THREE.Vector3().fromArray(Array.isArray(n) ? n : n.toArray());
}
const sameUV = (a, b) => a && b && Math.abs(a[0] - b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4;

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

export function mergeTrianglesToQuads(meshes = Mesh.selected) {
	meshes = meshes.filter(mesh => mesh instanceof Mesh);
	if (!meshes.length) return null;
	let min_dot = Math.cos(QUADS.MAX_ANGLE * Math.PI / 180);
	let merged = 0, left = 0;
	Undo.initEdit({elements: meshes});
	for (let mesh of meshes) {
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
			let [f1, f2] = fkeys.map(fkey => mesh.faces[fkey]);
			if (f1.texture !== f2.texture) continue;
			let n1 = worldNormal(mesh, f1), n2 = worldNormal(mesh, f2);
			if (n1.dot(n2) < min_dot) continue;
			let [a, b] = key.split('|');
			let c = f1.vertices.find(v => v != a && v != b), d = f2.vertices.find(v => v != a && v != b);
			if (!c || !d || c == d) continue;
			// The shared edge must read the same texture from both sides, or the diagonal is a uv seam
			if (!sameUV(f1.uv[a], f2.uv[a]) || !sameUV(f1.uv[b], f2.uv[b])) continue;
			let order = [c, a, d, b];
			let points = order.map(point);
			if (!convex(points, n1)) continue;
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
	if (!merged) {
		Undo.cancelEdit();
		Blockbench.showQuickMessage('No triangle pairs to merge', QUADS.MESSAGE_TIME);
		return {merged, left};
	}
	Undo.finishEdit('Merge triangles into quads');
	Canvas.updateView({elements: meshes, element_aspects: {geometry: true, faces: true, uv: true}, selection: true});
	Blockbench.showQuickMessage(`Merged ${merged} pairs into quads, ${left} triangles left`, QUADS.MESSAGE_TIME);
	return {merged, left};
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
