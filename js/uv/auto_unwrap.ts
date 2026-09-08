import { THREE } from '../lib/libs';
import { ToolConfig } from '../interface/dialog';

/**
 * Auto Unwrap: lays out the UVs of whole meshes as a paint-ready base.
 *
 * 1. Faces are grown into islands across shared edges (up to a bend angle, seams override),
 *    each face unfolded flat by hinging around the shared edge, rejecting any overlap.
 * 2. Each island is rotated to its dominant edge direction to keep its footprint small.
 * 3. Islands are laid out in rows inside a square at a uniform scale, so every face gets
 *    texture space proportional to its real size, then scaled to fill the UV square.
 *
 * The result is independent of the texture resolution: it fills the project UV square,
 * whatever size a texture created afterwards has.
 */

type UV = [number, number];

interface Island {
	element: Mesh | Cube;
	keys: string[];
	/** face key -> vertex key -> [u, v] in model units (island-local, min at 0) */
	uvs: Record<string, Record<string, UV>>;
	/** outline per face, island-local */
	polygons: UV[][];
	width: number;
	height: number;
	bbox_area: number;
	allow_rotation: boolean;
	// packing result
	rotated?: boolean;
	pos?: [number, number];
}

function roundTo(value: number, digits: number) {
	let f = Math.pow(10, digits);
	return Math.round(value * f) / f;
}
function sub(a: UV, b: UV): UV {
	return [a[0] - b[0], a[1] - b[1]];
}
function pointInPolygon(point: UV, polygon: UV[]): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		let a = polygon[i], b = polygon[j];
		if ((a[1] > point[1]) != (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) {
			inside = !inside;
		}
	}
	return inside;
}
function polygonCentroid(polygon: UV[]): UV {
	let c: UV = [0, 0];
	polygon.forEach(p => { c[0] += p[0] / polygon.length; c[1] += p[1] / polygon.length; });
	return c;
}

// MARK: Islands

