// A temporary lattice around the selection. Bind positions once; each drag changes only existing vertices.
import { THREE } from '../lib/libs';
import { PointerTarget } from '../interface/pointer_target';

export const CAGE = {
	MIN_POINTS: 2, MAX_POINTS: 5,
	MIN_THICKNESS: 1, FLAT_PADDING: 0.02,
	POINT_PIXELS: 8, PICK_PIXELS: 10, EDGE_PICK_PIXELS: 5,
	COLOR: 0xffc45e, HOVER_COLOR: 0xffffff, FACE_OPACITY: 0.12,
	FINE_MOVE: 0.1, MOVE_EPSILON: 1e-8,
};
let state = null, display = null, drag = null, hover = null, finishing = false;
let resolution = [2, 2, 2];
const history = new WeakMap();
const active = () => Modes.edit && Toolbox.selected?.id == 'dew_cage';
const clonePoints = points => points.map(p => p.clone());
const indexAt = (x, y, z, counts) => (z * counts[1] + y) * counts[0] + x;

function selection() {
	const mode = Condition(BarItems.selection_mode.condition) ? BarItems.selection_mode.value : 'object';
	return Mesh.selected.filter(mesh => mesh.visibility && !mesh.locked).map(mesh => {
		const keys = mode == 'object' ? Object.keys(mesh.vertices) : mesh.getSelectedVertices().filter(k => mesh.vertices[k]);
		return {mesh, keys: keys.slice()};
	}).filter(item => item.keys.length);
}
function signature(items) {
	return JSON.stringify([Project.uuid, BarItems.selection_mode.value, items.map(({mesh, keys}) => [mesh.uuid, keys.slice().sort()])]);
}

