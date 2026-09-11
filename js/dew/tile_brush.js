// Tile brush for DEW scenes: paints half-cell square quads onto an axis-aligned work plane.
// Click or drag places tiles, Ctrl erases. W cycles the plane axis, A / D step it, C toggles full / half tiles.
import { THREE } from "../lib/libs";
import { DEW } from "./dew_scene";

const BRUSH = {
	GHOST_COLOR: 0x4ed0ff,
	ERASE_COLOR: 0xff4848,
	GHOST_OPACITY: 0.3,
	PLANE_COLOR: 0x4ed0ff,
	PLANE_TILE_OPACITY: 0.5,	// full-tile lines on the work plane
	PLANE_HALF_OPACITY: 0.2,	// half-cell lines on the work plane
	LIFT: 0.05,					// ghost and plane grid sit this far toward the camera to stay above tiles
	NEW_MESH_NAME: 'tiles',
	MESSAGE_TIME: 1200,
	PAINT_COLOR: 0xffd24a,		// texture brush ghost
	ATLAS_HALF_LINE: 'rgba(255, 255, 255, 0.25)',
	ATLAS_TILE_LINE: 'rgba(255, 255, 255, 0.6)',
	ATLAS_PICK_COLOR: '#ffd24a',
	SELECT_COLOR: 0x6fe38a,		// tile select ghost
	SHAVE_COLOR: 0xff9e3d,		// shave preview, drawn on top since the cut lies behind the corner tiles
	RAMP_COLOR: 0x8ad4ff,		// ramp preview, which sits in open space
};

const H = DEW.HALF_CELL;
const AXES = ['y', 'x', 'z'];
const AXIS_LABEL = {y: 'Floor', x: 'Wall X', z: 'Wall Z'};
// In-plane axes of each work plane: u runs along the first, v along the second
const PLANE_AXES = {y: ['x', 'z'], x: ['z', 'y'], z: ['x', 'y']};

const state = {
	axis: 'y',
	depth: 0,
	size: DEW.TILE,
	hover_point: null,	// last world point under the cursor, W aims the new plane through it
};
let stroke = null;
let last_hover_event = null;
let ghost = null;
let plane_grid = null;
let previous_selection_mode = null;

const round3 = v => Math.round(v * 1000) / 1000;
const snap = (v, step = H) => Math.round(v / step) * step;
const isActive = () => Toolbox.selected && Toolbox.selected.id == 'dew_tile_brush';
const isDewTool = () => Toolbox.selected && ['dew_tile_select', 'dew_tile_brush', 'dew_shave', 'dew_ramp', 'dew_texture_brush', 'dew_paint_bucket'].includes(Toolbox.selected.id);
const cutsInside = () => Toolbox.selected && Toolbox.selected.id == 'dew_ramp';

function planePoint(axis, depth, u, v) {
	let [ua, va] = PLANE_AXES[axis];
	let point = new THREE.Vector3();
	point[axis] = depth;
	point[ua] = u;
	point[va] = v;
	return point;
}
function cellAt(point, axis, size) {
	let [ua, va] = PLANE_AXES[axis];
	return [Math.floor(point[ua] / size + 1e-6) * size, Math.floor(point[va] / size + 1e-6) * size];
}
function getRay(preview, event) {
	let rect = preview.canvas.getBoundingClientRect();
	let mouse = new THREE.Vector2(
		((event.clientX - rect.left) / rect.width) * 2 - 1,
		-((event.clientY - rect.top) / rect.height) * 2 + 1
	);
	let raycaster = new THREE.Raycaster();
	raycaster.setFromCamera(mouse, preview.camera);
	return raycaster.ray;
}
function intersectPlane(ray, axis, depth) {
	let d = ray.direction[axis];
	if (Math.abs(d) < 1e-6) return null;
	let t = (depth - ray.origin[axis]) / d;
	if (t < 0) return null;
	return ray.origin.clone().addScaledVector(ray.direction, t);
}
// Tiles face the side of the plane the camera is on
function facingSign(preview, axis, depth) {
	return preview.camera.position[axis] >= depth ? 1 : -1;
}
function worldNormal(mesh, face) {
	let n = face.getNormal(true);
	let normal = Array.isArray(n) ? new THREE.Vector3().fromArray(n) : new THREE.Vector3().copy(n);
	return normal.applyQuaternion(mesh.mesh.getWorldQuaternion(new THREE.Quaternion()));
}

// Texture coordinates inside a tile block of the given size, oriented so textures read upright and
// unmirrored from the facing side
function tileUV(axis, sign, du, dv, size = H) {
	if (axis == 'y') return [sign > 0 ? du : size - du, dv];
	let u = (axis == 'x') == (sign > 0) ? size - du : du;
	return [u, size - dv];
}

// An axis-aligned half-cell quad as {axis, depth, u, v, sign} in world space, or null
function describeTile(mesh, face) {
	if (!face || face.vertices.length != 4) return null;
	let points = face.vertices.map(vkey => mesh.mesh.localToWorld(new THREE.Vector3().fromArray(mesh.vertices[vkey])));
	for (let axis of AXES) {
		let depth = points[0][axis];
		if (!points.every(p => Math.abs(p[axis] - depth) < 1e-3)) continue;
		let [ua, va] = PLANE_AXES[axis];
		let us = points.map(p => p[ua]), vs = points.map(p => p[va]);
		let u = Math.min(...us), v = Math.min(...vs);
		if (Math.abs(Math.max(...us) - u - H) > 1e-3 || Math.abs(Math.max(...vs) - v - H) > 1e-3) return null;
		let sign = worldNormal(mesh, face)[axis] >= 0 ? 1 : -1;
		return {axis, depth: round3(depth), u: round3(u), v: round3(v), sign};
	}
	return null;
}
const tileKey = (axis, depth, u, v) => `${axis}|${round3(depth)}|${round3(u)}|${round3(v)}`;

function buildOccupancy() {
	let occupied = new Set();
	for (let mesh of Mesh.all) {
		if (mesh.visibility === false) continue;
		mesh.mesh.updateMatrixWorld(true);
		for (let fkey in mesh.faces) {
			let tile = describeTile(mesh, mesh.faces[fkey]);
			if (tile) occupied.add(tileKey(tile.axis, tile.depth, tile.u, tile.v));
		}
	}
	return occupied;
}
function buildVertexMap(mesh) {
	let map = new Map();
	for (let vkey in mesh.vertices) {
		map.set(mesh.vertices[vkey].map(round3).join(','), vkey);
	}
	return map;
}

// Where a click would paint. Over geometry the plane moves through the hit point and keeps its axis,
// otherwise it is the current plane.
function getTarget(preview, event) {
	let hit = preview.raycast(event);
	if (hit && hit.type == 'element' && hit.intersects && hit.intersects[0]) {
		let intersect = hit.intersects[0];
		let normal = intersect.face.normal.clone().transformDirection(intersect.object.matrixWorld);
		// Nudged off the surface so a wall started on a floor lands above it
		let point = intersect.point.clone().addScaledVector(normal, 0.01);
		return {depth: snap(point[state.axis]), point, hit};
	}
	let point = intersectPlane(getRay(preview, event), state.axis, state.depth);
	return point && {depth: state.depth, point, hit: null};
}