function buildMeshIslands(mesh: Mesh, max_edge_angle: number): Island[] {
	let vec1 = new THREE.Vector3(), vec2 = new THREE.Vector3(), vec3 = new THREE.Vector3(), vec4 = new THREE.Vector3();

	let entries = Object.keys(mesh.faces).map(key => ({key, face: mesh.faces[key]})).filter(e => e.face.vertices.length >= 3);
	// Start islands from the most axis-aligned faces, like the texture template does
	function straightness(normal: number[]) {
		let a = normal.map(Math.abs);
		return (a[0] < 0.5 ? a[0] : 1 - a[0]) * 1.6 + (a[1] < 0.5 ? a[1] : 1 - a[1]) + (a[2] < 0.5 ? a[2] : 1 - a[2]);
	}
	entries.sort((a, b) => straightness(a.face.getNormal(true)) - straightness(b.face.getNormal(true)));

	let vkey_fkey_map: Record<string, string[]> = {};
	for (let {key, face} of entries) {
		for (let vkey of face.vertices) {
			(vkey_fkey_map[vkey] ??= []).push(key);
		}
	}

	function projectFace(face: MeshFace, fkey: string, island: Island, connection?: {face: MeshFace, fkey: string, edge: string[]}): boolean {
		let normal_vec = vec1.fromArray(face.getNormal(true));
		let plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal_vec, vec2.fromArray(mesh.vertices[face.vertices[0]]));
		let rot = cameraTargetToRotation([0, 0, 0], normal_vec.toArray());
		let euler = new THREE.Euler(Math.degToRad(rot[1] - 90), Math.degToRad(rot[0] + 180), 0);

		let face_uvs: Record<string, UV> = {};
		face.vertices.forEach(vkey => {
			let p = plane.projectPoint(vec3.fromArray(mesh.vertices[vkey]), vec4);
			p.applyEuler(euler);
			face_uvs[vkey] = [roundTo(p.x, 4), roundTo(p.z, 4)];
		});

		if (connection) {
			let other_uvs = island.uvs[connection.fkey];
			let [hinge_key, latch_key] = connection.edge;
			// Move hinge onto the neighbour's hinge
			let offset = sub(face_uvs[hinge_key], other_uvs[hinge_key]);
			for (let vkey in face_uvs) face_uvs[vkey] = sub(face_uvs[vkey], offset);
			// Rotate around the hinge so the latch lines up too
			let hinge = face_uvs[hinge_key].slice() as UV;
			let latch = face_uvs[latch_key];
			let lock = other_uvs[latch_key];
			let angle = Math.atan2(hinge[0] - latch[0], hinge[1] - latch[1]) - Math.atan2(hinge[0] - lock[0], hinge[1] - lock[1]);
			let s = Math.sin(angle), c = Math.cos(angle);
			for (let vkey in face_uvs) {
				let p = sub(face_uvs[vkey], hinge);
				face_uvs[vkey] = [p[0] * c - p[1] * s + hinge[0], p[0] * s + p[1] * c + hinge[1]];
			}

			// Reject if the unfolded face overlaps any face already in the island
			let polygon = face.getSortedVertices().map(vkey => face_uvs[vkey]);
			let same = (a: UV, b: UV) => Math.epsilon(a[0], b[0], 0.1) && Math.epsilon(a[1], b[1], 0.1);
			for (let other_key of island.keys) {
				let other_face = mesh.faces[other_key];
				let other_polygon = other_face.getSortedVertices().map(vkey => island.uvs[other_key][vkey]);
				for (let i = 0; i < polygon.length; i++) {
					let a1 = polygon[i], a2 = polygon[(i + 1) % polygon.length];
					for (let j = 0; j < other_polygon.length; j++) {
						let b1 = other_polygon[j], b2 = other_polygon[(j + 1) % other_polygon.length];
						if (intersectLines(a1, a2, b1, b2) && !same(a1, b1) && !same(a1, b2) && !same(a2, b1) && !same(a2, b2)) {
							return false;
						}
					}
				}
				if (other_face !== connection.face) {
					if (pointInPolygon(polygonCentroid(polygon), other_polygon) || pointInPolygon(polygonCentroid(other_polygon), polygon)) return false;
				} else {
					// Folded back onto its own neighbour
					if (pointInPolygon(polygonCentroid(polygon), other_polygon)) return false;
				}
			}
		}
		island.uvs[fkey] = face_uvs;
		return true;
	}

	let islands: Island[] = [];
	let processed = new Set<string>();
	for (let start of entries) {
		if (processed.has(start.key)) continue;
		let island: Island = {element: mesh, keys: [], uvs: {}, polygons: [], width: 0, height: 0, bbox_area: 0, allow_rotation: true};
		projectFace(start.face, start.key, island);
		island.keys.push(start.key);
		processed.add(start.key);

		// Grow gentlest edge first: coplanar and shallow connections are joined before sharp corners,
		// so e.g. a cylinder becomes a strip of sides rather than a star of sides around a cap.
		type Candidate = {face: MeshFace, key: string, adjacent: {face: MeshFace, key: string, edge: string[]}, angle: number, length: number};
		let frontier: Candidate[] = [];
		let addCandidates = (face: MeshFace, key: string) => {
			for (let side = 0; side < face.vertices.length; side++) {
				let adjacent = face.getAdjacentFace(side, vkey_fkey_map);
				if (!adjacent || processed.has(adjacent.key)) continue;
				let seam = mesh.getSeam(adjacent.edge);
				if (seam === 'divide') continue;
				let angle = seam === 'join' ? -1 : face.getAngleTo(adjacent.face);
				if (angle > max_edge_angle) continue;
				let a = mesh.vertices[adjacent.edge[0]], b = mesh.vertices[adjacent.edge[1]];
				frontier.push({face, key, adjacent, angle, length: Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])});
			}
		};
		addCandidates(start.face, start.key);
		while (frontier.length) {
			frontier.sort((a, b) => (a.angle - b.angle) || (b.length - a.length));
			let candidate = frontier.shift();
			if (processed.has(candidate.adjacent.key)) continue;
			if (!projectFace(candidate.adjacent.face, candidate.adjacent.key, island, {face: candidate.face, fkey: candidate.key, edge: candidate.adjacent.edge})) continue;
			island.keys.push(candidate.adjacent.key);
			processed.add(candidate.adjacent.key);
			addCandidates(candidate.adjacent.face, candidate.adjacent.key);
		}
		finalizeIsland(island, mesh);
		islands.push(island);
	}
	return islands;
}