// Piecewise trilinear interpolation: even a larger lattice needs just eight weights per mesh vertex.
function weightsAt(point, box, counts) {
	const cell = [], fraction = [];
	for (let axis = 0; axis < 3; axis++) {
		const key = 'xyz'[axis];
		const t = Math.clamp((point[key] - box.min[key]) / (box.max[key] - box.min[key]), 0, 1) * (counts[axis] - 1);
		cell[axis] = Math.min(Math.floor(t), counts[axis] - 2);
		fraction[axis] = t - cell[axis];
	}
	const ids = [], weights = [];
	for (let z = 0; z <= 1; z++) for (let y = 0; y <= 1; y++) for (let x = 0; x <= 1; x++) {
		ids.push(indexAt(cell[0] + x, cell[1] + y, cell[2] + z, counts));
		weights.push((x ? fraction[0] : 1 - fraction[0]) * (y ? fraction[1] : 1 - fraction[1]) * (z ? fraction[2] : 1 - fraction[2]));
	}
	return {ids, weights};
}
function fit() {
	if (drag) finish(false);
	const items = selection();
	clearDisplay(); state = null;
	if (!active() || !items.length) return false;
	const box = new THREE.Box3();
	for (const item of items) {
		item.mesh.mesh.updateWorldMatrix(true, false);
		item.inverse = item.mesh.mesh.matrixWorld.clone().invert();
		item.base = item.keys.map(key => new THREE.Vector3().fromArray(item.mesh.vertices[key]).applyMatrix4(item.mesh.mesh.matrixWorld));
		item.base.forEach(p => box.expandByPoint(p));
	}
	const size = box.getSize(new THREE.Vector3());
	const thickness = Math.max(CAGE.MIN_THICKNESS, Math.max(size.x, size.y, size.z) * CAGE.FLAT_PADDING);
	for (const axis of ['x','y','z']) {
		if (size[axis] < thickness) {
			const middle = (box.min[axis] + box.max[axis]) / 2;
			box.min[axis] = middle - thickness / 2; box.max[axis] = middle + thickness / 2;
		}
	}
	const counts = resolution.slice(), rest = [], edges = [], faces = [];
	for (let z = 0; z < counts[2]; z++) for (let y = 0; y < counts[1]; y++) for (let x = 0; x < counts[0]; x++) {
		const c = [x,y,z], index = indexAt(x,y,z,counts);
		rest.push(new THREE.Vector3(...c.map((value, axis) => THREE.MathUtils.lerp(box.min['xyz'[axis]], box.max['xyz'[axis]], value / (counts[axis] - 1)))));
		for (let axis = 0; axis < 3; axis++) {
			if (c[axis] + 1 < counts[axis]) {
				const next = c.slice(); next[axis]++;
				edges.push([index, indexAt(...next,counts)]);
			}
		}
	}
	for (let axis = 0; axis < 3; axis++) {
		const a = (axis + 1) % 3, b = (axis + 2) % 3;
		for (const side of [0, counts[axis] - 1]) {
			for (let j = 0; j < counts[b] - 1; j++) for (let i = 0; i < counts[a] - 1; i++) {
				faces.push([[i,j],[i+1,j],[i+1,j+1],[i,j+1]].map(([u,v]) => {
					const c = []; c[axis] = side; c[a] = u; c[b] = v; return indexAt(...c,counts);
				}));
			}
		}
	}
	for (const item of items) item.bindings = item.base.map(p => weightsAt(p, box, counts));
	state = {binding: {items, rest, counts, edges, faces, signature: signature(items), project: Project.uuid}, controls: clonePoints(rest)};
	buildDisplay();
	return true;
}
function clearDisplay() {
	if (!display) return;
	Canvas.scene.remove(display.root);
	display.root.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });
	display.surface.geometry.dispose(); display.surface.material.dispose();
	display = null; hover = null;
}
function buildDisplay() {
	clearDisplay();
	const root = new THREE.Group(); root.name = 'Cage preview'; root.renderOrder = 1000;
	const pointGeometry = new THREE.BufferGeometry();
	pointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(state.controls.length * 3, 3));
	pointGeometry.setAttribute('color', new THREE.Float32BufferAttribute(state.controls.length * 3, 3));
	const points = new THREE.Points(pointGeometry, new THREE.PointsMaterial({size:CAGE.POINT_PIXELS, sizeAttenuation:false, vertexColors:true, depthTest:false, depthWrite:false}));
	const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({color:CAGE.COLOR, depthTest:false, depthWrite:false, transparent:true, opacity:0.8}));
	lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(state.binding.edges.length * 6, 3));
	const surface = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
	surface.geometry.setAttribute('position', pointGeometry.attributes.position);
	surface.geometry.setIndex(state.binding.faces.flatMap(f => [f[0],f[1],f[2],f[0],f[2],f[3]]));
	const highlight = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({color:CAGE.COLOR, side:THREE.DoubleSide, transparent:true, opacity:CAGE.FACE_OPACITY, depthTest:false, depthWrite:false}));
	highlight.geometry.setAttribute('position', new THREE.Float32BufferAttribute(12,3)); highlight.geometry.setIndex([0,1,2,0,2,3]);
	points.renderOrder = 1002; lines.renderOrder = 1001; highlight.renderOrder = 1000;
	points.frustumCulled = lines.frustumCulled = highlight.frustumCulled = false;
	root.add(lines, highlight, points); Canvas.scene.add(root);
	display = {root, points, lines, surface, highlight}; updateDisplay();
}
function updateDisplay() {
	if (!display || !state) return;
	const positions = display.points.geometry.attributes.position;
	state.controls.forEach((p,i) => positions.setXYZ(i,p.x,p.y,p.z)); positions.needsUpdate = true;
	const lines = display.lines.geometry.attributes.position;
	state.binding.edges.flat().forEach((id,i) => { const p=state.controls[id]; lines.setXYZ(i,p.x,p.y,p.z); }); lines.needsUpdate = true;
	display.surface.geometry.computeBoundingSphere(); display.surface.updateMatrixWorld(true);
	const selected = drag?.ids || hover?.ids || [];
	const color = new THREE.Color(CAGE.COLOR), white = new THREE.Color(CAGE.HOVER_COLOR);
	const colors = display.points.geometry.attributes.color;
	state.controls.forEach((p,i) => { const c = selected.includes(i) ? white : color; colors.setXYZ(i,c.r,c.g,c.b); }); colors.needsUpdate = true;
	display.highlight.visible = selected.length == 4;
	if (display.highlight.visible) {
		const buffer = display.highlight.geometry.attributes.position;
		selected.forEach((id,i) => {const p=state.controls[id]; buffer.setXYZ(i,p.x,p.y,p.z);}); buffer.needsUpdate=true;
	}
}
function rayAt(preview, event) {
	const r = preview.canvas.getBoundingClientRect();
	const raycaster = new THREE.Raycaster();
	raycaster.setFromCamera(new THREE.Vector2((event.clientX-r.left)/r.width*2-1, 1-(event.clientY-r.top)/r.height*2), preview.camera);
	return raycaster;
}
function pick(preview, event) {
	if (!state || !display) return null;
	const rect = preview.canvas.getBoundingClientRect(), mouse = new THREE.Vector3(event.clientX,event.clientY,0);
	const screen = state.controls.map(p => {
		const q = p.clone().project(preview.camera);
		return new THREE.Vector3(rect.left+(q.x+1)*rect.width/2, rect.top+(1-q.y)*rect.height/2,q.z);
	});
	let best = null, distance = CAGE.PICK_PIXELS, depth = Infinity;
	screen.forEach((p,i) => {
		if (p.z < -1 || p.z > 1) return;
		const d = Math.hypot(p.x-mouse.x,p.y-mouse.y);
		if (d < distance-0.01 || (d <= distance+0.01 && p.z < depth)) {best={ids:[i]};distance=d;depth=p.z;}
	});
	if (best) return best;
	distance = CAGE.EDGE_PICK_PIXELS; depth = Infinity;
	for (const edge of state.binding.edges) {
		const [a,b] = edge.map(i => screen[i]); if (a.z < -1 || a.z > 1 || b.z < -1 || b.z > 1) continue;
		const line = new THREE.Line3(new THREE.Vector3(a.x,a.y,0),new THREE.Vector3(b.x,b.y,0));
		const d = line.closestPointToPoint(mouse,true,new THREE.Vector3()).distanceTo(mouse), z = (a.z+b.z)/2;
		if (d < distance-0.01 || (d <= distance+0.01 && z < depth)) {best={ids:edge};distance=d;depth=z;}
	}
	if (best) return best;
	const hit = rayAt(preview,event).intersectObject(display.surface,false)[0];
	return hit ? {ids:state.binding.faces[Math.floor(hit.faceIndex/2)]} : null;
}

