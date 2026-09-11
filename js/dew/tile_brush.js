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

// Texture coordinates inside one tile, oriented so textures read upright and unmirrored from the facing side
function tileUV(axis, sign, du, dv) {
	if (axis == 'y') return [sign > 0 ? du : H - du, dv];
	let u = (axis == 'x') == (sign > 0) ? H - du : du;
	return [u, H - dv];
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

// Faces to erase for a hit: the face itself, or every same-facing tile of the full-tile cell around it
function eraseTargets(mesh, fkey) {
	let tile = describeTile(mesh, mesh.faces[fkey]);
	if (!tile) return {fkeys: [fkey], tile: null};
	let size = state.size;
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
	for (let fkey of eraseTargets(mesh, hit.face).fkeys) {
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
function showGhost(axis, depth, sign, u0, v0, size, color) {
	hideGhost();
	let lifted = depth + BRUSH.LIFT * sign;
	let c = [[0, 0], [size, 0], [size, size], [0, size]].map(([du, dv]) => planePoint(axis, lifted, u0 + du, v0 + dv));
	let fill = new THREE.Mesh(
		new THREE.BufferGeometry().setFromPoints([c[0], c[1], c[2], c[0], c[2], c[3]]),
		new THREE.MeshBasicMaterial({color, transparent: true, opacity: BRUSH.GHOST_OPACITY, side: THREE.DoubleSide, depthWrite: false})
	);
	let outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(c), new THREE.LineBasicMaterial({color}));
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
			let {tile, cu, cv} = eraseTargets(hit.element, hit.face);
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
		condition: isActive,
		click() {
			state.size = state.size == DEW.TILE ? H : DEW.TILE;
			announce();
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
	if (!isActive()) return;
	if (Format.id != 'dew_scene') {
		BarItems.move_tool.select();
	} else {
		updatePlaneGrid();
	}
});

Object.assign(window, {DEWTileBrush: {state, BRUSH}});
