import { THREE } from '../lib/libs';
import { ToolConfig } from '../interface/dialog';

/**
 * Auto Unwrap: lays out the UVs of whole meshes as a paint-ready base.
 *
 * 1. Faces are grown into islands across shared edges (up to a bend angle, seams override),
 *    each face unfolded flat by hinging around the shared edge, rejecting any overlap.
 * 2. Each island is rotated to its dominant edge direction to keep its footprint small.
 * 3. Islands are packed from the top edge down on an occupancy grid (shape-aware, gaps first,
 *    90 degree rotation allowed) inside a square at a uniform scale, so every face gets texture
 *    space proportional to its real size, then scaled to fill the UV square.
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

// MARK: Packing (occupancy grid: fill from the top edge down, gaps first, shape-aware, 90 degree rotation allowed)

const GRID = 256;

/** Cells covered by the island at the given cell size, dilated by pad cells. Returns a mask of width x height cells. */
function rasterize(island: Island, cell: number, rotated: boolean, pad: number): {cells: Uint8Array, width: number, height: number} {
	let polygons = island.polygons.map(polygon => polygon.map(p => {
		let x = p[0] / cell, y = p[1] / cell;
		return (rotated ? [y, island.width / cell - x] : [x, y]) as UV;
	}));
	let inner_w = Math.ceil((rotated ? island.height : island.width) / cell);
	let inner_h = Math.ceil((rotated ? island.width : island.height) / cell);
	let width = inner_w + pad * 2, height = inner_h + pad * 2;
	let cells = new Uint8Array(width * height);

	// Scanline fill: for each cell row, the polygon's horizontal extent sampled near the row's top,
	// middle and bottom gives a conservative span of covered cells
	let spans: [number, number][][] = Array.from({length: inner_h}, () => []);
	for (let polygon of polygons) {
		let min_y = Infinity, max_y = -Infinity;
		for (let p of polygon) { min_y = Math.min(min_y, p[1]); max_y = Math.max(max_y, p[1]); }
		for (let row = Math.max(0, Math.floor(min_y)); row < Math.min(inner_h, Math.ceil(max_y)); row++) {
			let lo = Infinity, hi = -Infinity;
			for (let sy of [row + 0.02, row + 0.5, row + 0.98]) {
				for (let i = 0; i < polygon.length; i++) {
					let p = polygon[i], q = polygon[(i + 1) % polygon.length];
					if ((p[1] <= sy) == (q[1] <= sy)) continue; // edge does not cross this line
					let x = p[0] + (sy - p[1]) / (q[1] - p[1]) * (q[0] - p[0]);
					lo = Math.min(lo, x); hi = Math.max(hi, x);
				}
			}
			// Vertices inside the row band extend the span too
			for (let p of polygon) {
				if (p[1] >= row && p[1] <= row + 1) { lo = Math.min(lo, p[0]); hi = Math.max(hi, p[0]); }
			}
			if (lo <= hi) spans[row].push([Math.max(0, Math.floor(lo)), Math.min(inner_w - 1, Math.ceil(hi) - 1)]);
		}
	}
	for (let row = 0; row < inner_h; row++) {
		for (let [x0, x1] of spans[row]) {
			for (let dy = -pad; dy <= pad; dy++) {
				let y = row + pad + dy;
				let base = y * width;
				for (let x = Math.max(0, x0 + pad - pad); x <= Math.min(width - 1, x1 + pad + pad); x++) {
					cells[base + x] = 1;
				}
			}
		}
	}
	return {cells, width, height};
}

/** Packs into a bin GRID cells wide at the given cell size. Returns the used height in cells. */
function packOnce(islands: Island[], cell: number, pad: number): number {
	let rows: Uint8Array[] = [];
	let row = (y: number) => rows[y] ??= new Uint8Array(GRID);
	let max_y = 0;
	let masks = islands.map(island => {
		let options = [{rotated: false, mask: rasterize(island, cell, false, pad)}];
		if (island.allow_rotation && Math.abs(island.width - island.height) > cell) {
			options.push({rotated: true, mask: rasterize(island, cell, true, pad)});
		}
		return options;
	});
	let fits = (mask: {cells: Uint8Array, width: number, height: number}, ox: number, oy: number) => {
		for (let y = 0; y < mask.height; y++) {
			let occupied = rows[oy + y];
			if (!occupied) continue;
			let base = y * mask.width;
			for (let x = 0; x < mask.width; x++) {
				if (mask.cells[base + x] && occupied[ox + x]) return false;
			}
		}
		return true;
	};
	islands.forEach((island, i) => {
		let best: {x: number, y: number, rotated: boolean, mask: any} = null;
		for (let option of masks[i]) {
			let mask = option.mask;
			if (mask.width > GRID) continue;
			search: for (let y = 0; y <= (best ? best.y : max_y + 1); y++) {
				for (let x = 0; x + mask.width <= GRID; x++) {
					if (best && y == best.y && x >= best.x) break search;
					if (fits(mask, x, y)) { best = {x, y, rotated: option.rotated, mask}; break search; }
				}
			}
		}
		if (!best) {
			// Wider than the bin: put it below everything, unrotated
			let mask = masks[i][0].mask;
			best = {x: 0, y: max_y, rotated: false, mask};
		}
		for (let y = 0; y < best.mask.height; y++) {
			let occupied = row(best.y + y);
			let base = y * best.mask.width;
			for (let x = 0; x < best.mask.width; x++) {
				if (best.mask.cells[base + x] && best.x + x < GRID) occupied[best.x + x] = 1;
			}
		}
		island.rotated = best.rotated;
		island.pos = [(best.x + pad) * cell, (best.y + pad) * cell];
		max_y = Math.max(max_y, best.y + best.mask.height);
	});
	return max_y;
}

/** Lays islands out inside a square and returns the square's side length in model units. */
function packIslands(islands: Island[], padding_fraction: number): number {
	islands.sort((a, b) => (Math.max(b.width, b.height) - Math.max(a.width, a.height)) || (b.bbox_area - a.bbox_area));
	let total = islands.reduce((sum, island) => sum + island.bbox_area, 0);
	let widest = islands.reduce((m, island) => Math.max(m, Math.min(island.width, island.height)), 0);
	let pad = Math.max(1, Math.round(padding_fraction * GRID / 2));

	// Try a sweep of bin widths (model units) and keep the one with the smallest square side
	let best: {side: number, results: {rotated: boolean, pos: [number, number]}[]} = null;
	for (let factor of [0.95, 1.05, 1.15, 1.3, 1.45, 1.65, 1.9, 2.2]) {
		let width = Math.max(Math.sqrt(total) * factor, widest * 1.1);
		let cell = width / (GRID - pad * 2);
		let height_cells = packOnce(islands, cell, pad);
		// Islands may reach GRID - pad cells in x; the square side keeps a pad margin on every edge
		let side = Math.max(GRID, height_cells + pad) * cell;
		if (!best || side < best.side - 0.0001) {
			best = {side, results: islands.map(island => ({rotated: island.rotated, pos: island.pos}))};
		}
	}
	islands.forEach((island, i) => {
		island.rotated = best.results[i].rotated;
		island.pos = best.results[i].pos;
	});
	return best.side;
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