function applyControls() {
	const {binding,controls} = state;
	const offsets = controls.map((p,i) => p.clone().sub(binding.rest[i]));
	const point = new THREE.Vector3();
	for (const item of binding.items) {
		item.keys.forEach((key,i) => {
			point.copy(item.base[i]);
			const {ids,weights} = item.bindings[i];
			for (let j=0;j<8;j++) point.addScaledVector(offsets[ids[j]],weights[j]);
			point.applyMatrix4(item.inverse).toArray(item.mesh.vertices[key]);
		});
		item.mesh.preview_controller.updateGeometry(item.mesh);
	}
	updateDisplay();
}

function begin(preview, event, ids) {
	if (!state || drag || !PointerTarget.requestTarget(PointerTarget.types.gizmo_transform)) return false;
	const origin = new THREE.Vector3(); ids.forEach(id => origin.add(state.controls[id])); origin.divideScalar(ids.length);
	drag = {preview, ids:ids.slice(), before:clonePoints(state.controls), origin,
		start:{clientX:event.clientX,clientY:event.clientY}, axis:BarItems.dew_cage_axis.value,
		controls_enabled:preview.controls.enabled, started:false, pointerId:event.pointerId};
	preview.controls.stopMovement(); preview.controls.enabled = false;
	Preview.selected = preview; hover = null; updateDisplay();
	return true;
}
function moveBy(delta) {
	if (!drag || !state) return;
	if (!drag.started && delta.lengthSq() < CAGE.MOVE_EPSILON) return;
	if (!drag.started) {Undo.initEdit({elements:state.binding.items.map(item => item.mesh)}); drag.started=true;}
	state.controls = clonePoints(drag.before);
	drag.ids.forEach(id => state.controls[id].add(delta));
	applyControls();
}
function pointerMove(event) {
	if (!drag) return;
	const {preview,origin,axis,start} = drag;
	const normal = preview.camera.getWorldDirection(new THREE.Vector3());
	const direction = axis == 'view' ? null : new THREE.Vector3().setComponent('xyz'.indexOf(axis),1);
	if (direction) normal.addScaledVector(direction,-normal.dot(direction));
	if (normal.lengthSq() < CAGE.MOVE_EPSILON) {
		Blockbench.setCursorTooltip('Rotate the view to move along this axis'); return;
	}
	const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal.normalize(),origin);
	const first = rayAt(preview,start).ray.intersectPlane(plane,new THREE.Vector3());
	const current = rayAt(preview,event).ray.intersectPlane(plane,new THREE.Vector3());
	if (!first || !current) return;
	const delta = current.sub(first);
	if (direction) delta.copy(direction.multiplyScalar(delta.dot(direction)));
	if (event.shiftKey) delta.multiplyScalar(CAGE.FINE_MOVE);
	moveBy(delta);
	Blockbench.setCursorTooltip('Cage: ' + (axis == 'view' ? 'view plane' : axis.toUpperCase()) + ' | X/Y/Z constrain | Shift fine | Esc cancel');
}
function finish(keep = true) {
	if (!drag) return;
	const previous = drag; drag = null; finishing = true;
	try {
		const changed = state.controls.some((p,i) => p.distanceToSquared(previous.before[i]) > CAGE.MOVE_EPSILON);
		if (previous.started && keep && changed) {
			const entry = Undo.finishEdit('Deform cage');
			if (entry) history.set(entry, {binding:state.binding, before:previous.before, after:clonePoints(state.controls)});
		} else {
			state.controls = clonePoints(previous.before);
			if (previous.started) Undo.cancelEdit(true);
		}
		previous.preview.controls.enabled = previous.controls_enabled;
		PointerTarget.endTarget(PointerTarget.types.gizmo_transform);
		Blockbench.setCursorTooltip(); updateDisplay(); updateSelection();
	} finally {finishing = false;}
}
function setResolution(counts) {
	if (drag) finish(true);
	resolution = counts.map(value => Math.clamp(Math.round(Number(value) || CAGE.MIN_POINTS), CAGE.MIN_POINTS, CAGE.MAX_POINTS));
	resolution.forEach((value,i) => BarItems['dew_cage_'+'xyz'[i]]?.set(String(value)));
	return fit();
}
function restore(entry, side) {
	if (!active() || finishing) return;
	const saved = history.get(entry);
	if (!saved || saved.binding.project != Project.uuid || saved.binding.signature != signature(selection()) || saved.binding.items.some(item => !Mesh.all.includes(item.mesh))) {fit(); return;}
	state = {binding:saved.binding, controls:clonePoints(saved[side])};
	resolution = state.binding.counts.slice();
	resolution.forEach((value,i) => BarItems['dew_cage_'+'xyz'[i]].set(String(value)));
	buildDisplay();
}
function clear() {
	if (drag) finish(false);
	clearDisplay(); state = null; Blockbench.setCursorTooltip();
}
function previewFor(event) { return Preview.all.find(p => p.canvas == event.target); }
function consume(event) {event.preventDefault(); event.stopImmediatePropagation();}

