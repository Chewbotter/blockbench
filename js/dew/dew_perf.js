// Mid-poly performance: an incremental geometry update for meshes. The stock Mesh.preview_controller.updateGeometry
// rebuilds every buffer from plain arrays on each call, about 13 microseconds per face, so a gizmo drag on a 10k
// face mesh ran at 7 frames a second. Moves, rotations, scales and vertex drags change positions only, so after a
// full rebuild the buffer layout is cached and the next update with unchanged topology writes positions and flat
// normals straight into the existing typed arrays. A full rebuild still happens whenever faces or their vertex
// lists change, when smoothing or a weight view needs per-vertex normals or colours, and once at the end of every
// edit (finished_edit), so a cached quad sort order is never stale for longer than one drag.
import { THREE } from "../lib/libs";

export const PERF = {
	FULL_REBUILD_ON_FINISH: true,	// re-run the stock rebuild after each edit, so sort orders and colours catch up
};
export const perf_stats = {fast: 0, full: 0};	// counters for the tests and the probe

const caches = new WeakMap();	// element.mesh -> layout cache

function needsFullPath(element) {
	if (Modes.animate) return true;
	if (element.shading == 'smooth') return true;
	if (Toolbox.selected && Toolbox.selected.id === 'weight_brush') return true;
	if (Project.view_mode === 'vertex_weight' || Project.view_mode === 'weighted_bone_colors' || Project.view_mode === 'wireframe') return true;
	return false;
}
// The layout the stock rebuild just produced: per face its slot range and sorted vertices, per vertex its slots
function buildCache(element) {
	let {mesh, faces, vertices} = element;
	let face_keys = [], face_verts = [], face_start = [], face_sorted = [];
	let slot = 0;
	let vertex_slots = new Map();
	for (let fkey in faces) {
		let face = faces[fkey];
		if (face.vertices.length <= 2) continue;
		if (face.smoothing_group) return null;	// smoothing groups take the stock path
		face_keys.push(fkey);
		face_verts.push(face.vertices.slice());
		face_start.push(slot);
		face_sorted.push(face.vertices.length == 4 ? face.getSortedVertices().slice(0, 3) : face.vertices.slice(0, 3));
		face.vertices.forEach(vkey => {
			if (!vertex_slots.has(vkey)) vertex_slots.set(vkey, []);
			vertex_slots.get(vkey).push(slot++);
		});
	}
	if (mesh.geometry.attributes.position.count != slot) return null;
	return {
		face_keys, face_verts, face_start, face_sorted, vertex_slots,
		vertex_keys: Object.keys(vertices),
		outline_order: mesh.outline.vertex_order.slice(),
		turn_order: mesh.turn_edges ? mesh.turn_edges.vertex_order.slice() : null,
		view_mode: Project.view_mode,
	};
}
// Same faces with the same vertex lists, same vertices, as when the cache was built
function topologyMatches(element, cache) {
	let {faces, vertices} = element;
	if (Project.view_mode !== cache.view_mode) return false;
	let vkeys = Object.keys(vertices);
	if (vkeys.length != cache.vertex_keys.length) return false;
	for (let i = 0; i < vkeys.length; i++) if (vkeys[i] !== cache.vertex_keys[i]) return false;
	let i = 0;
	for (let fkey in faces) {
		let face = faces[fkey];
		if (face.vertices.length <= 2) continue;
		if (cache.face_keys[i] !== fkey) return false;
		let cached = cache.face_verts[i];
		if (cached.length != face.vertices.length) return false;
		for (let k = 0; k < cached.length; k++) if (cached[k] !== face.vertices[k]) return false;
		i++;
	}
	return i == cache.face_keys.length;
}
function writePositions(order, array, vertices) {
	for (let i = 0; i < order.length; i++) {
		let v = vertices[order[i]];
		array[i * 3] = v[0]; array[i * 3 + 1] = v[1]; array[i * 3 + 2] = v[2];
	}
}
function fastUpdate(element, cache) {
	let {mesh, vertices} = element;
	let position = mesh.geometry.attributes.position, normal = mesh.geometry.attributes.normal;
	if (!position || !normal || position.count != normal.count) return false;
	let pos = position.array, nor = normal.array;
	for (let [vkey, slots] of cache.vertex_slots) {
		let v = vertices[vkey];
		if (!v) return false;
		for (let s of slots) { pos[s * 3] = v[0]; pos[s * 3 + 1] = v[1]; pos[s * 3 + 2] = v[2]; }
	}
	// Flat normal per face from its first three sorted vertices, the same three getNormal uses
	for (let f = 0; f < cache.face_keys.length; f++) {
		let [a, b, c] = cache.face_sorted[f].map(vkey => vertices[vkey]);
		let ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
		let bx = c[0] - a[0], by = c[1] - a[1], bz = c[2] - a[2];
		let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
		let length = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
		nx /= length; ny /= length; nz /= length;
		let start = cache.face_start[f], count = cache.face_verts[f].length;
		for (let s = start; s < start + count; s++) { nor[s * 3] = nx; nor[s * 3 + 1] = ny; nor[s * 3 + 2] = nz; }
	}
	position.needsUpdate = normal.needsUpdate = true;
	let outline = mesh.outline.geometry.attributes.position;
	if (outline && outline.count == cache.outline_order.length) { writePositions(cache.outline_order, outline.array, vertices); outline.needsUpdate = true; }
	let points = mesh.vertex_points.geometry.attributes.position;
	if (points && points.count == cache.vertex_keys.length) { writePositions(cache.vertex_keys, points.array, vertices); points.needsUpdate = true; }
	if (mesh.turn_edges && cache.turn_order) {
		let turn = mesh.turn_edges.geometry.attributes.position;
		if (turn && turn.count == cache.turn_order.length) { writePositions(cache.turn_order, turn.array, vertices); turn.needsUpdate = true; mesh.turn_edges.geometry.computeBoundingSphere(); }
	}
	mesh.geometry.computeBoundingBox();
	mesh.geometry.computeBoundingSphere();
	mesh.vertex_points.geometry.computeBoundingSphere();
	mesh.outline.geometry.computeBoundingSphere();
	Mesh.preview_controller.updatePixelGrid(element);
	return true;
}

