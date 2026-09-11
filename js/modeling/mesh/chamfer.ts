import { splitLoop, orientNewFaces } from './fill_rim';
import { canvasGridSize } from '../../misc';

/**
 * Chamfer edges: each selected edge is replaced by a flat face a set distance wide, centred on
 * the old edge. The new vertices slide along the existing edges of the neighbouring faces, so
 * the cut stays in line with the surrounding geometry. Where a run of chamfered edges meets at
 * a vertex, the corner closes with a triangle (or a small polygon); where a chamfer ends at a
 * vertex that stays, a triangle closes the gap. Faces that end up with more than four vertices
 * are split the same way rim filling splits them.
 */

type Vec3 = ArrayVector3;
type Edge = [string, string];

// New vertices slide at most this fraction of their edge, so a wide chamfer cannot cross over
const MAX_EDGE_FRACTION = 0.5;
// Angles flatter than this (degrees) between an edge and the chamfered edge count as parallel
const MIN_ANGLE = 5;

let last_distance: number = null;

function edgeKey(a: string, b: string) {
	return a < b ? a + '|' + b : b + '|' + a;
}
function sub(a: Vec3, b: Vec3): Vec3 {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function length(v: Vec3) {
	return Math.hypot(v[0], v[1], v[2]);
}
function normalize(v: Vec3): Vec3 {
	let l = length(v) || 1;
	return [v[0] / l, v[1] / l, v[2] / l];
}
function angleBetween(u: Vec3, w: Vec3) {
	let dot = Math.clamp(u[0] * w[0] + u[1] * w[1] + u[2] * w[2], -1, 1);
	return Math.acos(dot);
}
function lerpUV(a: number[], b: number[], f: number): number[] {
	if (!a || !b) return a ? a.slice() : (b ? b.slice() : [0, 0]);
	return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/** A face's corner at vertex v: the neighbours of v along the face's winding */
type Corner = {fkey: string, face: MeshFace, prev: string, next: string};

/**
 * Chamfers the given edges of the mesh. Returns the keys of the chamfer faces (one per edge)
 * and of the corner faces that close vertices where chamfers meet or end.
 */
export function chamferEdges(mesh: Mesh, edges: Edge[], distance: number): {chamfer_faces: string[], corner_faces: string[]} {
	let selected = new Set<string>();
	let edge_faces = new Map<string, string[]>();
	let corners = new Map<string, Corner[]>();
	for (let fkey in mesh.faces) {
		let face = mesh.faces[fkey];
		if (face.vertices.length < 3) continue;
		let sorted = face.getSortedVertices();
		for (let i = 0; i < sorted.length; i++) {
			let v = sorted[i];
			let prev = sorted[(i + sorted.length - 1) % sorted.length];
			let next = sorted[(i + 1) % sorted.length];
			if (!corners.has(v)) corners.set(v, []);
			corners.get(v).push({fkey, face, prev, next});
			let key = edgeKey(v, next);
			if (!edge_faces.has(key)) edge_faces.set(key, []);
			edge_faces.get(key).push(fkey);
		}
	}
	// Only edges shared by two faces can be chamfered
	for (let [a, b] of edges) {
		let key = edgeKey(a, b);
		if (edge_faces.get(key)?.length == 2) selected.add(key);
	}
	if (!selected.size) return {chamfer_faces: [], corner_faces: []};

	let affected = new Set<string>();
	for (let key of selected) key.split('|').forEach(v => affected.add(v));

	// Per face and vertex: the vertices that replace v in that face, in the face's winding order
	let replacements = new Map<string, string[]>(); // `${fkey}|${v}`
	let new_uvs = new Map<string, Record<string, number[]>>(); // fkey -> vkey -> uv
	let removed_vertices: string[] = [];
	let absorbed = new Set<string>(); // staying vertices that join their chamfer face instead of getting a corner triangle
	let corner_polygons: {loop: string[], reference: MeshFace}[] = [];

	function setUV(fkey: string, vkey: string, uv: number[]) {
		if (!new_uvs.has(fkey)) new_uvs.set(fkey, {});
		new_uvs.get(fkey)[vkey] = uv;
	}

	for (let v of affected) {
		let fan = corners.get(v) || [];
		let pos = mesh.vertices[v];
		let isSelected = (x: string) => selected.has(edgeKey(v, x));

		// Slide distance along an unselected edge (v, x) needed to be `distance` away from the selected edge (v, y)
		function slideAlong(x: string, y: string) {
			let u = normalize(sub(mesh.vertices[x], pos));
			let w = normalize(sub(mesh.vertices[y], pos));
			let angle = Math.max(angleBetween(u, w), Math.degToRad(MIN_ANGLE));
			return distance / Math.sin(angle);
		}
		// One new vertex per unselected edge at v that a neighbouring chamfer slides onto
		let slid = new Map<string, {key: string, fraction: number}>(); // neighbour x -> vertex on edge (v, x)
		let neighbours = new Set<string>();
		for (let corner of fan) { neighbours.add(corner.prev); neighbours.add(corner.next); }
		for (let x of neighbours) {
			if (isSelected(x)) continue;
			let slides: number[] = [];
			for (let corner of fan) {
				if (corner.prev == x && isSelected(corner.next)) slides.push(slideAlong(x, corner.next));
				if (corner.next == x && isSelected(corner.prev)) slides.push(slideAlong(x, corner.prev));
			}
			if (!slides.length) continue;
			let edge_length = length(sub(mesh.vertices[x], pos));
			let t = Math.min(slides.reduce((a, b) => a + b, 0) / slides.length, edge_length * MAX_EDGE_FRACTION);
			let dir = normalize(sub(mesh.vertices[x], pos));
			let [key] = mesh.addVertices([pos[0] + dir[0] * t, pos[1] + dir[1] * t, pos[2] + dir[2] * t]);
			slid.set(x, {key, fraction: t / edge_length});
		}
		// v survives if some unselected edge at v has no chamfer next to it in any of its faces
		let stays = [...neighbours].some(x => !isSelected(x) && fan.every(corner => {
			if (corner.prev == x) return !isSelected(corner.next);
			if (corner.next == x) return !isSelected(corner.prev);
			return true;
		}));
		if (!stays) removed_vertices.push(v);

		for (let corner of fan) {
			let {fkey, face, prev, next} = corner;
			let sp = isSelected(prev), sn = isSelected(next);
			let list: string[];
			if (sp && sn) {
				// Both edges chamfered: the corner moves diagonally into the face, `distance` from both edges
				let u1 = normalize(sub(mesh.vertices[prev], pos));
				let u2 = normalize(sub(mesh.vertices[next], pos));
				let angle = Math.max(angleBetween(u1, u2), Math.degToRad(MIN_ANGLE));
				let k = distance / Math.sin(angle);
				let l1 = length(sub(mesh.vertices[prev], pos)), l2 = length(sub(mesh.vertices[next], pos));
				k = Math.min(k, l1 * MAX_EDGE_FRACTION, l2 * MAX_EDGE_FRACTION);
				let [key] = mesh.addVertices([pos[0] + (u1[0] + u2[0]) * k, pos[1] + (u1[1] + u2[1]) * k, pos[2] + (u1[2] + u2[2]) * k]);
				let uv_v = face.uv[v] || [0, 0];
				let uv_p = lerpUV(uv_v, face.uv[prev], k / l1), uv_n = lerpUV(uv_v, face.uv[next], k / l2);
				setUV(fkey, key, [uv_p[0] + uv_n[0] - uv_v[0], uv_p[1] + uv_n[1] - uv_v[1]]);
				list = [key];
			} else {
				list = [];
				let onto_prev = slid.get(prev), onto_next = slid.get(next);
				if (onto_prev && !sp) {
					list.push(onto_prev.key);
					setUV(fkey, onto_prev.key, lerpUV(face.uv[v], face.uv[prev], onto_prev.fraction));
				}
				if (!sp && !sn && stays) list.push(v);
				if (onto_next && !sn) {
					list.push(onto_next.key);
					setUV(fkey, onto_next.key, lerpUV(face.uv[v], face.uv[next], onto_next.fraction));
				}
			}
			replacements.set(fkey + '|' + v, list);
		}

		// Walk the fan of faces around v. If it closes, the ring of replacement vertices bounds
		// a gap at the corner that gets its own face.
		let start = fan[0];
		let ring: string[] = [];
		let current = start;
		let enter_via_prev = true;
		let closed = false;
		let guard = 0;
		while (current && guard++ < fan.length + 1) {
			let list = replacements.get(current.fkey + '|' + v) || [];
			ring.push(...(enter_via_prev ? list : list.slice().reverse()));
			let exit = enter_via_prev ? current.next : current.prev;
			let next_corner = fan.find(c => c != current && (c.prev == exit || c.next == exit));
			if (!next_corner) break;
			if (next_corner == start) { closed = true; break; }
			enter_via_prev = next_corner.prev == exit;
			current = next_corner;
		}
		if (closed) {
			let unique: string[] = [];
			for (let key of ring) if (unique[unique.length - 1] != key) unique.push(key);
			while (unique.length > 1 && unique[0] == unique[unique.length - 1]) unique.pop();
			if (unique.length == 3 && unique.includes(v)) {
				// A single chamfer ending at a vertex that stays: the vertex joins the chamfer face,
				// which is then split. That avoids a zero-area triangle where the surroundings are flat.
				absorbed.add(v);
			} else if (unique.length >= 3) {
				corner_polygons.push({loop: unique, reference: start.face});
			}
		}
	}

	// Rebuild every face that touches an affected vertex
	let touched = new Set<string>();
	for (let v of affected) for (let corner of corners.get(v) || []) touched.add(corner.fkey);
	let scale = 0;
	for (let key of selected) {
		let [a, b] = key.split('|');
		scale = Math.max(scale, length(sub(mesh.vertices[a], mesh.vertices[b])));
	}
	for (let fkey of touched) {
		let face = mesh.faces[fkey];
		let uv: Record<string, number[]> = Object.assign({}, face.uv, new_uvs.get(fkey) || {});
		let sequence: string[] = [];
		for (let v of face.getSortedVertices()) {
			if (affected.has(v)) sequence.push(...(replacements.get(fkey + '|' + v) || []));
			else sequence.push(v);
		}
		let unique: string[] = [];
		for (let key of sequence) if (!unique.includes(key)) unique.push(key);
		delete mesh.faces[fkey];
		if (unique.length < 3) continue;
		let pieces: string[][] = [];
		splitLoop(mesh, unique, Math.max(scale, 1), pieces);
		for (let piece of pieces) {
			let piece_uv: Record<string, number[]> = {};
			piece.forEach(vkey => { piece_uv[vkey] = uv[vkey] ? uv[vkey].slice() : [0, 0]; });
			mesh.addFaces(new MeshFace(mesh, {vertices: piece, uv: piece_uv, texture: face.texture}));
		}
	}

	// Chamfer faces, one per edge, between the replacement vertices of the two faces
	let new_faces: MeshFace[] = [];
	let chamfer_faces: string[] = [];
	for (let key of selected) {
		let [a, b] = key.split('|');
		let [f1, f2] = edge_faces.get(key);
		let a1 = replacements.get(f1 + '|' + a)?.[0], b1 = replacements.get(f1 + '|' + b)?.[0];
		let a2 = replacements.get(f2 + '|' + a)?.[0], b2 = replacements.get(f2 + '|' + b)?.[0];
		let ring = [a1, b1];
		if (absorbed.has(b)) ring.push(b);
		ring.push(b2, a2);
		if (absorbed.has(a)) ring.push(a);
		let vertices = ring.filter((v, i, arr) => v && arr.indexOf(v) == i);
		if (vertices.length < 3) continue;
		let texture = corners.get(a).find(c => c.fkey == f1)?.face.texture;
		let pieces: string[][] = [];
		splitLoop(mesh, vertices, Math.max(scale, 1), pieces);
		for (let piece of pieces) {
			let face = new MeshFace(mesh, {vertices: piece, texture});
			let [fkey] = mesh.addFaces(face);
			chamfer_faces.push(fkey);
			new_faces.push(face);
		}
	}
	// Corner faces
	let corner_faces: string[] = [];
	for (let {loop, reference} of corner_polygons) {
		let pieces: string[][] = [];
		splitLoop(mesh, loop, Math.max(scale, 1), pieces);
		for (let piece of pieces) {
			let face = new MeshFace(mesh, {vertices: piece, texture: reference.texture});
			let [fkey] = mesh.addFaces(face);
			corner_faces.push(fkey);
			new_faces.push(face);
		}
	}
	orientNewFaces(mesh, new_faces);

	for (let v of removed_vertices) delete mesh.vertices[v];
	return {chamfer_faces, corner_faces};
}

new Action('chamfer_edges', {
	icon: 'rounded_corner',
	category: 'edit',
	condition: {modes: ['edit'], features: ['meshes'], method: () => Mesh.selected.some(mesh => mesh.getSelectedEdges().length > 0)},
	click() {
		let distance = last_distance ?? canvasGridSize(false, false);
		function runEdit(amended: boolean, distance: number) {
			Undo.initEdit({elements: Mesh.selected, selection: true}, amended);
			let all_new_faces: string[] = [];
			for (let mesh of Mesh.selected) {
				let edges = mesh.getSelectedEdges().slice() as Edge[];
				if (!edges.length) continue;
				let {chamfer_faces, corner_faces} = chamferEdges(mesh, edges, distance);
				let faces = chamfer_faces.concat(corner_faces);
				all_new_faces.push(...faces);
				// Select the chamfer faces
				let selection = Project.mesh_selection[mesh.uuid];
				selection.faces.replace(chamfer_faces);
				selection.vertices.replace([...new Set(chamfer_faces.flatMap(fkey => mesh.faces[fkey].vertices))]);
				selection.edges.replace(chamfer_faces.flatMap(fkey => {
					let sorted = mesh.faces[fkey].getSortedVertices();
					return sorted.map((v, i) => [v, sorted[(i + 1) % sorted.length]]);
				}));
			}
			UVEditor.setAutoSize(null, true, all_new_faces);
			Undo.finishEdit('Chamfer edges');
			Canvas.updateView({elements: Mesh.selected, element_aspects: {geometry: true, uv: true, faces: true}, selection: true});
		}
		runEdit(false, distance);

		Undo.amendEdit({
			distance: {type: 'num_slider', value: distance, label: 'edit.chamfer_edges.distance', min: 0.01, interval_type: 'position'},
		}, form => {
			last_distance = form.distance;
			runEdit(true, form.distance);
		});
	}
});