function addTile(u, v) {
	let {axis, depth, sign, mesh} = stroke;
	let key = tileKey(axis, depth, u, v);
	if (stroke.occupied.has(key)) return false;
	stroke.occupied.add(key);

	let corners = [[0, 0], [H, 0], [H, H], [0, H]];
	let vkeys = corners.map(([du, dv]) => {
		let local = mesh.mesh.worldToLocal(planePoint(axis, depth, u + du, v + dv));
		let position = [round3(local.x), round3(local.y), round3(local.z)];
		let id = position.join(',');
		let vkey = stroke.vertex_map.get(id);
		if (!vkey) {
			vkey = mesh.addVertices(position)[0];
			stroke.vertex_map.set(id, vkey);
		}
		return vkey;
	});
	let uv = {};
	corners.forEach(([du, dv], i) => uv[vkeys[i]] = tileUV(axis, sign, du, dv));
	let face = new MeshFace(mesh, {vertices: vkeys, uv, texture: false});
	mesh.addFaces(face);
	if (worldNormal(mesh, face)[axis] * sign < 0) face.invert();
	return true;
}

function paintAt(point) {
	let size = state.size;
	let from = stroke.last_point || point;
	// Sample between mouse events so fast strokes leave no gaps
	let steps = Math.max(1, Math.ceil(from.distanceTo(point) / (H / 2)));
	let changed = false;
	for (let i = 1; i <= steps; i++) {
		let [u0, v0] = cellAt(from.clone().lerp(point, i / steps), stroke.axis, size);
		for (let du = 0; du < size; du += H) {
			for (let dv = 0; dv < size; dv += H) {
				if (addTile(u0 + du, v0 + dv)) changed = true;
			}
		}
	}
	stroke.last_point = point.clone();
	if (changed) {
		stroke.changed = true;
		Canvas.updateView({elements: [stroke.mesh], element_aspects: {geometry: true, faces: true, uv: true}});
	}
}

// Faces a brush acts on for a hit: the face itself, or every same-facing tile of the full-tile cell around it
function blockTiles(mesh, fkey, size = state.size) {
	let tile = describeTile(mesh, mesh.faces[fkey]);
	if (!tile) return {fkeys: [fkey], tile: null};
	let [cu, cv] = [Math.floor(tile.u / size + 1e-6) * size, Math.floor(tile.v / size + 1e-6) * size];
	let fkeys = [];
	for (let key in mesh.faces) {
		let other = key == fkey ? tile : describeTile(mesh, mesh.faces[key]);
		if (!other || other.axis != tile.axis || other.depth != tile.depth || other.sign != tile.sign) continue;
		if (other.u >= cu && other.u < cu + size && other.v >= cv && other.v < cv + size) fkeys.push(key);
	}
	return {fkeys, tile, cu, cv};
}
// Erase strokes raycast against the geometry as it was when the stroke started, so planes revealed
// by erasing (the far side of a box seen through the new hole) can never be hit
function snapshotMeshes() {
	let material = new THREE.MeshBasicMaterial({side: THREE.DoubleSide});
	let proxies = [];
	for (let mesh of Mesh.all) {
		if (mesh.visibility === false || mesh.locked || !mesh.mesh.geometry) continue;
		mesh.mesh.updateMatrixWorld(true);
		let proxy = new THREE.Mesh(mesh.mesh.geometry.clone(), material);
		proxy.matrixAutoUpdate = false;
		proxy.matrixWorld.copy(mesh.mesh.matrixWorld);
		// Triangle index to face key, in the order the mesh geometry is built (same mapping as Preview.raycast)
		proxy.triangle_faces = [];
		for (let fkey in mesh.faces) {
			let count = mesh.faces[fkey].vertices.length;
			if (count < 3) continue;
			proxy.triangle_faces.push(fkey);
			if (count == 4) proxy.triangle_faces.push(fkey);
		}
		proxy.element = mesh;
		proxies.push(proxy);
	}
	return {proxies, material};
}
function disposeSnapshot(snapshot) {
	snapshot.proxies.forEach(proxy => proxy.geometry.dispose());
	snapshot.material.dispose();
}
function snapshotHit(event) {
	let raycaster = new THREE.Raycaster();
	raycaster.ray.copy(getRay(stroke.preview, event));
	let intersect = raycaster.intersectObjects(stroke.snapshot.proxies, false)[0];
	if (!intersect) return null;
	return {element: intersect.object.element, face: intersect.object.triangle_faces[intersect.faceIndex]};
}
function eraseStep(event) {
	let hit = snapshotHit(event);
	if (!hit || !hit.element.faces[hit.face]) return;
	let mesh = hit.element;
	for (let fkey of blockTiles(mesh, hit.face).fkeys) {
		delete mesh.faces[fkey];
	}
	stroke.touched.add(mesh);
	Canvas.updateView({elements: [mesh], element_aspects: {geometry: true, faces: true, uv: true}});
}
function removeLooseVertices(mesh) {
	let used = new Set();
	for (let fkey in mesh.faces) mesh.faces[fkey].vertices.forEach(vkey => used.add(vkey));
	for (let vkey in mesh.vertices) {
		if (!used.has(vkey)) delete mesh.vertices[vkey];
	}
}

function startStroke(preview, event) {
	if (event.ctrlKey) {
		Undo.initEdit({elements: Mesh.all.filter(mesh => mesh.visibility !== false && !mesh.locked)});
		stroke = {erase: true, preview, touched: new Set(), snapshot: snapshotMeshes()};
		eraseStep(event);
	} else {
		let target = getTarget(preview, event);
		if (!target) return;
		state.depth = target.depth;
		let mesh = Mesh.selected[0] || (target.hit && target.hit.element instanceof Mesh ? target.hit.element : null);
		let created = !mesh;
		Undo.initEdit(created ? {elements: [], outliner: true, selection: true} : {elements: [mesh], selection: true});
		if (created) {
			mesh = new Mesh({name: BRUSH.NEW_MESH_NAME, vertices: {}}).init();
		}
		if (!mesh.selected || Outliner.selected.length > 1) {
			unselectAllElements();
			mesh.select();
		}
		mesh.mesh.updateMatrixWorld(true);
		stroke = {
			erase: false, preview, mesh, created,
			axis: state.axis,
			depth: target.depth,
			sign: facingSign(preview, state.axis, target.depth),
			occupied: buildOccupancy(),
			vertex_map: buildVertexMap(mesh),
			last_point: null,
			changed: created,
		};
		paintAt(target.point);
		updatePlaneGrid();
	}
	document.addEventListener('mousemove', moveStroke);
	document.addEventListener('mouseup', endStroke);
}
function moveStroke(event) {
	if (!stroke) return;
	if (stroke.erase) {
		eraseStep(event);
	} else {
		let point = intersectPlane(getRay(stroke.preview, event), stroke.axis, stroke.depth);
		if (point) paintAt(point);
	}
}
function endStroke() {
	document.removeEventListener('mousemove', moveStroke);
	document.removeEventListener('mouseup', endStroke);
	if (!stroke) return;
	let finished = stroke;
	stroke = null;
	if (finished.erase) {
		disposeSnapshot(finished.snapshot);
		if (!finished.touched.size) return Undo.cancelEdit();
		finished.touched.forEach(removeLooseVertices);
		Undo.finishEdit('Erase tiles');
		Canvas.updateView({elements: [...finished.touched], element_aspects: {geometry: true, faces: true, uv: true}, selection: true});
	} else {
		if (!finished.changed) return Undo.cancelEdit();
		Undo.finishEdit('Paint tiles', finished.created ? {outliner: true, elements: [finished.mesh], selection: true} : undefined);
		updateSelection();
	}
	if (last_hover_event) onHover(last_hover_event);
}

