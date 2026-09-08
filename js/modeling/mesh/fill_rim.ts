/**
 * Closing open rims with faces.
 *
 * A rim is a closed loop of open edges (edges used by exactly one face). A loop is tiled
 * with quads (and a triangle when the count is odd) by splitting it recursively at the
 * diagonal that keeps both halves as flat as possible, so a bent rim gets its crease and a
 * flat rim gets an orderly cap. New faces are oriented to match their neighbours.
 */

type Vec3 = ArrayVector3;
type RimLoop = {loop: string[], reference_face: MeshFace};

function edgeKey(a: string, b: string) {
	return a < b ? a + '|' + b : b + '|' + a;
}

/**
 * Finds every closed loop of open edges whose vertices are all in `candidates`.
 * Vertices that are not on exactly two such open edges are ignored.
 */
export function findRimLoops(mesh: Mesh, candidates: string[]): RimLoop[] {
	if (candidates.length < 3) return [];

	let edge_usage = new Map<string, {edge: [string, string], count: number, face: MeshFace}>();
	for (let fkey in mesh.faces) {
		let face = mesh.faces[fkey];
		if (face.vertices.length < 3) continue;
		let sorted = face.getSortedVertices();
		for (let i = 0; i < sorted.length; i++) {
			let a = sorted[i], b = sorted[(i + 1) % sorted.length];
			let key = edgeKey(a, b);
			let entry = edge_usage.get(key);
			if (entry) {
				entry.count++;
			} else {
				edge_usage.set(key, {edge: [a, b], count: 1, face});
			}
		}
	}

	let adjacency = new Map<string, string[]>();
	let edge_faces = new Map<string, MeshFace>();
	for (let {edge, count, face} of edge_usage.values()) {
		if (count != 1) continue;
		if (!candidates.includes(edge[0]) || !candidates.includes(edge[1])) continue;
		if (!adjacency.has(edge[0])) adjacency.set(edge[0], []);
		if (!adjacency.has(edge[1])) adjacency.set(edge[1], []);
		adjacency.get(edge[0]).push(edge[1]);
		adjacency.get(edge[1]).push(edge[0]);
		edge_faces.set(edgeKey(edge[0], edge[1]), face);
	}

	let loops: RimLoop[] = [];
	let visited = new Set<string>();
	for (let start of candidates) {
		if (visited.has(start) || adjacency.get(start)?.length != 2) continue;
		let loop = [start];
		let previous: string = null;
		let current = start;
		let closed = false;
		while (true) {
			let neighbours = adjacency.get(current);
			if (!neighbours || neighbours.length != 2) break;
			let next = neighbours.find(vkey => vkey != previous);
			if (next == start) {
				closed = true;
				break;
			}
			if (!next || loop.includes(next)) break;
			loop.push(next);
			previous = current;
			current = next;
		}
		loop.forEach(vkey => visited.add(vkey));
		if (closed && loop.length >= 3) {
			loops.push({loop, reference_face: edge_faces.get(edgeKey(loop[0], loop[1]))});
		}
	}
	return loops;
}