/** Rotates the island to its dominant edge direction and normalizes it to start at 0,0 */
function finalizeIsland(island: Island, mesh: Mesh) {
	let polygons = island.keys.map(key => mesh.faces[key].getSortedVertices().map(vkey => island.uvs[key][vkey]));

	// Candidate rotations: edge directions, folded into 0..90, weighted by edge length
	let weights: Record<number, number> = {};
	for (let polygon of polygons) {
		for (let i = 0; i < polygon.length; i++) {
			let a = polygon[i], b = polygon[(i + 1) % polygon.length];
			let length = Math.hypot(b[0] - a[0], b[1] - a[1]);
			if (length < 0.0001) continue;
			let angle = ((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI) % 90 + 90) % 90;
			let rounded = Math.round(angle);
			weights[rounded] = (weights[rounded] || 0) + length;
		}
	}
	// Align the island to its dominant edge direction, so most edges land on the pixel axes
	let candidates = Object.keys(weights).map(k => +k).sort((a, b) => weights[b] - weights[a]);
	let best = {angle: candidates.length ? -candidates[0] * Math.PI / 180 : 0};

	let s = Math.sin(best.angle), c = Math.cos(best.angle);
	let min = [Infinity, Infinity];
	for (let key of island.keys) {
		for (let vkey in island.uvs[key]) {
			let p = island.uvs[key][vkey];
			let rotated: UV = [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
			island.uvs[key][vkey] = rotated;
			min[0] = Math.min(min[0], rotated[0]); min[1] = Math.min(min[1], rotated[1]);
		}
	}
	let max = [0, 0];
	for (let key of island.keys) {
		for (let vkey in island.uvs[key]) {
			let p = island.uvs[key][vkey];
			p[0] -= min[0]; p[1] -= min[1];
			max[0] = Math.max(max[0], p[0]); max[1] = Math.max(max[1], p[1]);
		}
	}
	island.polygons = island.keys.map(key => mesh.faces[key].getSortedVertices().map(vkey => island.uvs[key][vkey]));
	island.width = max[0];
	island.height = max[1];
	island.bbox_area = max[0] * max[1];
}

function buildCubeIslands(cube: Cube): Island[] {
	let islands: Island[] = [];
	for (let fkey in cube.faces) {
		let face = cube.faces[fkey];
		if (face.texture === null) continue;
		let w = 0, h = 0;
		switch (fkey) {
			case 'north': case 'south': w = cube.size(0); h = cube.size(1); break;
			case 'east': case 'west': w = cube.size(2); h = cube.size(1); break;
			default: w = cube.size(0); h = cube.size(2); break;
		}
		w = Math.abs(w); h = Math.abs(h);
		if (w == 0 || h == 0) continue;
		islands.push({
			element: cube, keys: [fkey], uvs: {},
			polygons: [[[0, 0], [w, 0], [w, h], [0, h]]],
			width: w, height: h, bbox_area: w * h, allow_rotation: false,
		});
	}
	return islands;
}

// MARK: Packing (simple shelf packer: rows of islands inside a square)

/** Lays islands out in rows inside a square and returns the square's side length in model units. */
function packIslands(islands: Island[], padding_fraction: number): number {
	// Wider-than-tall islands pack better into rows
	for (let island of islands) {
		island.rotated = island.allow_rotation && island.height > island.width * 1.2;
	}
	let packedSize = (island: Island) => island.rotated ? [island.height, island.width] : [island.width, island.height];
	islands.sort((a, b) => packedSize(b)[1] - packedSize(a)[1]);

	let total = islands.reduce((sum, island) => { let [w, h] = packedSize(island); return sum + w * h; }, 0);
	let side = Math.sqrt(total) * 1.1;
	for (let attempt = 0; attempt < 40; attempt++) {
		let pad = side * padding_fraction;
		let x = pad, y = pad, row_height = 0, used_x = 0, ok = true;
		for (let island of islands) {
			let [w, h] = packedSize(island);
			if (x > pad && x + w + pad > side) {
				x = pad;
				y += row_height + pad;
				row_height = 0;
			}
			if (y + h + pad > side || w + 2 * pad > side) { ok = false; break; }
			island.pos = [x, y];
			x += w + pad;
			used_x = Math.max(used_x, x);
			row_height = Math.max(row_height, h);
		}
		if (ok) {
			// Tighten the square to what was actually used
			return Math.max(used_x, y + row_height + pad);
		}
		side *= 1.08;
	}
	return side;
}

// MARK: Apply

function applyIslands(islands: Island[], side: number) {
	let fx = Project.texture_width / side;
	let fy = Project.texture_height / side;
	for (let island of islands) {
		let toUV = (p: UV): UV => {
			let x = p[0], y = p[1];
			if (island.rotated) [x, y] = [y, island.width - x];
			return [(island.pos[0] + x) * fx, (island.pos[1] + y) * fy];
		};
		if (island.element instanceof Mesh) {
			for (let key of island.keys) {
				let face = island.element.faces[key];
				for (let vkey of face.vertices) {
					let uv = toUV(island.uvs[key][vkey]);
					face.uv[vkey] = [roundTo(uv[0], 4), roundTo(uv[1], 4)];
				}
			}
		} else {
			let face = island.element.faces[island.keys[0]];
			let a = toUV([0, 0]), b = toUV([island.width, island.height]);
			face.uv = [roundTo(a[0], 4), roundTo(a[1], 4), roundTo(b[0], 4), roundTo(b[1], 4)];
			face.rotation = 0;
		}
	}
}

// MARK: Action

export function autoUnwrap(elements: OutlinerElement[], options: {max_edge_angle: number, padding: number}) {
	let meshes = elements.filter(el => el instanceof Mesh) as Mesh[];
	let cubes = elements.filter(el => el instanceof Cube && !el.box_uv) as Cube[];
	if (!meshes.length && !cubes.length) return null;

	let islands: Island[] = [];
	for (let mesh of meshes) islands.push(...buildMeshIslands(mesh, options.max_edge_angle));
	for (let cube of cubes) islands.push(...buildCubeIslands(cube));
	if (!islands.length) return null;

	// Padding is given in texels of a 256 texture
	let side = packIslands(islands, options.padding / 256);
	if (!side) return null;

	let affected: OutlinerElement[] = [...meshes, ...cubes];
	Undo.initEdit({elements: affected, uv_only: true});
	applyIslands(islands, side);
	Undo.finishEdit('Auto unwrap');
	Canvas.updateView({elements: affected, element_aspects: {uv: true}});
	UVEditor.loadData();
	return {islands: islands.length, faces: islands.reduce((n, island) => n + island.keys.length, 0)};
}

BARS.defineActions(() => {
	new Action('auto_unwrap', {
		icon: 'auto_awesome_mosaic',
		category: 'uv',
		condition: {modes: ['edit', 'paint'], method: () => !!Outliner.selected.find(el => el instanceof Mesh || el instanceof Cube)},
		tool_config: new ToolConfig('auto_unwrap_options', {
			title: 'action.auto_unwrap',
			form: {
				max_edge_angle: {type: 'number', label: 'action.auto_unwrap.max_edge_angle', description: 'action.auto_unwrap.max_edge_angle.desc', value: 95, min: 0, max: 180},
				padding: {type: 'number', label: 'action.auto_unwrap.padding', description: 'action.auto_unwrap.padding.desc', value: 2, min: 0, max: 32},
			}
		}),
		click() {
			let options = (this as Action).tool_config.options as {max_edge_angle: number, padding: number};
			let result = autoUnwrap(Outliner.selected, options);
			if (result) {
				Blockbench.showQuickMessage(tl('message.auto_unwrap.done', [result.faces, result.islands]), 2000);
			} else {
				Blockbench.showQuickMessage('message.auto_unwrap.nothing', 2000);
			}
		}
	})
});
