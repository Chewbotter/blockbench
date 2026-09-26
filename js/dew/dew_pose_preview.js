// Pose Preview (2026-09-25, user): a panel beside the weight brush showing the rig in a chosen animation's first frame,
// textured, updating as the weights change. It replaced the hold-O Pose Test, which posed the real meshes and so had to
// end before every stroke. Here nothing in the main scene is ever posed for longer than one synchronous capture:
// - the pose is captured once as a skin matrix per bone (the real bones posed, read, put back to rest in the same call),
//   again only when the animation, the project or an edit could have changed it;
// - each mesh has its own copy in the panel's scene: the real geometry cloned (uvs, index, material groups), wearing
//   the textured materials, positions written per vertex slot;
// - skinning is the fork cache's own (`gatherInfluences`: the biggest Armature.MAX_INFLUENCES bones, normalised) with
//   the captured matrices, so the panel shows exactly what the Animate tab shows; it runs at most once a frame, only
//   when a dab, an edit or an undo marked the weights changed.
// The panel has its own camera (drag to orbit, right or middle drag to pan, wheel to zoom, Frame to fit), its own
// renderer and its own render loop, which idles while the panel is hidden.
import { THREE } from '../lib/libs';
import { gatherInfluences } from './dew_perf';

export const POSE_PREVIEW = {
	FOV: 40,
	FRAME_MARGIN: 1.1,		// the posed model's longest side times this fills the view height on Frame
	ORBIT_SPEED: 0.01,		// radians per pixel
	ZOOM_STEP: 1.1,			// per wheel notch
	START_YAW: 0.6,			// the first view, radians round the model from the front
	START_PITCH: 0.35,
};

const state = {
	animation_uuid: null,
	frames: null,			// armature -> Map(bone -> skin matrix), from the last capture
	pose_dirty: true,		// capture again
	meshes_dirty: true,		// rebuild the copies
	weights_dirty: true,	// skin again
	view_dirty: true,		// render again
	copies: new Map(),		// Mesh -> {object, slots}
	skipped: new Set(),		// meshes whose geometry is not the stock layout, left out
	camera_set: false,
};
let renderer = null, scene3 = null, camera = null, canvas = null;
let orbit = {target: new THREE.Vector3(), yaw: POSE_PREVIEW.START_YAW, pitch: POSE_PREVIEW.START_PITCH, distance: 100};
let loop_running = false;
export const stats = {skins: 0, captures: 0, builds: 0, renders: 0};

// vertex key -> its slots in a geometry built by the stock mesh controller: faces in order, each face's corners in
// order, triangles and quads only
function slotMap(element) {
	let map = new Map(), slot = 0;
	for (let fkey in element.faces) {
		let face = element.faces[fkey];
		if (face.vertices.length != 3 && face.vertices.length != 4) continue;
		for (let vkey of face.vertices) {
			if (!map.has(vkey)) map.set(vkey, []);
			map.get(vkey).push(slot++);
		}
	}
	return {map, count: slot};
}

function chosenAnimation() {
	return Animation.all.find(a => a.uuid == state.animation_uuid) || null;
}
function firstKeyTime(animation) {
	let times = [];
	for (let id in animation.animators) {
		let animator = animation.animators[id];
		for (let channel of ['rotation', 'position', 'scale']) animator[channel]?.forEach(kf => times.push(kf.time));
	}
	return times.length ? Math.min(...times) : 0;
}

// The pose as a skin matrix per bone (armature space: world pose times inverse bind, as the stock skinning builds it).
// Without an animation the rest pose, which is the identity for every bone.
function capturePose() {
	state.frames = new Map();
	let animation = chosenAnimation();
	let saved_time = Timeline.time;
	try {
		if (animation) {
			Animator.showDefaultPose(true);
			Timeline.time = firstKeyTime(animation);
			Animator.stackAnimations([animation], false);
		}
		Canvas.scene.updateMatrixWorld(true);
		for (let armature of Armature.all) {
			if (!armature.scene_object) continue;
			let inverse = armature.scene_object.parent.matrixWorld.clone().invert();
			let skins = new Map();
			for (let bone of armature.getAllBones()) {
				if (!bone.scene_object || !bone.scene_object.inverse_bind_matrix) continue;
				skins.set(bone, new THREE.Matrix4().multiplyMatrices(inverse, bone.scene_object.matrixWorld).multiply(bone.scene_object.inverse_bind_matrix));
			}
			state.frames.set(armature, {inverse, skins});
		}
	} finally {
		if (animation) {
			Timeline.time = saved_time;
			Animator.showDefaultPose(true);
			Canvas.scene.updateMatrixWorld(true);
		}
	}
	stats.captures++;
	state.pose_dirty = false;
	state.weights_dirty = true;
}