function distance(a: Vec3, b: Vec3) {
	return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/** Largest distance of any vertex from the loop's best-fit plane, relative to the loop's size. 0 for triangles. */
function planarityError(mesh: Mesh, loop: string[], scale: number): number {
	if (loop.length <= 3 || scale == 0) return 0;
	let normal = [0, 0, 0];
	let center = [0, 0, 0];
	for (let i = 0; i < loop.length; i++) {
		let a = mesh.vertices[loop[i]];
		let b = mesh.vertices[loop[(i + 1) % loop.length]];
		normal[0] += (a[1] - b[1]) * (a[2] + b[2]);
		normal[1] += (a[2] - b[2]) * (a[0] + b[0]);
		normal[2] += (a[0] - b[0]) * (a[1] + b[1]);
		center[0] += a[0]; center[1] += a[1]; center[2] += a[2];
	}
	let length = Math.sqrt(normal[0] ** 2 + normal[1] ** 2 + normal[2] ** 2);
	if (length == 0) return 0;
	normal = normal.map(v => v / length);
	center = center.map(v => v / loop.length);
	let max_distance = 0;
	for (let vkey of loop) {
		let v = mesh.vertices[vkey];
		let d = Math.abs((v[0] - center[0]) * normal[0] + (v[1] - center[1]) * normal[1] + (v[2] - center[2]) * normal[2]);
		if (d > max_distance) max_distance = d;
	}
	return max_distance / scale;
}

/** Recursively splits a loop into pieces of at most 4 vertices. */
function splitLoop(mesh: Mesh, loop: string[], scale: number, output: string[][]) {
	if (loop.length <= 4) {
		output.push(loop);
		return;
	}
	let n = loop.length;
	let best: {score: number, a: string[], b: string[]} = null;
	for (let i = 0; i < n; i++) {
		for (let j = i + 2; j < n; j++) {
			if (i == 0 && j == n - 1) continue; // that pair is a rim edge, not a diagonal
			let side_a = loop.slice(i, j + 1);
			let side_b = loop.slice(j).concat(loop.slice(0, i + 1));
			if (side_a.length < 3 || side_b.length < 3) continue;

			// Flatness dominates; prefer all-quad splits, then short diagonals
			let flatness = planarityError(mesh, side_a, scale) + planarityError(mesh, side_b, scale);
			let parity = (side_a.length % 2) + (side_b.length % 2);
			let diagonal = distance(mesh.vertices[loop[i]], mesh.vertices[loop[j]]) / scale;
			let score = flatness * 10 + parity * 0.05 + diagonal * 0.1;
			if (!best || score < best.score) best = {score, a: side_a, b: side_b};
		}
	}
	if (!best) {
		output.push(loop);
		return;
	}
	splitLoop(mesh, best.a, scale, output);
	splitLoop(mesh, best.b, scale, output);
}

/** +1 if a→b follows the face's winding, -1 if b→a does, 0 if a-b is not an edge of the face */
function edgeDirection(face: MeshFace, a: string, b: string): number {
	let sorted = face.getSortedVertices();
	let ia = sorted.indexOf(a), ib = sorted.indexOf(b);
	if (ia < 0 || ib < 0) return 0;
	if ((ia + 1) % sorted.length == ib) return 1;
	if ((ib + 1) % sorted.length == ia) return -1;
	return 0;
}

/** Orients the given new faces so that each shares every edge with its neighbour in opposite directions */
function orientNewFaces(mesh: Mesh, new_faces: MeshFace[]) {
	let oriented = new Set<MeshFace>();
	for (let fkey in mesh.faces) {
		if (!new_faces.includes(mesh.faces[fkey])) oriented.add(mesh.faces[fkey]);
	}
	let progress = true;
	while (progress) {
		progress = false;
		for (let face of new_faces) {
			if (oriented.has(face)) continue;
			let sorted = face.getSortedVertices();
			let fixed = false;
			for (let i = 0; i < sorted.length && !fixed; i++) {
				let a = sorted[i], b = sorted[(i + 1) % sorted.length];
				for (let other of oriented) {
					if (other.vertices.length < 3) continue;
					let other_direction = edgeDirection(other, a, b);
					if (other_direction == 0) continue;
					if (other_direction == edgeDirection(face, a, b)) face.invert();
					fixed = true;
					break;
				}
			}
			if (fixed) {
				oriented.add(face);
				progress = true;
			}
		}
	}
}

/** Tiles one rim loop with faces. Returns the new face keys. */
export function fillRimLoop(mesh: Mesh, {loop, reference_face}: RimLoop): string[] {
	let scale = 0;
	for (let i = 0; i < loop.length; i++) {
		for (let j = i + 1; j < loop.length; j++) {
			scale = Math.max(scale, distance(mesh.vertices[loop[i]], mesh.vertices[loop[j]]));
		}
	}
	let pieces: string[][] = [];
	splitLoop(mesh, loop, scale, pieces);

	let new_keys: string[] = [];
	let new_faces: MeshFace[] = [];
	for (let piece of pieces) {
		if (piece.length < 3) continue;
		let face = new MeshFace(mesh, {vertices: piece, texture: reference_face?.texture});
		let [key] = mesh.addFaces(face);
		new_keys.push(key);
		new_faces.push(face);
	}
	orientNewFaces(mesh, new_faces);
	return new_keys;
}

/**
 * Fills the rim formed by the selected vertices. Returns the keys of the new faces,
 * or null if the selection is not exactly one closed rim covering all selected vertices.
 */
export function fillSelectedRim(mesh: Mesh, selected: string[]): string[] | null {
	let loops = findRimLoops(mesh, selected);
	if (loops.length != 1 || loops[0].loop.length != selected.length) return null;
	return fillRimLoop(mesh, loops[0]);
}

/** Fills every closed rim found among the candidate vertices. */
export function fillAllRims(mesh: Mesh, candidates: string[]): {faces: string[], loops: number} {
	let loops = findRimLoops(mesh, candidates);
	let faces: string[] = [];
	for (let loop of loops) {
		faces.push(...fillRimLoop(mesh, loop));
	}
	return {faces, loops: loops.length};
}