function disposeObject(object) {
	object.traverse(child => {
		if (child.geometry) child.geometry.dispose();
		if (child.material) child.material.dispose();
	});
	if (object.parent) object.parent.remove(object);
}
function hideGhost() {
	if (ghost) disposeObject(ghost);
	ghost = null;
}
function showGhost(axis, depth, sign, u0, v0, size, color, size_v = size) {
	let lifted = depth + BRUSH.LIFT * sign;
	showGhostQuad([[0, 0], [size, 0], [size, size_v], [0, size_v]].map(([du, dv]) => planePoint(axis, lifted, u0 + du, v0 + dv)), color);
}
// Ghost over any four world points; on_top draws it through geometry
function showGhostQuad(c, color, on_top = false) {
	hideGhost();
	let fill = new THREE.Mesh(
		new THREE.BufferGeometry().setFromPoints([c[0], c[1], c[2], c[0], c[2], c[3]]),
		new THREE.MeshBasicMaterial({color, transparent: true, opacity: BRUSH.GHOST_OPACITY, side: THREE.DoubleSide, depthWrite: false, depthTest: !on_top})
	);
	let outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(c), new THREE.LineBasicMaterial({color, depthTest: !on_top}));
	if (on_top) fill.renderOrder = outline.renderOrder = 20;
	ghost = new THREE.Group();
	ghost.name = 'dew_tile_ghost';
	ghost.add(fill, outline);
	Canvas.scene.add(ghost);
}

function removePlaneGrid() {
	if (plane_grid) disposeObject(plane_grid);
	plane_grid = null;
}
// Grid lines on the current work plane, across the cluster (and three storeys up for walls)
function updatePlaneGrid() {
	removePlaneGrid();
	if (!isActive() || Format.id != 'dew_scene' || !Preview.selected) return;
	let axis = stroke && !stroke.erase ? stroke.axis : state.axis;
	let depth = stroke && !stroke.erase ? stroke.depth : state.depth;
	let lifted = depth + BRUSH.LIFT * facingSign(Preview.selected, axis, depth);
	let u_max = DEW.CLUSTER_SIZE;
	let v_max = axis == 'y' ? DEW.CLUSTER_SIZE : DEW.STOREY * DEW.STOREYS_SHOWN;
	let tile_lines = [], half_lines = [];
	let push = (list, a, b) => list.push(...a.toArray(), ...b.toArray());
	for (let u = 0; u <= u_max; u += H) {
		push(u % DEW.TILE ? half_lines : tile_lines, planePoint(axis, lifted, u, 0), planePoint(axis, lifted, u, v_max));
	}
	for (let v = 0; v <= v_max; v += H) {
		push(v % DEW.TILE ? half_lines : tile_lines, planePoint(axis, lifted, 0, v), planePoint(axis, lifted, u_max, v));
	}
	let lines = (points, opacity) => {
		let geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
		return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({color: BRUSH.PLANE_COLOR, transparent: true, opacity}));
	};
	plane_grid = new THREE.Group();
	plane_grid.name = 'dew_plane_grid';
	plane_grid.add(lines(tile_lines, BRUSH.PLANE_TILE_OPACITY), lines(half_lines, BRUSH.PLANE_HALF_OPACITY));
	Canvas.scene.add(plane_grid);
}

// ctrl_held overrides the event's modifier state when Ctrl is pressed or released without moving the mouse
function onHover(event, ctrl_held = event.ctrlKey) {
	last_hover_event = event;
	let preview = stroke ? stroke.preview : event.target && event.target.preview;
	if (!preview || !preview.camera || Format.id != 'dew_scene') return hideGhost();

	let erasing = stroke ? stroke.erase : ctrl_held;
	if (erasing) {
		let hit = stroke ? snapshotHit(event) : preview.raycast(event);
		if (hit && (stroke || hit.type == 'element') && hit.element instanceof Mesh && hit.element.faces[hit.face]) {
			let {tile, cu, cv} = blockTiles(hit.element, hit.face);
			if (tile) return showGhost(tile.axis, tile.depth, tile.sign, cu, cv, state.size, BRUSH.ERASE_COLOR);
		}
		return hideGhost();
	}
	let axis, depth, point, sign;
	if (stroke) {
		({axis, depth, sign} = stroke);
		point = intersectPlane(getRay(preview, event), axis, depth);
	} else {
		let target = getTarget(preview, event);
		if (target) {
			axis = state.axis;
			({depth, point} = target);
			sign = facingSign(preview, axis, depth);
		}
	}
	if (!point) return hideGhost();
	state.hover_point = point;
	let [u0, v0] = cellAt(point, axis, state.size);
	showGhost(axis, depth, sign, u0, v0, state.size, BRUSH.GHOST_COLOR);
}
function onModifierKey(event) {
	if (event.key == 'Control' && last_hover_event && !stroke) {
		onHover(last_hover_event, event.type == 'keydown');
	}
}

function announce() {
	let depth_axis = state.axis;
	let size = state.size == DEW.TILE ? 'full tile' : 'half tile';
	Blockbench.showQuickMessage(`${AXIS_LABEL[state.axis]}, ${depth_axis} ${state.depth}, ${size}`, BRUSH.MESSAGE_TIME);
	updatePlaneGrid();
	if (last_hover_event) onHover(last_hover_event);
}

// Texture brush: pick a cell of the atlas in the UV editor, then click or drag over tiles to paint it.
// Faces keep 1 texel per unit: each corner takes its texel from its offset inside the tile block.
const texture_state = {
	atlas: null,	// {texture: uuid, x0, y0, x1, y1}: texels where the atlas pick started and ended, snapped to the brush size when used
};
let paint_stroke = null;
let last_paint_hover_event = null;
let paint_previous_selection_mode = null;

function getAtlasTexture() {
	return texture_state.atlas && Texture.all.find(texture => texture.uuid == texture_state.atlas.texture);
}
// The picked rectangle of atlas cells at the given cell size
function atlasRegion(size) {
	let {x0, y0, x1, y1} = texture_state.atlas;
	let col0 = Math.floor(Math.min(x0, x1) / size), col1 = Math.floor(Math.max(x0, x1) / size);
	let row0 = Math.floor(Math.min(y0, y1) / size), row1 = Math.floor(Math.max(y0, y1) / size);
	return {x: col0 * size, y: row0 * size, cols: col1 - col0 + 1, rows: row1 - row0 + 1};
}
const posMod = (n, m) => ((n % m) + m) % m;
const blockOf = (tile, size) => [Math.floor(tile.u / size + 1e-6) * size, Math.floor(tile.v / size + 1e-6) * size];
const planeKey = tile => `${tile.axis}|${tile.depth}|${tile.sign}`;

// Which way texture-right and texture-down run along the plane's u and v axes, read from tileUV so they stay in step
function textureDirections(axis, sign) {
	let origin = tileUV(axis, sign, 0, 0, 2);
	return [tileUV(axis, sign, 1, 0, 2)[0] > origin[0] ? 1 : -1, tileUV(axis, sign, 0, 1, 2)[1] > origin[1] ? 1 : -1];
}
// The blocks of the stamp covering `block`. The stamp grid is anchored at `anchor`, the first block a stroke touched
// on this plane, which takes the region's top-left cell, so repeated stamps line up. a, b index the region's cells.
function stampBlocks(axis, sign, anchor, block, size, region) {
	let [ru, rv] = textureDirections(axis, sign);
	let i = Math.round(ru * (block[0] - anchor[0]) / size);
	let j = Math.round(rv * (block[1] - anchor[1]) / size);
	let si = i - posMod(i, region.cols), sj = j - posMod(j, region.rows);
	let blocks = [];
	for (let a = 0; a < region.cols; a++) {
		for (let b = 0; b < region.rows; b++) {
			blocks.push({u: anchor[0] + ru * (si + a) * size, v: anchor[1] + rv * (sj + b) * size, a, b});
		}
	}
	return blocks;
}