// What Textured view gives the mesh, asked from the stock material code with the view mode and the tool id changed for
// the length of one synchronous call, then the real mesh put back as it was
function texturedMaterial(element) {
	let tool = Toolbox.selected, tool_id = tool && tool.id, view_mode = Project.view_mode;
	let material;
	try {
		if (tool) tool.id = 'dew_pose_preview_view';
		Project.view_mode = 'textured';
		Mesh.preview_controller.updateFaces(element);
		material = element.mesh.material;
	} finally {
		if (tool) tool.id = tool_id;
		Project.view_mode = view_mode;
	}
	let groups = element.mesh.geometry.groups.map(g => Object.assign({}, g));
	Mesh.preview_controller.updateFaces(element);
	return {material, groups};
}

function disposeCopies() {
	for (let [, copy] of state.copies) {
		scene3.remove(copy.object);
		copy.object.geometry.dispose();
	}
	state.copies.clear();
}
function buildCopies() {
	disposeCopies();
	state.skipped.clear();
	for (let element of Mesh.all) {
		if (!element.mesh || !element.visibility || !element.getArmature || !element.getArmature()) continue;
		let {material, groups} = texturedMaterial(element);
		let geometry = element.mesh.geometry.clone();
		for (let name of ['color', 'highlight']) if (geometry.attributes[name]) geometry.deleteAttribute(name);
		geometry.clearGroups();
		if (material instanceof Array) groups.forEach(g => geometry.addGroup(g.start, g.count, g.materialIndex));
		let {map, count} = slotMap(element);
		if (count != geometry.attributes.position.count) { geometry.dispose(); state.skipped.add(element); continue; }	// not the stock layout
		let object = new THREE.Mesh(geometry, material);
		object.frustumCulled = false;
		scene3.add(object);
		state.copies.set(element, {object, slots: map});
	}
	stats.builds++;
	state.meshes_dirty = false;
	state.weights_dirty = true;
}

const _base = new THREE.Vector3(), _moved = new THREE.Vector3(), _target = new THREE.Vector3();
function skin() {
	for (let [element, copy] of state.copies) {
		let armature = element.getArmature();
		let frame = state.frames && state.frames.get(armature);
		let position = copy.object.geometry.attributes.position;
		let array = position.array;
		element.mesh.updateMatrixWorld(true);
		let inverse = frame ? frame.inverse : armature.scene_object.parent.matrixWorld.clone().invert();
		let bind = inverse.clone().multiply(element.mesh.matrixWorld);
		let bind_inverse = bind.clone().invert();
		let {influences} = gatherInfluences(armature, element);
		for (let [vkey, slots] of copy.slots) {
			let vertex = element.vertices[vkey];
			if (!vertex) continue;
			_target.fromArray(vertex);
			let list = frame && influences.get(vkey);
			if (list && list.length) {
				let total = 0;
				for (let [, w] of list) total += w;
				if (total > 0) {
					_base.fromArray(vertex).applyMatrix4(bind);
					_target.set(0, 0, 0);
					for (let [bone, w] of list) {
						let matrix = frame.skins.get(bone);
						if (!matrix) continue;
						_target.addScaledVector(_moved.copy(_base).applyMatrix4(matrix), w / total);
					}
					_target.applyMatrix4(bind_inverse);
				}
			}
			for (let s of slots) { array[s * 3] = _target.x; array[s * 3 + 1] = _target.y; array[s * 3 + 2] = _target.z; }
		}
		position.needsUpdate = true;
		copy.object.geometry.computeVertexNormals();
		copy.object.geometry.computeBoundingBox();
		copy.object.geometry.computeBoundingSphere();
		// the copy sits where the real mesh sits in the world
		copy.object.matrixAutoUpdate = false;
		copy.object.matrix.copy(element.mesh.matrixWorld);
		copy.object.matrixWorldNeedsUpdate = true;
	}
	stats.skins++;
	state.weights_dirty = false;
	state.view_dirty = true;
}

// a mesh added, removed, hidden or shown, or its face layout changed: the copies are rebuilt
function topologyChanged() {
	let count = 0;
	for (let element of Mesh.all) {
		if (!element.mesh || !element.visibility || !element.getArmature || !element.getArmature()) continue;
		let copy = state.copies.get(element);
		if (!copy && !state.skipped.has(element)) return true;
		if (copy && copy.object.geometry.attributes.position.count != element.mesh.geometry.attributes.position.count) return true;
		count++;
	}
	return count != state.copies.size + state.skipped.size;
}
function posedBounds() {
	let box = new THREE.Box3();
	for (let [, copy] of state.copies) { copy.object.updateMatrixWorld(true); box.expandByObject(copy.object); }
	return box;
}
export function frameView() {
	let box = posedBounds();
	if (box.isEmpty()) return;
	// half the box's longest side, not its bounding sphere, which leaves a tall narrow pose (a sitting cat) small
	let size = box.getSize(new THREE.Vector3()), reach = Math.max(size.x, size.y, size.z, 1) / 2;
	box.getCenter(orbit.target);
	orbit.distance = reach * POSE_PREVIEW.FRAME_MARGIN / Math.tan(THREE.MathUtils.degToRad(POSE_PREVIEW.FOV / 2)) + reach;
	state.camera_set = true;
	state.view_dirty = true;
}
function placeCamera() {
	let c = Math.cos(orbit.pitch);
	camera.position.set(orbit.target.x + orbit.distance * c * Math.sin(orbit.yaw), orbit.target.y + orbit.distance * Math.sin(orbit.pitch), orbit.target.z + orbit.distance * c * Math.cos(orbit.yaw));
	camera.near = Math.max(orbit.distance / 1000, 0.01);
	camera.far = orbit.distance * 100;
	camera.lookAt(orbit.target);
	camera.updateProjectionMatrix();
}