// Capture cage gestures before ordinary vertex selection or camera controls can consume the same press.
document.addEventListener('pointerdown', event => {
	if (!active() || event.button != 0) return;
	const preview = previewFor(event); if (!preview) return;
	consume(event);
	const handle = pick(preview,event);
	if (handle) begin(preview,event,handle.ids);
}, true);
document.addEventListener('pointermove', event => {
	if (!active()) return;
	if (drag) {consume(event); pointerMove(event); return;}
	const preview = previewFor(event);
	const next = preview ? pick(preview,event) : null;
	if (JSON.stringify(next?.ids) != JSON.stringify(hover?.ids)) {hover=next;updateDisplay();}
	if (preview) preview.canvas.style.cursor = next ? 'grab' : 'default';
}, true);
document.addEventListener('pointerup', event => {
	if (!drag || event.button != 0) return;
	consume(event); finish(true);
}, true);
document.addEventListener('pointercancel', () => finish(false), true);
document.addEventListener('mousemove', event => {if (drag) consume(event);}, true);
document.addEventListener('keydown', event => {
	if (!drag) return;
	const key = event.key.toLowerCase();
	if (key == 'escape' || ((event.ctrlKey || event.metaKey) && key == 'z')) {consume(event);finish(false);}
	else if (['x','y','z'].includes(key) && !event.ctrlKey && !event.altKey) {
		consume(event); drag.axis = drag.axis == key ? 'view' : key;
		Blockbench.setCursorTooltip('Cage movement: ' + drag.axis.toUpperCase());
	} else if (!['shift','control','alt','meta'].includes(key)) consume(event);
}, true);
window.addEventListener('blur', () => finish(false));
Blockbench.on('update_selection', () => {
	if (active() && !drag && !finishing && (!state || state.binding.signature != signature(selection()))) fit();
});
Blockbench.on('finished_edit', () => {if (active() && !drag && !finishing) fit();});
Blockbench.on('undo', ({entry}) => restore(entry,'before'));
Blockbench.on('redo', ({entry}) => restore(entry,'after'));
Blockbench.on('unselect_project', clear);
Blockbench.on('select_project', () => {if (active()) fit();});