// Tile faces of the visible meshes by plane and position, so a stamp reaches tiles away from the cursor
function buildTileIndex() {
	let index = new Map();
	for (let mesh of Mesh.all) {
		if (mesh.visibility === false || mesh.locked) continue;
		mesh.mesh.updateMatrixWorld(true);
		for (let fkey in mesh.faces) {
			let tile = describeTile(mesh, mesh.faces[fkey]);
			if (tile) index.set(`${planeKey(tile)}|${tile.u}|${tile.v}`, {mesh, fkey});
		}
	}
	return index;
}
function paintFace(mesh, face, axis, sign, block_u, block_v, size, cell_x, cell_y, texture) {
	let [ua, va] = PLANE_AXES[axis];
	let factor_x = texture.getUVWidth() / texture.width;
	let factor_y = texture.getUVHeight() / texture.height;
	let changed = false;
	for (let vkey of face.vertices) {
		let point = mesh.mesh.localToWorld(new THREE.Vector3().fromArray(mesh.vertices[vkey]));
		let [tu, tv] = tileUV(axis, sign, Math.round(point[ua] - block_u), Math.round(point[va] - block_v), size);
		let uv = [(cell_x + tu) * factor_x, (cell_y + tv) * factor_y];
		if (!face.uv[vkey] || face.uv[vkey][0] != uv[0] || face.uv[vkey][1] != uv[1]) changed = true;
		face.uv[vkey] = uv;
	}
	if (face.texture != texture.uuid) {
		face.texture = texture.uuid;
		changed = true;
	}
	return changed;
}
// Paints the whole stamp around a touched tile and returns the meshes that changed
function paintStamp(tile) {
	let texture = getAtlasTexture();
	let size = state.size;
	let region = atlasRegion(size);
	let plane = planeKey(tile);
	let block = blockOf(tile, size);
	if (!paint_stroke.anchors.has(plane)) paint_stroke.anchors.set(plane, block);
	let changed = new Set();
	for (let {u, v, a, b} of stampBlocks(tile.axis, tile.sign, paint_stroke.anchors.get(plane), block, size, region)) {
		for (let du = 0; du < size; du += H) {
			for (let dv = 0; dv < size; dv += H) {
				let entry = paint_stroke.tiles.get(`${plane}|${round3(u + du)}|${round3(v + dv)}`);
				let face = entry && entry.mesh.faces[entry.fkey];
				if (face && paintFace(entry.mesh, face, tile.axis, tile.sign, u, v, size, region.x + a * size, region.y + b * size, texture)) {
					changed.add(entry.mesh);
				}
			}
		}
	}
	return changed;
}

function paintStep(event) {
	let hit = paint_stroke.preview.raycast(event);
	if (!hit || hit.type != 'element' || !(hit.element instanceof Mesh)) return;
	let tile = describeTile(hit.element, hit.element.faces[hit.face]);
	if (!tile) return;
	let changed = paintStamp(tile);
	if (changed.size) {
		paint_stroke.changed = true;
		Canvas.updateView({elements: [...changed], element_aspects: {uv: true, faces: true}});
	}
}
function startPaintStroke(preview, event) {
	if (!getAtlasTexture()) {
		Blockbench.showQuickMessage('Pick a tile in the UV editor first', BRUSH.MESSAGE_TIME);
		return;
	}
	Undo.initEdit({elements: Mesh.all.filter(mesh => mesh.visibility !== false && !mesh.locked), uv_only: true});
	paint_stroke = {preview, changed: false, tiles: buildTileIndex(), anchors: new Map()};
	paintStep(event);
	document.addEventListener('mousemove', movePaintStroke);
	document.addEventListener('mouseup', endPaintStroke);
}
function movePaintStroke(event) {
	if (paint_stroke) paintStep(event);
}
function endPaintStroke() {
	document.removeEventListener('mousemove', movePaintStroke);
	document.removeEventListener('mouseup', endPaintStroke);
	if (!paint_stroke) return;
	let changed = paint_stroke.changed;
	paint_stroke = null;
	if (changed) {
		Undo.finishEdit('Paint tile textures');
	} else {
		Undo.cancelEdit();
	}
}

function onPaintHover(event) {
	last_paint_hover_event = event;
	let preview = paint_stroke ? paint_stroke.preview : event.target && event.target.preview;
	if (!preview || !preview.camera || Format.id != 'dew_scene') return hideGhost();
	let hit = preview.raycast(event);
	let tile = hit && hit.type == 'element' && hit.element instanceof Mesh && describeTile(hit.element, hit.element.faces[hit.face]);
	if (!tile) return hideGhost();
	// The ghost covers the whole stamp a click (or the current stroke) would paint
	let size = state.size;
	let block = blockOf(tile, size);
	let region = texture_state.atlas ? atlasRegion(size) : {cols: 1, rows: 1};
	let anchor = (paint_stroke && paint_stroke.anchors.get(planeKey(tile))) || block;
	let blocks = stampBlocks(tile.axis, tile.sign, anchor, block, size, region);
	let us = blocks.map(b => b.u), vs = blocks.map(b => b.v);
	let u0 = Math.min(...us), v0 = Math.min(...vs);
	showGhost(tile.axis, tile.depth, tile.sign, u0, v0, Math.max(...us) - u0 + size, BRUSH.PAINT_COLOR, Math.max(...vs) - v0 + size);
}

// Grid lines and the picked cell drawn over the atlas in the UV editor, sized in percent so they follow zoom
function updateAtlasOverlay() {
	let vue = UVEditor.vue;
	if (!vue) return;
	let texture = Toolbox.selected && Toolbox.selected.atlas_picker && vue.texture instanceof Texture ? vue.texture : null;
	if (!texture || !texture.width) {
		vue.atlas_overlay = null;
		return;
	}
	let w = texture.width, h = texture.height;
	let lines = color => `linear-gradient(to right, ${color} 1px, transparent 1px), linear-gradient(to bottom, ${color} 1px, transparent 1px)`;
	let tile_size = `${DEW.TILE / w * 100}% ${DEW.TILE / h * 100}%`;
	let half_size = `${H / w * 100}% ${H / h * 100}%`;
	let grid = {
		position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 2,
		backgroundImage: `${lines(BRUSH.ATLAS_TILE_LINE)}, ${lines(BRUSH.ATLAS_HALF_LINE)}`,
		backgroundSize: `${tile_size}, ${tile_size}, ${half_size}, ${half_size}`,
	};
	let cell = null;
	if (texture_state.atlas && texture_state.atlas.texture == texture.uuid) {
		let region = atlasRegion(state.size);
		cell = {
			position: 'absolute', pointerEvents: 'none', zIndex: 3, boxSizing: 'border-box',
			left: region.x / w * 100 + '%', top: region.y / h * 100 + '%',
			width: region.cols * state.size / w * 100 + '%', height: region.rows * state.size / h * 100 + '%',
			border: `2px solid ${BRUSH.ATLAS_PICK_COLOR}`, boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.6)',
		};
	}
	vue.atlas_overlay = {grid, cell};
}
// A click picks one cell; dragging selects a rectangle of adjacent cells that paints as one stamp
function pickAtlasCell(texture, coords) {
	let texel = c => [Math.clamp(Math.floor(c.x), 0, texture.width - 1), Math.clamp(Math.floor(c.y), 0, texture.height - 1)];
	let [x, y] = texel(coords);
	texture_state.atlas = {texture: texture.uuid, x0: x, y0: y, x1: x, y1: y};
	updateAtlasOverlay();
	let move = event => {
		[texture_state.atlas.x1, texture_state.atlas.y1] = texel(UVEditor.getBrushCoordinates(event, texture));
		updateAtlasOverlay();
	};
	let stop = () => {
		document.removeEventListener('pointermove', move);
		document.removeEventListener('pointerup', stop);
	};
	document.addEventListener('pointermove', move);
	document.addEventListener('pointerup', stop);
}
function refreshAtlasView() {
	if (!UVEditor.vue) return;
	UVEditor.vue.updateTexture();
	updateAtlasOverlay();
}
// Picking a texture in the textures panel only refreshes the UV editor in paint mode, so the brush does it here
Blockbench.on('select_texture', () => {
	if (Toolbox.selected && Toolbox.selected.atlas_picker) refreshAtlasView();
});