function ensureRenderer(host) {
	if (!renderer) {
		canvas = document.createElement('canvas');
		canvas.id = 'dew_pose_preview_canvas';
		canvas.style.cssText = 'width: 100%; height: 100%; display: block; cursor: grab; touch-action: none;';
		renderer = new THREE.WebGLRenderer({canvas, alpha: true, antialias: true});
		renderer.setPixelRatio(window.devicePixelRatio || 1);
		scene3 = new THREE.Scene();
		camera = new THREE.PerspectiveCamera(POSE_PREVIEW.FOV, 1, 0.1, 10000);
		addControls(canvas);
	}
	if (host && canvas.parentNode !== host) {
		host.appendChild(canvas);
		// unfolding, resizing or moving the panel gives the canvas a size again: draw
		new ResizeObserver(() => { state.view_dirty = true; startLoop(); }).observe(host);
	}
}
function addControls(canvas) {
	let drag = null;
	canvas.addEventListener('pointerdown', event => {
		drag = {x: event.clientX, y: event.clientY, pan: event.button == 1 || event.button == 2};
		canvas.setPointerCapture(event.pointerId);
		canvas.style.cursor = 'grabbing';
		event.preventDefault();
		event.stopPropagation();
	});
	canvas.addEventListener('pointermove', event => {
		if (!drag) return;
		let dx = event.clientX - drag.x, dy = event.clientY - drag.y;
		drag.x = event.clientX; drag.y = event.clientY;
		if (drag.pan) {
			let scale = 2 * orbit.distance * Math.tan(THREE.MathUtils.degToRad(POSE_PREVIEW.FOV / 2)) / Math.max(canvas.clientHeight, 1);
			let right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
			orbit.target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
		} else {
			orbit.yaw -= dx * POSE_PREVIEW.ORBIT_SPEED;
			orbit.pitch = Math.clamp(orbit.pitch + dy * POSE_PREVIEW.ORBIT_SPEED, -1.55, 1.55);
		}
		state.view_dirty = true;
	});
	let end = event => { if (!drag) return; drag = null; canvas.style.cursor = 'grab'; try { canvas.releasePointerCapture(event.pointerId); } catch (e) {} };
	canvas.addEventListener('pointerup', end);
	canvas.addEventListener('pointercancel', end);
	canvas.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); });
	canvas.addEventListener('wheel', event => {
		orbit.distance *= event.deltaY > 0 ? POSE_PREVIEW.ZOOM_STEP : 1 / POSE_PREVIEW.ZOOM_STEP;
		state.view_dirty = true;
		event.preventDefault();
		event.stopPropagation();
	}, {passive: false});
}

function panelShown() {
	return !!(canvas && canvas.isConnected && canvas.clientWidth > 0 && canvas.clientHeight > 0 && Project && isPreviewOn());
}
function isPreviewOn() {
	return !!(BarItems.dew_pose_preview && BarItems.dew_pose_preview.value && Toolbox.selected && Toolbox.selected.id == 'weight_brush');
}

/** One step of the panel: whatever is dirty is redone, then a render if anything changed. Returns true when it drew. */
export function update() {
	if (!panelShown()) return false;
	if (!state.meshes_dirty && topologyChanged()) state.meshes_dirty = true;
	if (state.meshes_dirty) buildCopies();
	if (state.pose_dirty) capturePose();
	if (state.weights_dirty) skin();
	if (!state.camera_set) frameView();
	let width = canvas.clientWidth, height = canvas.clientHeight;
	let size = renderer.getSize(new THREE.Vector2());
	if (size.x != width || size.y != height) { renderer.setSize(width, height, false); state.view_dirty = true; }
	if (!state.view_dirty) return false;
	camera.aspect = width / height;
	placeCamera();
	renderer.render(scene3, camera);
	stats.renders++;
	state.view_dirty = false;
	return true;
}
function loop() {
	if (!panelShown()) { loop_running = false; return; }
	try { update(); } catch (err) { console.error(err); }
	requestAnimationFrame(loop);
}
function startLoop() {
	if (loop_running) return;
	loop_running = true;
	requestAnimationFrame(loop);
}