const controller = Mesh.preview_controller;
const fullUpdate = controller.updateGeometry;
const dirty = new Set();	// elements updated on the fast path since the last full rebuild
controller.updateGeometry = function(element, vertex_offsets) {
	let cache = caches.get(element.mesh);
	if (!vertex_offsets && cache && !needsFullPath(element) && topologyMatches(element, cache) && fastUpdate(element, cache)) {
		perf_stats.fast++;
		dirty.add(element);
		this.dispatchEvent('update_geometry', {element});
		return;
	}
	perf_stats.full++;
	fullUpdate.call(this, element, vertex_offsets);
	dirty.delete(element);
	let built = (!vertex_offsets && !needsFullPath(element)) ? buildCache(element) : null;
	if (built) caches.set(element.mesh, built); else caches.delete(element.mesh);
};
// The edit is over: put the stock rebuild's exact result back for anything the fast path touched
Blockbench.on('finished_edit', () => {
	if (!PERF.FULL_REBUILD_ON_FINISH || !dirty.size) return;
	for (let element of [...dirty]) {
		if (element.mesh && Mesh.all.includes(element)) { caches.delete(element.mesh); controller.updateGeometry(element); }
	}
	dirty.clear();
});

// Undo snapshots. Face.getUndoCopy built a whole MeshFace through the constructor (property resets, merges) and then
// deleted the fields it did not want, 4.5 microseconds a face: 45 of the 50 ms a 10k face mesh cost per copy, twice
// per edit. The copy the restore reads (Mesh.extend, then MeshFace.extend) is four fields, so build those directly.
// Same content as the stock copy, checked field for field by cdp_undo_copy.mjs; the stock method stays reachable.
const stockFaceUndoCopy = MeshFace.prototype.getUndoCopy;
MeshFace.prototype.getUndoCopy = function() {
	let copy = {texture: this.texture, uv: {}};
	// As the stock copy normalised them through MeshFace.extend: one entry per vertex, a missing one is [0, 0]
	for (let vkey of this.vertices) {
		let uv = this.uv[vkey];
		copy.uv[vkey] = uv ? uv.slice() : [0, 0];
	}
	for (let key in MeshFace.properties) MeshFace.properties[key].copy(this, copy);
	return copy;
};