// Tile select: paints a face selection. A plain stroke replaces the selection, Shift adds, Ctrl removes.
// It is Blockbench's own mesh face selection, so the move gizmo and mesh actions work on it afterwards.
let select_stroke = null;
let active_hover = null;	// hover handler of the active select / texture / bucket tool, re-run when C changes the size

// The face under the cursor. Face selection mode can put vertex points or edges in front, so this falls back to
// the first element surface behind them (same triangle-to-face mapping as Preview.raycast)
function hitFace(preview, event) {
	let data = preview.raycast(event);
	if (!data || !data.intersects) return null;
	if (data.type == 'element') {
		return data.element instanceof Mesh && data.element.faces[data.face] ? {element: data.element, face: data.face, point: data.intersects[0].point} : null;
	}
	let intersect = data.intersects.find(i => i.object.isElement);
	let element = intersect && OutlinerNode.uuids[intersect.object.name];
	if (!(element instanceof Mesh)) return null;
	let index = intersect.faceIndex;
	for (let fkey in element.faces) {
		let count = element.faces[fkey].vertices.length;
		if (count < 3) continue;
		let triangles = count == 4 ? 2 : 1;
		if (index < triangles) return {element, face: fkey, point: intersect.point};
		index -= triangles;
	}
	return null;
}
function setFacesSelected(mesh, fkeys, remove) {
	let faces = mesh.getSelectedFaces(true);
	let changed = false;
	for (let fkey of fkeys) {
		if (faces.includes(fkey) == !remove) continue;
		if (remove) {
			faces.remove(fkey);
		} else {
			faces.push(fkey);
		}
		changed = true;
	}
	if (!changed) return false;
	// Selected vertices follow the selected faces, as they do for a face click
	mesh.getSelectedVertices(true).replace([...new Set(faces.flatMap(fkey => mesh.faces[fkey] ? mesh.faces[fkey].vertices : []))]);
	if (!remove && !mesh.selected) mesh.markAsSelected();
	return true;
}
function selectStep(event) {
	let hit = hitFace(select_stroke.preview, event);
	if (!hit) return;
	if (setFacesSelected(hit.element, blockTiles(hit.element, hit.face).fkeys, select_stroke.remove)) updateSelection();
}
function startSelectStroke(preview, event) {
	let remove = event.ctrlKey, add = event.shiftKey;
	Undo.initSelection();
	if (!remove && !add) {
		unselectAllElements();
		updateSelection();
	}
	select_stroke = {preview, remove};
	selectStep(event);
	document.addEventListener('mousemove', moveSelectStroke);
	document.addEventListener('mouseup', endSelectStroke);
}
function moveSelectStroke(event) {
	if (select_stroke) selectStep(event);
}
function endSelectStroke() {
	document.removeEventListener('mousemove', moveSelectStroke);
	document.removeEventListener('mouseup', endSelectStroke);
	if (!select_stroke) return;
	select_stroke = null;
	// Cancels itself when the selection did not change
	Undo.finishSelection('Select tiles');
}
function onSelectHover(event) {
	last_paint_hover_event = event;
	let preview = select_stroke ? select_stroke.preview : event.target && event.target.preview;
	if (!preview || !preview.camera || Format.id != 'dew_scene') return hideGhost();
	let hit = hitFace(preview, event);
	let block = hit && blockTiles(hit.element, hit.face);
	if (!block || !block.tile) return hideGhost();
	let removing = select_stroke ? select_stroke.remove : event.ctrlKey;
	showGhost(block.tile.axis, block.tile.depth, block.tile.sign, block.cu, block.cv, state.size, removing ? BRUSH.ERASE_COLOR : BRUSH.SELECT_COLOR);
}