export function markWeights() { state.weights_dirty = true; }
export function markAll() { state.pose_dirty = true; state.meshes_dirty = true; state.weights_dirty = true; state.view_dirty = true; }
export function setAnimation(uuid) {
	state.animation_uuid = uuid;
	state.pose_dirty = true;
	if (panel_vue) panel_vue.selected = uuid;
}

let panel_vue = null;
function refreshChoices() {
	let list = Animation.all.map(a => ({uuid: a.uuid, name: a.name}));
	if (!list.some(a => a.uuid == state.animation_uuid)) setAnimation((Animation.selected && Animation.selected.uuid) || (list[0] && list[0].uuid) || null);
	if (panel_vue) { panel_vue.animations = list; panel_vue.selected = state.animation_uuid; }
}

BARS.defineActions(function() {
	new Toggle('dew_pose_preview', {
		name: 'Pose Preview',
		description: 'Show a panel with the rig in the chosen animation\'s first frame, updating as the weights change',
		icon: 'accessibility_new',
		category: 'view',
		default: false,
		condition: () => Toolbox?.selected?.id == 'weight_brush',
		onChange(value) {
			if (value) ensurePanel();
			updateInterfacePanels();
			if (value) { markAll(); refreshChoices(); setTimeout(startLoop, 0); }
		},
	});
	// a picked brush with the toggle on brings the panel back with a fresh pose
	setTimeout(() => {
		let brush = BarItems.weight_brush;
		if (!brush) return;
		let on_select = brush.onSelect;
		brush.onSelect = function(...args) {
			let r = on_select && on_select.apply(this, args);
			if (BarItems.dew_pose_preview && BarItems.dew_pose_preview.value) { ensurePanel(); markAll(); refreshChoices(); setTimeout(startLoop, 0); }
			return r;
		};
	}, 0);
});

// Made on first use: a floating panel cannot be made while the bundle loads, before the interface exists (it broke
// the boot)
let panel = null;
function ensurePanel() {
	if (panel) return panel;
	panel = new Panel('dew_pose_preview', {
	name: 'Pose Preview',
	icon: 'accessibility_new',
	condition: () => isPreviewOn(),
	default_position: {slot: 'float', float_position: [8, 48], float_size: [340, 400], height: 400},
	resizable: true,
	growable: true,
	component: {
		data() { return {animations: [], selected: null}; },
		methods: {
			choose(event) { setAnimation(event.target.value); startLoop(); },
			frame() { frameView(); startLoop(); },
		},
		mounted() {
			panel_vue = this;
			ensureRenderer(this.$refs.host);
			refreshChoices();
			startLoop();
		},
		template: `
			<div style="display: flex; flex-direction: column; height: 100%; padding: 4px; gap: 4px; box-sizing: border-box;">
				<div style="display: flex; gap: 4px; align-items: center;">
					<select @change="choose" :value="selected" style="flex: 1; min-width: 0;" title="The animation whose first frame is shown">
						<option v-if="!animations.length" :value="null">No animation: rest pose</option>
						<option v-for="animation in animations" :key="animation.uuid" :value="animation.uuid">{{ animation.name }}</option>
					</select>
					<button @click="frame" title="Fit the posed model in view">Frame</button>
				</div>
				<div ref="host" style="flex: 1; min-height: 120px; position: relative; background: var(--color-back); border-radius: 4px; overflow: hidden;"></div>
			</div>`,
	},
	});
	updateInterfacePanels();
	return panel;
}


// every dab of the brush rewrites colours through DEWWeightPerf.recolorWeights: the weights changed
setTimeout(() => {
	let perf = window.DEWWeightPerf;
	if (!perf || perf.recolorWeights.pose_preview_wrapped) return;
	let recolor = perf.recolorWeights;
	perf.recolorWeights = function(...args) { state.weights_dirty = true; return recolor.apply(this, args); };
	perf.recolorWeights.pose_preview_wrapped = true;
}, 0);
Blockbench.on('finished_edit', () => { state.weights_dirty = true; state.pose_dirty = true; });
for (let event of ['undo', 'redo', 'load_project']) Blockbench.on(event, () => markAll());
Blockbench.on('select_project', () => { markAll(); state.camera_set = false; refreshChoices(); });
for (let event of ['add_animation', 'remove_animation', 'rename_animation']) Blockbench.on(event, () => refreshChoices());

Object.assign(window, {DEWPosePreview: {POSE_PREVIEW, update, frameView, setAnimation, markAll, markWeights, stats, state, orbit,
	get renderer() { return renderer; }, get camera() { return camera; }, get canvas() { return canvas; }}});