// Selection colours. The stock Mesh.preview_controller.updateSelection pushes three floats per outline vertex into a
// plain array (80k entries on 10k quads), with a string sort and join per entry in edge mode, then allocates a new
// attribute: 15 to 28 ms of every selection change. This writes the same colours into the existing typed arrays,
// fills object mode in one pass, and only builds the edge key set in edge mode. The seam tool keeps the stock path,
// since its seam lookups are the one thing here that is not a colour per selection state.
const stockUpdateSelection = controller.updateSelection;
function fillColor(array, i, color) {
	array[i * 3] = color.r; array[i * 3 + 1] = color.g; array[i * 3 + 2] = color.b;
}
function colorAttribute(geometry, count) {
	let attribute = geometry.attributes.color;
	if (!attribute || attribute.count != count) {
		attribute = new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3);
		geometry.setAttribute('color', attribute);
	}
	return attribute;
}
controller.updateSelection = function(element) {
	if (Toolbox.selected && Toolbox.selected.id === 'seam_tool') return stockUpdateSelection.call(this, element);
	NodePreviewController.prototype.updateSelection.call(this, element);
	let mesh = element.mesh;
	let white = new THREE.Color(0xffffff);
	let selection_mode = BarItems.selection_mode.value;
	if (!Modes.edit) selection_mode = 'object';

	if (Mesh.isVertexSelectionMode()) {
		let selected = new Set(element.getSelectedVertices());
		let keys = Object.keys(element.vertices);
		let attribute = colorAttribute(mesh.vertex_points.geometry, keys.length);
		for (let i = 0; i < keys.length; i++) fillColor(attribute.array, i, selected.has(keys[i]) ? white : gizmo_colors.grid);
		attribute.needsUpdate = true;
		mesh.outline.geometry.needsUpdate = true;
	}

	let order = mesh.outline.vertex_order;
	let attribute = colorAttribute(mesh.outline.geometry, order.length);
	let array = attribute.array;
	if (selection_mode == 'object') {
		let color = gizmo_colors.outline;
		for (let i = 0; i < order.length; i++) fillColor(array, i, color);
	} else if (selection_mode == 'face' || selection_mode == 'cluster') {
		// Every pair of vertices inside a selected face lights the outline edge between them, as the stock code did.
		// Pairs are integer keys over a vertex index, since 120k string joins cost more than the stock per-vertex Sets.
		let index = new Map();
		let n = 0;
		for (let vkey in element.vertices) index.set(vkey, n++);
		let lit = new Set();
		let faces = element.faces;
		for (let fkey of element.getSelectedFaces()) {
			let ids = faces[fkey].vertices.map(vkey => index.get(vkey));
			for (let a of ids) for (let b of ids) if (a != b) lit.add(a * n + b);
		}
		for (let i = 0; i < order.length; i++) {
			let key_b = order[i + ((i % 2) ? -1 : 1)];
			fillColor(array, i, key_b && lit.has(index.get(order[i]) * n + index.get(key_b)) ? white : gizmo_colors.grid);
		}
	} else if (selection_mode == 'edge') {
		let lit = new Set();
		for (let edge of element.getSelectedEdges()) { lit.add(edge[0] + '|' + edge[1]); lit.add(edge[1] + '|' + edge[0]); }
		for (let i = 0; i < order.length; i++) {
			let key_b = order[i + ((i % 2) ? -1 : 1)];
			fillColor(array, i, key_b && lit.has(order[i] + '|' + key_b) ? white : gizmo_colors.grid);
		}
	} else {
		for (let i = 0; i < order.length; i++) fillColor(array, i, gizmo_colors.grid);
	}
	attribute.needsUpdate = true;
	mesh.outline.geometry.needsUpdate = true;

	mesh.vertex_points.visible = ((Mode.selected.id == 'edit' && Mesh.isVertexSelectionMode()) || Toolbox.selected.id == 'knife_tool') && element.selected;
	if (Toolbox.selected.id == 'weight_brush') mesh.vertex_points.visible = true;
	if (mesh.turn_edges) {
		mesh.turn_edges.visible = Mode.selected.id == 'edit' && Toolbox.selected.id == 'turn_edges_tool' && element.selected;
	}
	this.dispatchEvent('update_selection', {element});
};

Object.assign(window, {DEWPerf: {PERF, perf_stats, stockFaceUndoCopy, stockUpdateSelection}});
