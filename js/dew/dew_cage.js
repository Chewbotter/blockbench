// A temporary lattice around the selection. Bind positions once; each drag changes only existing vertices.
import { THREE } from '../lib/libs';
import { PointerTarget } from '../interface/pointer_target';

export const CAGE = {
	MIN_POINTS: 2, MAX_POINTS: 5,
	MIN_THICKNESS: 1, FLAT_PADDING: 0.02,
	POINT_PIXELS: 8, PICK_PIXELS: 10, EDGE_PICK_PIXELS: 5,
	COLOR: 0xffc45e, SELECTED_COLOR: 0x66d9ff, HOVER_COLOR: 0xffffff, FACE_OPACITY: 0.12,
	FINE_MOVE: 0.1, MOVE_EPSILON: 1e-8,
	BOX_DRAG_PIXELS: 3, SCALE_PIVOT_PIXELS: 8, SCALE_DRAG_PIXELS: 120,
	MIN_SCALE: 0.01, MAX_SCALE: 100,
};
let state = null, display = null, drag = null, marquee = null, hover = null, finishing = false;
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
	if (marquee) finishMarquee(false);
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
	state = {binding: {items, rest, counts, edges, faces, signature: signature(items), project: Project.uuid}, controls: clonePoints(rest), selected:new Set()};
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
	const highlighted = drag?.ids || hover?.ids || [];
	const color = new THREE.Color(CAGE.COLOR), selectedColor = new THREE.Color(CAGE.SELECTED_COLOR), white = new THREE.Color(CAGE.HOVER_COLOR);
	const colors = display.points.geometry.attributes.color;
	state.controls.forEach((p,i) => { const c = highlighted.includes(i) ? white : state.selected.has(i) ? selectedColor : color; colors.setXYZ(i,c.r,c.g,c.b); }); colors.needsUpdate = true;
	const face = highlighted.length == 4 && state.binding.faces.find(ids => ids.every(id => highlighted.includes(id)));
	display.highlight.visible = !!face;
	if (display.highlight.visible) {
		const buffer = display.highlight.geometry.attributes.position;
		face.forEach((id,i) => {const p=state.controls[id]; buffer.setXYZ(i,p.x,p.y,p.z);}); buffer.needsUpdate=true;
	}
}
function screenPoints(preview, points = state.controls) {
	const rect = preview.canvas.getBoundingClientRect();
	return points.map(p => {
		const q = p.clone().project(preview.camera);
		return new THREE.Vector3(rect.left+(q.x+1)*rect.width/2, rect.top+(1-q.y)*rect.height/2,q.z);
	});
}
function rayAt(preview, event) {
	const r = preview.canvas.getBoundingClientRect();
	const raycaster = new THREE.Raycaster();
	raycaster.setFromCamera(new THREE.Vector2((event.clientX-r.left)/r.width*2-1, 1-(event.clientY-r.top)/r.height*2), preview.camera);
	return raycaster;
}
function pick(preview, event) {
	if (!state || !display) return null;
	const mouse = new THREE.Vector3(event.clientX,event.clientY,0), screen = screenPoints(preview);
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

function selectPoints(ids) {
	if (!state) return;
	state.selected = new Set(ids.filter(id => state.controls[id]));
	updateDisplay();
}
function beginMarquee(preview, event, handle) {
	if (!state || drag || marquee || !PointerTarget.requestTarget(PointerTarget.types.gizmo_transform)) return false;
	const element = document.createElement('div'); element.className = 'selection_rectangle dew_cage_marquee';
	Object.assign(element.style,{position:'fixed',zIndex:'100',display:'none'});
	document.body.appendChild(element);
	marquee = {preview, element, before:[...state.selected], start:{clientX:event.clientX,clientY:event.clientY},
		mode:event.altKey ? 'subtract' : event.shiftKey ? 'add' : 'replace',
		handle:handle?.ids || [], moved:false, controls_enabled:preview.controls.enabled};
	preview.controls.stopMovement(); preview.controls.enabled = false;
	Preview.selected = preview; hover = null; updateDisplay();
	return true;
}
function marqueeSelection(ids) {
	const selected = new Set(marquee.mode == 'replace' ? [] : marquee.before);
	ids.forEach(id => marquee.mode == 'subtract' ? selected.delete(id) : selected.add(id));
	selectPoints([...selected]);
}
function moveMarquee(event) {
	const {preview,start,element} = marquee, rect = preview.canvas.getBoundingClientRect();
	if (!marquee.moved && Math.hypot(event.clientX-start.clientX,event.clientY-start.clientY) < CAGE.BOX_DRAG_PIXELS) return;
	marquee.moved = true;
	const x = Math.clamp(event.clientX,rect.left,rect.right), y = Math.clamp(event.clientY,rect.top,rect.bottom);
	const left = Math.min(start.clientX,x), top = Math.min(start.clientY,y), right = Math.max(start.clientX,x), bottom = Math.max(start.clientY,y);
	Object.assign(element.style,{display:'block',left:left+'px',top:top+'px',width:(right-left)+'px',height:(bottom-top)+'px'});
	// Include hidden/back points, so one rectangle can select both sides of a section.
	const ids = [];
	screenPoints(preview).forEach((p,i) => {if (p.z >= -1 && p.z <= 1 && p.x >= left && p.x <= right && p.y >= top && p.y <= bottom) ids.push(i);});
	marqueeSelection(ids);
	Blockbench.setCursorTooltip(state.selected.size+' cage points | Shift add | Alt subtract | Esc cancel');
}
function finishMarquee(keep = true) {
	if (!marquee) return;
	if (!keep) selectPoints(marquee.before);
	else if (!marquee.moved) marqueeSelection(marquee.handle);
	marquee.element.remove(); marquee.preview.controls.enabled = marquee.controls_enabled;
	marquee = null; PointerTarget.endTarget(PointerTarget.types.gizmo_transform);
	Blockbench.setCursorTooltip(); updateDisplay();
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
	if (!state || drag || marquee || !ids.length) return false;
	const operation = BarItems.dew_cage_mode.value == 'scale' ? 'scale' : 'move';
	if (operation == 'scale' && ids.length < 2) {
		Blockbench.showQuickMessage('Select at least two cage points to scale'); return false;
	}
	if (!PointerTarget.requestTarget(PointerTarget.types.gizmo_transform)) return false;
	selectPoints(ids);
	const origin = new THREE.Box3().setFromPoints(ids.map(id => state.controls[id])).getCenter(new THREE.Vector3());
	drag = {preview, ids:ids.slice(), before:clonePoints(state.controls), origin, operation,
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
function scaleBy(factor) {
	if (!drag || !state || !Number.isFinite(factor)) return;
	factor = Math.clamp(factor,CAGE.MIN_SCALE,CAGE.MAX_SCALE);
	state.controls = clonePoints(drag.before);
	for (const id of drag.ids) {
		for (const axis of ['x','y','z']) {
			if (drag.axis == 'view' || drag.axis == axis) state.controls[id][axis] = drag.origin[axis] + (drag.before[id][axis]-drag.origin[axis])*factor;
		}
	}
	if (!drag.started && !state.controls.some((p,i) => p.distanceToSquared(drag.before[i]) > CAGE.MOVE_EPSILON)) return;
	if (!drag.started) {Undo.initEdit({elements:state.binding.items.map(item => item.mesh)}); drag.started=true;}
	applyControls();
}
function pointerMove(event) {
	if (!drag) return;
	const {preview,origin,axis,start} = drag;
	if (drag.operation == 'scale') {
		const pivot = screenPoints(preview,[origin])[0], dx = start.clientX-pivot.x, dy = start.clientY-pivot.y;
		const radiusSquared = dx*dx+dy*dy;
		let amount = radiusSquared < CAGE.SCALE_PIVOT_PIXELS**2 ? (event.clientX-start.clientX)/CAGE.SCALE_DRAG_PIXELS :
			((event.clientX-start.clientX)*dx+(event.clientY-start.clientY)*dy)/radiusSquared;
		if (event.shiftKey) amount *= CAGE.FINE_MOVE;
		scaleBy(1+amount);
		Blockbench.setCursorTooltip('Scale cage: '+(axis == 'view' ? 'uniform' : axis.toUpperCase())+' | X/Y/Z constrain | Shift fine | Esc cancel');
		return;
	}
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
			const entry = Undo.finishEdit(previous.operation == 'scale' ? 'Scale cage' : 'Deform cage');
			if (entry) history.set(entry, {binding:state.binding, before:previous.before, after:clonePoints(state.controls), selected:[...state.selected]});
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
	if (marquee) finishMarquee(false);
	state = {binding:saved.binding, controls:clonePoints(saved[side]), selected:new Set(saved.selected)};
	resolution = state.binding.counts.slice();
	resolution.forEach((value,i) => BarItems['dew_cage_'+'xyz'[i]].set(String(value)));
	buildDisplay();
}
function clear() {
	if (drag) finish(false);
	if (marquee) finishMarquee(false);
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
	if (BarItems.dew_cage_mode.value == 'select' || !handle) beginMarquee(preview,event,handle);
	else {
		if (!handle.ids.every(id => state.selected.has(id))) selectPoints(handle.ids);
		begin(preview,event,[...state.selected]);
	}
}, true);
document.addEventListener('pointermove', event => {
	if (!active()) return;
	if (drag) {consume(event); pointerMove(event); return;}
	if (marquee) {consume(event); moveMarquee(event); return;}
	const preview = previewFor(event);
	const next = preview ? pick(preview,event) : null;
	if (JSON.stringify(next?.ids) != JSON.stringify(hover?.ids)) {hover=next;updateDisplay();}
	if (preview) preview.canvas.style.cursor = BarItems.dew_cage_mode.value == 'select' ? 'crosshair' : next ? 'grab' : 'default';
}, true);
document.addEventListener('pointerup', event => {
	if ((!drag && !marquee) || event.button != 0) return;
	consume(event);
	if (marquee) {moveMarquee(event);finishMarquee(true);}
	else finish(true);
}, true);
function cancelGesture() {finish(false);finishMarquee(false);}
document.addEventListener('pointercancel', cancelGesture, true);
document.addEventListener('mousemove', event => {if (drag || marquee) consume(event);}, true);
document.addEventListener('keydown', event => {
	if (!drag && !marquee) return;
	const key = event.key.toLowerCase();
	if (key == 'escape' || ((event.ctrlKey || event.metaKey) && key == 'z')) {consume(event);cancelGesture();}
	else if (drag && ['x','y','z'].includes(key) && !event.ctrlKey && !event.altKey) {
		consume(event); drag.axis = drag.axis == key ? 'view' : key;
		Blockbench.setCursorTooltip('Cage '+drag.operation+': ' + drag.axis.toUpperCase());
	} else if (!['shift','control','alt','meta'].includes(key)) consume(event);
}, true);
window.addEventListener('blur', cancelGesture);
Blockbench.on('update_selection', () => {
	if (active() && !drag && !marquee && !finishing && (!state || state.binding.signature != signature(selection()))) fit();
});
Blockbench.on('finished_edit', () => {if (active() && !drag && !marquee && !finishing) fit();});
Blockbench.on('undo', ({entry}) => restore(entry,'before'));
Blockbench.on('redo', ({entry}) => restore(entry,'after'));
Blockbench.on('unselect_project', clear);
Blockbench.on('select_project', () => {if (active()) fit();});

BARS.defineActions(function() {
	new BarSelect('dew_cage_mode', {
		name:'Cage mode', description:'Select: drag a box, Shift adds, Alt subtracts. Move or Scale: drag selected points together. Scaling uses the center of the selected points.',
		category:'tools', value:'move', options:{move:'Move',select:'Select',scale:'Scale'},
		onChange({value}) {
			cancelGesture();
			BarItems.dew_cage_axis.options.view = value == 'scale' ? 'Uniform' : 'View plane';
			BarItems.dew_cage_axis.set(BarItems.dew_cage_axis.value);
		},
	});
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
		name:'Cage axis', description:'Move in the view plane or scale uniformly, or constrain to a world axis. X/Y/Z also constrain while dragging.',
		category:'tools', value:'view', options:{view:'View plane',x:'X axis',y:'Y axis',z:'Z axis'},
	});
	new Action('dew_cage_refit', {
		name:'Refit Cage', description:'Fit a fresh cage around the current selection, keeping all mesh edits',
		icon:'fit_screen', category:'tools', condition:() => active(), click:fit,
	});
	new Tool('dew_cage', {
		name:'Deform Cage', description:'Fit a cage around selected mesh vertices. Select mode box-selects points; Move and Scale act on the selection. Shift for fine movement, X/Y/Z to constrain, Esc to cancel.',
		icon:'view_in_ar', category:'tools', transformerMode:'hidden', selectElements:false, toolbar:'dew_cage',
		modes:['edit'], condition:() => Modes.edit && Format.meshes && Mesh.selected.length > 0,
		onSelect() {if (!fit()) Blockbench.showQuickMessage('Select a mesh or mesh vertices to fit a cage');},
		onUnselect() {clear();Preview.all.forEach(p => p.canvas.style.cursor='');},
	});
});

Object.assign(window, {DEWCage:{CAGE,fit,setResolution,weightsAt,pick,selectPoints,begin,moveBy,scaleBy,finish,getState:()=>state,getDrag:()=>drag,getMarquee:()=>marquee}});