// Paint bucket: floods the clicked tile's region (same plane and facing, connected edge to edge, across meshes)
// with the picked atlas cells. A multi-cell pick tiles from a fixed anchor, the plane origin, so fills always line up.
function bucketFill(tile) {
	let texture = getAtlasTexture();
	let size = state.size;
	let region = atlasRegion(size);
	let tiles = buildTileIndex();
	let plane = planeKey(tile);
	let [ru, rv] = textureDirections(tile.axis, tile.sign);
	let changed = new Set();
	let seen = new Set();
	let queue = [[tile.u, tile.v]];
	while (queue.length) {
		let [u, v] = queue.pop();
		let key = `${plane}|${round3(u)}|${round3(v)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		let entry = tiles.get(key);
		let face = entry && entry.mesh.faces[entry.fkey];
		if (!face) continue;
		let [bu, bv] = blockOf({u, v}, size);
		let a = posMod(Math.round(ru * bu / size), region.cols);
		let b = posMod(Math.round(rv * bv / size), region.rows);
		if (paintFace(entry.mesh, face, tile.axis, tile.sign, bu, bv, size, region.x + a * size, region.y + b * size, texture)) {
			changed.add(entry.mesh);
		}
		queue.push([u + H, v], [u - H, v], [u, v + H], [u, v - H]);
	}
	return changed;
}
function bucketClick(preview, event) {
	if (!getAtlasTexture()) {
		Blockbench.showQuickMessage('Pick a tile in the UV editor first', BRUSH.MESSAGE_TIME);
		return;
	}
	let hit = hitFace(preview, event);
	let tile = hit && describeTile(hit.element, hit.element.faces[hit.face]);
	if (!tile) return;
	Undo.initEdit({elements: Mesh.all.filter(mesh => mesh.visibility !== false && !mesh.locked), uv_only: true});
	let changed = bucketFill(tile);
	if (!changed.size) return Undo.cancelEdit();
	Undo.finishEdit('Fill tiles');
	Canvas.updateView({elements: [...changed], element_aspects: {uv: true, faces: true}});
}
function onBucketHover(event) {
	last_paint_hover_event = event;
	let preview = event.target && event.target.preview;
	if (!preview || !preview.camera || Format.id != 'dew_scene') return hideGhost();
	let hit = hitFace(preview, event);
	let tile = hit && describeTile(hit.element, hit.element.faces[hit.face]);
	if (!tile) return hideGhost();
	let [cu, cv] = blockOf(tile, state.size);
	showGhost(tile.axis, tile.depth, tile.sign, cu, cv, state.size, BRUSH.PAINT_COLOR);
}

// Shave: bevels an outside corner where two planes of square tiles meet. The cut is 45 degrees and exactly one block
// deep on both sides (a half or full tile, per C): the two blocks touching the corner edge become one diagonal face
// that keeps the texture of the side the cursor touched. Ends close automatically: a tile in the end plane (a top
// face) is trimmed to the inside of the cut, a notch against a still-square stretch of the corner gets a triangle,
// and a triangle left by shaving the neighboring stretch earlier is removed.
let shave_stroke = null;
let shave_previous_selection_mode = null;

const samePoint = (a, b) => a.distanceToSquared(b) < 1e-6;
function worldVertex(mesh, vkey) {
	return mesh.mesh.localToWorld(new THREE.Vector3().fromArray(mesh.vertices[vkey]));
}
// Tile quads of one plane inside a box given as world-axis ranges; null if one is missing, unless partial
function quadsIn(tiles, axis, depth, sign, ranges, partial = false) {
	let [ua, va] = PLANE_AXES[axis];
	let [u_lo, u_hi] = ranges[ua].slice().sort((a, b) => a - b);
	let [v_lo, v_hi] = ranges[va].slice().sort((a, b) => a - b);
	let found = [];
	for (let u = u_lo; u < u_hi - 1e-6; u += H) {
		for (let v = v_lo; v < v_hi - 1e-6; v += H) {
			let entry = tiles.get(`${axis}|${round3(depth)}|${sign}|${round3(u)}|${round3(v)}`);
			if (entry) {
				found.push(entry);
			} else if (!partial) {
				return null;
			}
		}
	}
	return found;
}

// The corner a click would cut: the hovered tile's block edge nearest the cursor, when a complete block of the
// perpendicular plane meets it there. a1 / d1 / s1 is the touched plane, n the axis across the edge (the other
// plane's normal, e its position, s2 the edge's side), al the axis along the edge from lo to hi.
// Shaving looks for an outside corner, where the other block sits behind the touched plane and faces the same way
// as the edge side. A ramp looks for an inside corner, where it sits in front of it and faces the other way.
function shaveTarget(preview, event, tiles, inside) {
	let hit = hitFace(preview, event);
	let tile = hit && describeTile(hit.element, hit.element.faces[hit.face]);
	if (!tile) return null;
	let S = state.size;
	let {axis: a1, depth: d1, sign: s1} = tile;
	let [pu, pv] = PLANE_AXES[a1];
	let [cu, cv] = blockOf(tile, S);
	let p = hit.point;
	// Edges of the hovered block, nearest the cursor first: the nearest one that carries a corner wins, so a hover
	// anywhere on a tile beside a corner works, not only the wedge of it pointing at that corner
	let edges = [
		{n: pu, e: cu, s2: -1, al: pv, lo: cv, dist: p[pu] - cu},
		{n: pu, e: cu + S, s2: 1, al: pv, lo: cv, dist: cu + S - p[pu]},
		{n: pv, e: cv, s2: -1, al: pu, lo: cu, dist: p[pv] - cv},
		{n: pv, e: cv + S, s2: 1, al: pu, lo: cu, dist: cv + S - p[pv]},
	].sort((a, b) => a.dist - b.dist);
	let side = inside ? 1 : -1;
	for (let edge of edges) {
		let c = {a1, d1, s1, S, inside, n: edge.n, e: edge.e, s2: edge.s2, al: edge.al, lo: edge.lo, hi: edge.lo + S,
			mesh: hit.element, texture: hit.element.faces[hit.face].texture || false};
		let along = [c.lo, c.hi];
		c.touched = quadsIn(tiles, a1, d1, s1, {[c.n]: [c.e - c.s2 * S, c.e], [c.al]: along});
		c.other = quadsIn(tiles, c.n, c.e, inside ? -c.s2 : c.s2, {[a1]: [d1, d1 + side * s1 * S], [c.al]: along});
		if (c.touched && c.other) return c;
	}
	return null;
}
function cornerPoint(c, a1_value, n_value, along) {
	let point = new THREE.Vector3();
	point[c.a1] = a1_value;
	point[c.n] = n_value;
	point[c.al] = along;
	return point;
}
// E runs along the corner edge, F1 along the far edge of the touched block, F2 along the far edge of the other block
const cornerE = (c, w) => cornerPoint(c, c.d1, c.e, w);
const cornerF1 = (c, w) => cornerPoint(c, c.d1, c.e - c.s2 * c.S, w);
const cornerF2 = (c, w) => cornerPoint(c, c.d1 + (c.inside ? 1 : -1) * c.s1 * c.S, c.e, w);
const chamferPoints = c => [cornerF1(c, c.lo), cornerF1(c, c.hi), cornerF2(c, c.hi), cornerF2(c, c.lo)];

function strokeVertex(mesh, world) {
	let map = shave_stroke.vertex_maps.get(mesh);
	if (!map) shave_stroke.vertex_maps.set(mesh, map = buildVertexMap(mesh));
	let local = mesh.mesh.worldToLocal(world.clone());
	let position = [round3(local.x), round3(local.y), round3(local.z)];
	let id = position.join(',');
	let vkey = map.get(id);
	if (!vkey || !mesh.vertices[vkey]) {
		vkey = mesh.addVertices(position)[0];
		map.set(id, vkey);
	}
	return vkey;
}
function addShaveFace(mesh, points, uvs, texture, normal) {
	let vkeys = points.map(point => strokeVertex(mesh, point));
	let uv = {};
	vkeys.forEach((vkey, i) => uv[vkey] = uvs[i]);
	let face = new MeshFace(mesh, {vertices: vkeys, uv, texture});
	mesh.addFaces(face);
	if (worldNormal(mesh, face).dot(normal) < 0) face.invert();
	shave_stroke.touched.add(mesh);
}
function findTriangle(points) {
	for (let mesh of Mesh.all) {
		for (let fkey in mesh.faces) {
			let face = mesh.faces[fkey];
			if (face.vertices.length != 3) continue;
			let corners = face.vertices.map(vkey => worldVertex(mesh, vkey));
			if (points.every(point => corners.some(corner => samePoint(corner, point)))) return {mesh, fkey};
		}
	}
	return null;
}
function uvOnQuads(quads, world) {
	for (let {mesh, fkey} of quads) {
		let face = mesh.faces[fkey];
		for (let vkey of face.vertices) {
			if (samePoint(worldVertex(mesh, vkey), world)) return face.uv[vkey] ? face.uv[vkey].slice() : [0, 0];
		}
	}
	return [0, 0];
}
// A face of the end plane loses what lies on the corner side of the cut: removed whole, or cut to a triangle
// where the diagonal splits it
function trimCap(c, {mesh, fkey}) {
	let face = mesh.faces[fkey];
	let side = vkey => {
		let p = worldVertex(mesh, vkey);
		return c.s1 * (p[c.a1] - c.d1) + c.s2 * (p[c.n] - c.e) + c.S;
	};
	let sorted = face.getSortedVertices();
	let values = sorted.map(side);
	if (values.every(v => v <= 1e-3)) return;
	if (values.every(v => v >= -1e-3)) {
		delete mesh.faces[fkey];
	} else {
		let keep = sorted.filter((vkey, i) => values[i] <= 1e-3);
		sorted.forEach(vkey => {
			if (!keep.includes(vkey)) delete face.uv[vkey];
		});
		face.vertices.replace(keep);
	}
	shave_stroke.touched.add(mesh);
}
function closeEnd(c, w, dir, gap_uv) {
	let triangle = [cornerE(c, w), cornerF1(c, w), cornerF2(c, w)];
	// Shaved earlier from the other side: the corner is now cut on both sides of this end
	let gap = findTriangle(triangle);
	if (gap) {
		delete gap.mesh.faces[gap.fkey];
		shave_stroke.touched.add(gap.mesh);
		return;
	}
	let tiles = shave_stroke.tiles;
	let square = {[c.a1]: [c.d1, c.d1 + (c.inside ? 1 : -1) * c.s1 * c.S], [c.n]: [c.e - c.s2 * c.S, c.e]};
	let normal = new THREE.Vector3();
	if (c.inside) {
		// A wall across this end already closes the wedge
		if (quadsIn(tiles, c.al, w, -dir, square)) return;
		normal[c.al] = dir;
	} else {
		let caps = quadsIn(tiles, c.al, w, dir, square, true);
		if (caps.length) {
			caps.forEach(cap => trimCap(c, cap));
			return;
		}
		// The corner stays square past this end: close the notch with a triangle facing back along the corner
		let beyond = dir > 0 ? [w, w + H] : [w - H, w];
		let continues = quadsIn(tiles, c.a1, c.d1, c.s1, {[c.n]: [c.e - c.s2 * H, c.e], [c.al]: beyond})
			&& quadsIn(tiles, c.n, c.e, c.s2, {[c.a1]: [c.d1 - c.s1 * H, c.d1], [c.al]: beyond});
		if (!continues) return;
		normal[c.al] = -dir;
	}
	addShaveFace(c.mesh, triangle, triangle.map(gap_uv), c.texture, normal);
}
function shaveCorner(c) {
	// Read the touched side's UVs before its tiles go
	let uvs = [cornerF1(c, c.lo), cornerF1(c, c.hi), cornerE(c, c.hi), cornerE(c, c.lo)].map(point => uvOnQuads(c.touched, point));
	let texture = c.texture && Texture.all.find(t => t.uuid == c.texture);
	let fx = texture ? texture.getUVWidth() / texture.width : 1;
	let fy = texture ? texture.getUVHeight() / texture.height : 1;
	let cell = [Math.min(...uvs.map(uv => uv[0])), Math.min(...uvs.map(uv => uv[1]))];
	for (let {mesh, fkey} of [...c.touched, ...c.other]) {
		delete mesh.faces[fkey];
		shave_stroke.touched.add(mesh);
	}
	let normal = new THREE.Vector3();
	normal[c.a1] = c.s1;
	normal[c.n] = c.inside ? -c.s2 : c.s2;
	// The diagonal stretches the touched block's texture across its width: F1 keeps its UVs, F2 takes the corner edge's
	addShaveFace(c.mesh, chamferPoints(c), uvs, c.texture, normal);
	// End triangles map the touched block's cell flat onto the end plane
	let [qu, qv] = PLANE_AXES[c.al];
	let corner = cornerE(c, 0), far = cornerPoint(c, c.d1 + (c.inside ? 1 : -1) * c.s1 * c.S, c.e - c.s2 * c.S, 0);
	let origin = [Math.min(corner[qu], far[qu]), Math.min(corner[qv], far[qv])];
	let gapUV = sign => point => {
		let [tu, tv] = tileUV(c.al, sign, Math.round(point[qu] - origin[0]), Math.round(point[qv] - origin[1]), c.S);
		return [cell[0] + tu * fx, cell[1] + tv * fy];
	};
	let facing = c.inside ? 1 : -1;
	closeEnd(c, c.lo, -1, gapUV(-facing));
	closeEnd(c, c.hi, 1, gapUV(facing));
}

function shaveStep(event) {
	let corner = shaveTarget(shave_stroke.preview, event, shave_stroke.tiles, shave_stroke.inside);
	if (!corner) return;
	shaveCorner(corner);
	shave_stroke.changed = true;
	shave_stroke.tiles = buildTileIndex();
	Canvas.updateView({elements: [...shave_stroke.touched], element_aspects: {geometry: true, faces: true, uv: true}});
}
function startShaveStroke(preview, event) {
	Undo.initEdit({elements: Mesh.all.filter(mesh => mesh.visibility !== false && !mesh.locked)});
	shave_stroke = {preview, inside: cutsInside(), tiles: buildTileIndex(), vertex_maps: new Map(), touched: new Set(), changed: false};
	shaveStep(event);
	document.addEventListener('mousemove', moveShaveStroke);
	document.addEventListener('mouseup', endShaveStroke);
}
function moveShaveStroke(event) {
	if (shave_stroke) shaveStep(event);
}
function endShaveStroke() {
	document.removeEventListener('mousemove', moveShaveStroke);
	document.removeEventListener('mouseup', endShaveStroke);
	if (!shave_stroke) return;
	let finished = shave_stroke;
	shave_stroke = null;
	if (!finished.changed) return Undo.cancelEdit();
	finished.touched.forEach(removeLooseVertices);
	Undo.finishEdit(finished.inside ? 'Ramp corners' : 'Shave corners');
	Canvas.updateView({elements: [...finished.touched], element_aspects: {geometry: true, faces: true, uv: true}, selection: true});
	if (last_paint_hover_event) onShaveHover(last_paint_hover_event);
}
function onShaveHover(event) {
	last_paint_hover_event = event;
	let preview = shave_stroke ? shave_stroke.preview : event.target && event.target.preview;
	if (!preview || !preview.camera || Format.id != 'dew_scene') return hideGhost();
	let inside = shave_stroke ? shave_stroke.inside : cutsInside();
	let corner = shaveTarget(preview, event, shave_stroke ? shave_stroke.tiles : buildTileIndex(), inside);
	if (!corner) return hideGhost();
	let lift = new THREE.Vector3();
	lift[corner.a1] = corner.s1 * BRUSH.LIFT;
	lift[corner.n] = (inside ? -corner.s2 : corner.s2) * BRUSH.LIFT;
	// The shave preview lies behind the tiles it replaces, so it draws through them; a ramp sits in the open
	showGhostQuad(chamferPoints(corner).map(point => point.add(lift)), inside ? BRUSH.RAMP_COLOR : BRUSH.SHAVE_COLOR, !inside);
}

BARS.defineActions(function() {
	new Tool('dew_tile_brush', {
		name: 'Tile Brush',
		description: 'Paint tiles onto the work plane. Ctrl erases. W cycles the plane, A / D step it, C switches full / half tiles',
		icon: 'grid_on',
		category: 'tools',
		transformerMode: 'hidden',
		selectElements: false,
		cursor: 'crosshair',
		modes: ['edit'],
		condition: () => Modes.edit && Format.id == 'dew_scene',
		onCanvasClick(data) {
			let event = data && data.event;
			if (!event || event.button !== 0 || event.altKey || stroke) return;
			startStroke(Preview.selected, event);
		},
		onSelect() {
			previous_selection_mode = BarItems.selection_mode.value;
			BarItems.selection_mode.set('object');
			updateSelection();
			document.addEventListener('mousemove', onHover);
			document.addEventListener('keydown', onModifierKey);
			document.addEventListener('keyup', onModifierKey);
			updatePlaneGrid();
		},
		onUnselect() {
			document.removeEventListener('mousemove', onHover);
			document.removeEventListener('keydown', onModifierKey);
			document.removeEventListener('keyup', onModifierKey);
			hideGhost();
			removePlaneGrid();
			if (previous_selection_mode && previous_selection_mode != 'object') {
				BarItems.selection_mode.set(previous_selection_mode);
				updateSelection();
			}
		},
	});

	new Tool('dew_texture_brush', {
		name: 'Texture Brush',
		description: 'Pick a tile of the atlas in the UV editor (drag to pick several as one stamp), then click or drag over tiles to paint. C switches full / half tiles',
		icon: 'format_paint',
		category: 'tools',
		transformerMode: 'hidden',
		selectElements: false,
		cursor: 'crosshair',
		modes: ['edit'],
		condition: () => Modes.edit && Format.id == 'dew_scene',
		onCanvasClick(data) {
			let event = data && data.event;
			if (!event || event.button !== 0 || event.altKey || paint_stroke) return;
			startPaintStroke(Preview.selected, event);
		},
		atlas_picker: true,			// the UV editor shows the selected texture and hands clicks to onAtlasClick
		onAtlasClick: pickAtlasCell,
		onSelect() {
			paint_previous_selection_mode = BarItems.selection_mode.value;
			BarItems.selection_mode.set('object');
			updateSelection();
			active_hover = onPaintHover;
			document.addEventListener('mousemove', onPaintHover);
			refreshAtlasView();
		},
		onUnselect() {
			document.removeEventListener('mousemove', onPaintHover);
			active_hover = null;
			hideGhost();
			if (paint_previous_selection_mode && paint_previous_selection_mode != 'object') {
				BarItems.selection_mode.set(paint_previous_selection_mode);
				updateSelection();
			}
			// Runs before the next tool becomes active, so the UV editor refresh waits for the switch
			setTimeout(refreshAtlasView, 0);
		},
	});

	new Tool('dew_shave', {
		name: 'Shave',
		description: 'Bevel outside corners: click or drag along a corner to cut it at 45 degrees, one block deep. C switches full / half tiles',
		icon: 'change_history',
		category: 'tools',
		transformerMode: 'hidden',
		selectElements: false,
		cursor: 'crosshair',
		modes: ['edit'],
		condition: () => Modes.edit && Format.id == 'dew_scene',
		onCanvasClick(data) {
			let event = data && data.event;
			if (!event || event.button !== 0 || event.altKey || shave_stroke) return;
			startShaveStroke(Preview.selected, event);
		},
		onSelect() {
			shave_previous_selection_mode = BarItems.selection_mode.value;
			BarItems.selection_mode.set('object');
			updateSelection();
			active_hover = onShaveHover;
			document.addEventListener('mousemove', onShaveHover);
		},
		onUnselect() {
			document.removeEventListener('mousemove', onShaveHover);
			active_hover = null;
			hideGhost();
			if (shave_previous_selection_mode && shave_previous_selection_mode != 'object') {
				BarItems.selection_mode.set(shave_previous_selection_mode);
				updateSelection();
			}
		},
	});

	new Tool('dew_ramp', {
		name: 'Ramp',
		description: 'Fill inside corners: click or drag along a corner to close it with a 45 degree slope, one block deep. C switches full / half tiles',
		icon: 'trending_up',
		category: 'tools',
		transformerMode: 'hidden',
		selectElements: false,
		cursor: 'crosshair',
		modes: ['edit'],
		condition: () => Modes.edit && Format.id == 'dew_scene',
		onCanvasClick(data) {
			let event = data && data.event;
			if (!event || event.button !== 0 || event.altKey || shave_stroke) return;
			startShaveStroke(Preview.selected, event);
		},
		onSelect() {
			shave_previous_selection_mode = BarItems.selection_mode.value;
			BarItems.selection_mode.set('object');
			updateSelection();
			active_hover = onShaveHover;
			document.addEventListener('mousemove', onShaveHover);
		},
		onUnselect() {
			document.removeEventListener('mousemove', onShaveHover);
			active_hover = null;
			hideGhost();
			if (shave_previous_selection_mode && shave_previous_selection_mode != 'object') {
				BarItems.selection_mode.set(shave_previous_selection_mode);
				updateSelection();
			}
		},
	});

	new Tool('dew_tile_select', {
		name: 'Tile Select',
		description: 'Paint to select tiles. Shift adds, Ctrl removes, C switches full / half tiles',
		icon: 'highlight_alt',
		category: 'tools',
		transformerMode: 'hidden',
		selectElements: false,
		cursor: 'crosshair',
		modes: ['edit'],
		condition: () => Modes.edit && Format.id == 'dew_scene',
		onCanvasClick(data) {
			let event = data && data.event;
			if (!event || event.button !== 0 || event.altKey || select_stroke) return;
			startSelectStroke(Preview.selected, event);
		},
		onSelect() {
			// Face mode shows the selection and leaves it ready for the move gizmo and mesh actions
			BarItems.selection_mode.set('face');
			updateSelection();
			active_hover = onSelectHover;
			document.addEventListener('mousemove', onSelectHover);
		},
		onUnselect() {
			document.removeEventListener('mousemove', onSelectHover);
			active_hover = null;
			hideGhost();
		},
	});

	new Tool('dew_paint_bucket', {
		name: 'Paint Bucket',
		description: 'Fill the connected tiles of a plane with the picked atlas tiles. C switches full / half tiles',
		icon: 'format_color_fill',
		category: 'tools',
		transformerMode: 'hidden',
		selectElements: false,
		cursor: 'crosshair',
		modes: ['edit'],
		condition: () => Modes.edit && Format.id == 'dew_scene',
		onCanvasClick(data) {
			let event = data && data.event;
			if (!event || event.button !== 0 || event.altKey) return;
			bucketClick(Preview.selected, event);
		},
		atlas_picker: true,
		onAtlasClick: pickAtlasCell,
		onSelect() {
			paint_previous_selection_mode = BarItems.selection_mode.value;
			BarItems.selection_mode.set('object');
			updateSelection();
			active_hover = onBucketHover;
			document.addEventListener('mousemove', onBucketHover);
			refreshAtlasView();
		},
		onUnselect() {
			document.removeEventListener('mousemove', onBucketHover);
			active_hover = null;
			hideGhost();
			if (paint_previous_selection_mode && paint_previous_selection_mode != 'object') {
				BarItems.selection_mode.set(paint_previous_selection_mode);
				updateSelection();
			}
			setTimeout(refreshAtlasView, 0);
		},
	});

	new Action('dew_tile_plane_axis', {
		name: 'Tile Brush: Cycle Work Plane',
		icon: 'flip_camera_android',
		category: 'tools',
		keybind: new Keybind({key: 'w'}),
		condition: isActive,
		click() {
			let next = AXES[(AXES.indexOf(state.axis) + 1) % AXES.length];
			state.depth = state.hover_point ? snap(state.hover_point[next]) : 0;
			state.axis = next;
			announce();
		}
	});
	new Action('dew_tile_plane_back', {
		name: 'Tile Brush: Step Plane Back',
		icon: 'arrow_downward',
		category: 'tools',
		keybind: new Keybind({key: 'a'}),
		condition: isActive,
		click() {
			state.depth -= H;
			announce();
		}
	});
	new Action('dew_tile_plane_forward', {
		name: 'Tile Brush: Step Plane Forward',
		icon: 'arrow_upward',
		category: 'tools',
		keybind: new Keybind({key: 'd'}),
		condition: isActive,
		click() {
			state.depth += H;
			announce();
		}
	});
	new Action('dew_tile_size', {
		name: 'Tile Brush: Full / Half Tile',
		icon: 'photo_size_select_small',
		category: 'tools',
		keybind: new Keybind({key: 'c'}),
		condition: isDewTool,
		click() {
			state.size = state.size == DEW.TILE ? H : DEW.TILE;
			if (Toolbox.selected.id == 'dew_tile_brush') {
				announce();
			} else {
				Blockbench.showQuickMessage(state.size == DEW.TILE ? 'Full tile' : 'Half tile', BRUSH.MESSAGE_TIME);
				updateAtlasOverlay();
				if (active_hover && last_paint_hover_event) active_hover(last_paint_hover_event);
			}
		}
	});
});

// Overlays live in the shared scene, so they go with the project. select_project fires after the
// project has restored its mode and tool, the first point where switching tools is safe.
Blockbench.on('unselect_project', () => {
	hideGhost();
	removePlaneGrid();
});
Blockbench.on('select_project', () => {
	if (!isDewTool()) return;
	if (Format.id != 'dew_scene') {
		BarItems.move_tool.select();
	} else {
		updatePlaneGrid();
	}
});

// The internals the scripted tests poke at
Object.assign(window, {DEWTileBrush: {state, texture_state, BRUSH, hitFace, describeTile, buildTileIndex, shaveTarget}});