BARS.defineActions(function() {
	for (let axis=0;axis<3;axis++) {
		const letter = 'xyz'[axis];
		new BarSelect('dew_cage_'+letter, {
			name:letter.toUpperCase()+' cage points', description:'Number of cage points along '+letter.toUpperCase()+'. Refits the cage around the current shape.',
			category:'tools', value:'2',
			options:Object.fromEntries(Array.from({length:CAGE.MAX_POINTS-CAGE.MIN_POINTS+1},(_,i) => [String(i+CAGE.MIN_POINTS),letter.toUpperCase()+': '+(i+CAGE.MIN_POINTS)])),
			onChange({value}) {const counts=resolution.slice();counts[axis]=Number(value);setResolution(counts);},
		});
	}
	new BarSelect('dew_cage_axis', {
		name:'Cage movement', description:'Drag in the view plane or along a world axis. X/Y/Z also constrain while dragging.',
		category:'tools', value:'view', options:{view:'View plane',x:'X axis',y:'Y axis',z:'Z axis'},
	});
	new Action('dew_cage_refit', {
		name:'Refit Cage', description:'Fit a fresh cage around the current selection, keeping all mesh edits',
		icon:'fit_screen', category:'tools', condition:() => active(), click:fit,
	});
	new Tool('dew_cage', {
		name:'Deform Cage', description:'Fit a cage around selected mesh vertices. Drag points, edges or faces; Shift for fine movement, X/Y/Z to constrain, Esc to cancel.',
		icon:'view_in_ar', category:'tools', transformerMode:'hidden', selectElements:false, toolbar:'dew_cage',
		modes:['edit'], condition:() => Modes.edit && Format.meshes && Mesh.selected.length > 0,
		onSelect() {if (!fit()) Blockbench.showQuickMessage('Select a mesh or mesh vertices to fit a cage');},
		onUnselect() {clear();Preview.all.forEach(p => p.canvas.style.cursor='');},
	});
});

Object.assign(window, {DEWCage:{CAGE,fit,setResolution,weightsAt,pick,begin,moveBy,finish,getState:()=>state,getDrag:()=>drag}});
