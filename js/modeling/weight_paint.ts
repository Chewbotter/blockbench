import { Blockbench } from '../api';
import { THREE } from '../lib/libs';
import { Armature } from '../outliner/types/armature';
import { ArmatureBone } from '../outliner/types/armature_bone';
import { Preview, RaycastResult } from '../preview/preview';
import { symmetrizeArmature } from './mirror_modeling';
import { otherSide } from "../dew/dew_mirror";

type CanvasClickData = RaycastResult

let brush_outline: HTMLElement;
function updateBrushOutline(event: PointerEvent | KeyboardEvent) {
	if (!brush_outline || Toolbox.selected.id != 'weight_brush') return;
	let preview = Preview.selected as Preview;
	preview.node.append(brush_outline);
	syncBrushOutline();
	brush_outline.style.display = (event.altKey || Pressing.overrides.alt) ? 'none' : 'block'

	if ('clientX' in event) {
		let preview_offset = $(preview.canvas).offset();
		let click_pos = [
			event.clientX - preview_offset.left,
			event.clientY - preview_offset.top,
		]
		brush_outline.style.left = click_pos[0] + 'px';
		brush_outline.style.top = click_pos[1] + 'px';
	}
}
Blockbench.on('update_pressed_modifier_keys', (arg) => {
	updateBrushOutline(arg.event);
});
document.addEventListener('touchend', () => {
	if (brush_outline && brush_outline.isConnected) {
		brush_outline.remove();
	}
})


let screen_space_vertex_positions: null | Record<string, {x:number, y:number}> = null;
// Fork: whether a vertex is hidden behind the mesh is asked only when the brush reaches it, then remembered until the
// camera moves. Stock ray-tested every vertex against every face at the start of each stroke after an orbit (330 ms on
// the cat's 1766 vertices), where a stroke only ever needs the few under the brush.
let vertex_visibility: Record<string, boolean> = {};
const raycaster = new THREE.Raycaster();
function updateScreenSpaceVertexPositions(mesh: Mesh) {
	if (screen_space_vertex_positions) return screen_space_vertex_positions;

	let vec = new THREE.Vector3();
	screen_space_vertex_positions = {};
	vertex_visibility = {};
	
	for (let vkey in mesh.vertices) {
		let pos = mesh.mesh.localToWorld(vec.fromArray(mesh.vertices[vkey]));
		let screen_pos = Preview.selected.vectorToScreenPosition(pos.clone());
		screen_space_vertex_positions[vkey] = screen_pos;
	}
	return screen_space_vertex_positions;
}
// Fork (2026-09-25): where the surface folds away from the camera (the back of the neck near the outline), the ray to a
// vertex skims its own neighbourhood and touches a face one ring out a hair before the vertex, so stock called the
// vertex hidden though it is on screen (about 100 of the cat's vertices per view). Such a vertex counts as visible when
// the face that blocked the ray touches its own ring AND at least one of its own faces is turned toward the camera. The
// back of a thin ear has every face turned away, so it stays hidden behind the front; anything further away still hides.
let neighbourhood: null | {geometry: any, slot_vkeys: string[], faces_of: Record<string, string[]>} = null;
function meshNeighbourhood(mesh: Mesh) {
	let geometry = mesh.mesh.geometry;
	if (neighbourhood && neighbourhood.geometry === geometry) return neighbourhood;
	let slot_vkeys: string[] = [], faces_of: Record<string, string[]> = {};
	for (let fkey in mesh.faces) {
		let face = mesh.faces[fkey];
		for (let vkey of face.vertices) (faces_of[vkey] = faces_of[vkey] || []).push(fkey);
		if (face.vertices.length == 3 || face.vertices.length == 4) slot_vkeys.push(...face.vertices);	// the stock build order
	}
	neighbourhood = {geometry, slot_vkeys, faces_of};
	return neighbourhood;
}
function isVertexVisible(mesh: Mesh, vkey: string): boolean {
	if (BarItems.weight_brush_xray.value) return true;
	if (vkey in vertex_visibility) return vertex_visibility[vkey];
	let pos = mesh.mesh.localToWorld(new THREE.Vector3().fromArray(mesh.vertices[vkey]));
	raycaster.ray.origin.setFromMatrixPosition(Preview.selected.camera.matrixWorld);
	raycaster.ray.direction.copy(pos).sub(raycaster.ray.origin);
	const z_distance = raycaster.ray.direction.length();
	raycaster.ray.direction.normalize();
	let intersection = raycaster.intersectObject(mesh.mesh, false)[0];
	let visible = !(intersection && intersection.distance < z_distance-0.001);
	if (!visible && intersection.face && WEIGHT_VISIBILITY.FOLD_VISIBLE) {
		let {slot_vkeys, faces_of} = meshNeighbourhood(mesh);
		let ring = new Set<string>();
		for (let fkey of faces_of[vkey] || []) for (let v of mesh.faces[fkey].vertices) ring.add(v);
		let hit_vkeys = [intersection.face.a, intersection.face.b, intersection.face.c].map(i => slot_vkeys[i]);
		if (hit_vkeys.some(v => ring.has(v))) {
			let camera_local = mesh.mesh.worldToLocal(raycaster.ray.origin.clone());
			let vertex = new THREE.Vector3().fromArray(mesh.vertices[vkey]);
			let to_camera = camera_local.sub(vertex);
			visible = (faces_of[vkey] || []).some(fkey => new THREE.Vector3().fromArray(mesh.faces[fkey].getNormal(true)).dot(to_camera) > 0);
		}
	}
	vertex_visibility[vkey] = visible;
	return visible;
}
// for tests: the visibility rule, and its stock form (FOLD_VISIBLE false) as a control
export const WEIGHT_VISIBILITY = {FOLD_VISIBLE: true};
// @ts-expect-error
window.DEWWeightVisibility = {WEIGHT_VISIBILITY, isVertexVisible: (mesh: Mesh, vkey: string) => isVertexVisible(mesh, vkey), reset: () => { vertex_visibility = {}; screen_space_vertex_positions = null; }};
Blockbench.on('update_camera_position', () => {
	screen_space_vertex_positions = null;
})

let previous_element: Mesh | undefined;
new Tool('weight_brush', {
	icon: 'stylus_highlighter',
	category: 'tools',
	cursor: 'crosshair',
	toolbar: 'weight_brush',
	transformerMode: 'hidden',
	selectElements: false,
	modes: ['edit'],
	condition: {modes: ['edit'], method: () => !!Armature.all.length},
	
	onCanvasClick(data) {
		let element = 'element' in data && data.element;
		if (element instanceof ArmatureBone) {
			return element.select(data.event);
		}
		if (data.event.altKey || Pressing.overrides.alt) return;
		let preview = Preview.selected as Preview;
		let preview_offset = $(preview.canvas).offset();
		let armature_bone = ArmatureBone.selected[0] as ArmatureBone | undefined;
		if (!armature_bone) {
			return Blockbench.showQuickMessage('Select an armature bone first!');
		}
		let armature = armature_bone.getArmature();
		let all_bones = armature.getAllBones() as ArmatureBone[];
		let other_bones = all_bones.slice();
		other_bones.remove(armature_bone);
		if (!element && previous_element instanceof Mesh && armature.children.includes(previous_element)) {
			element = previous_element;
		}
		if (element instanceof Mesh == false) {
			return;
		}
		if (!element.getArmature()) {
			return Blockbench.showQuickMessage('This mesh is not attached to an armature!');
		}
		if (element != previous_element) {
			screen_space_vertex_positions = null;
		}
		previous_element = element;

		let undo_tracked = all_bones;
		Undo.initEdit({elements: undo_tracked, mirror_modeling: false});

		if (data.element && data.event instanceof PointerEvent && data.event.pointerType == 'touch') {
			// Prevent rotate navigation on mobile
			let v = Preview.selected.controls.enableRotate;
			Preview.selected.controls.enableRotate = false;
			setTimeout(() => Preview.selected.controls.enableRotate = v, 50);
		}
		
		let last_click_pos = [0, 0];
		let stroke_dirty = false;
		let mirror_axis = ({x: 0, y: 1, z: 2})[mirror_select.value as string];
		let mirror_map = mirror_axis === undefined ? null : buildMirrorMap(element as Mesh, mirror_axis);
		let bone_twin = new Map(all_bones.map(bone => [bone, otherSide(bone, all_bones)]));
		let first_dab = true;
		const draw = (event: MouseEvent, data?: CanvasClickData|false) => {
			let radius = size_slider.get();
			let click_pos = [
				event.clientX - preview_offset.left,
				event.clientY - preview_offset.top,
			];
			let subtract = event.ctrlOrCmd || Pressing.overrides.ctrl;
			let moved = Math.sqrt(Math.pow(last_click_pos[0]-click_pos[0], 2) + Math.pow(last_click_pos[1]-click_pos[1], 2));
			if (moved * moved < 30) {
				return;
			}
			last_click_pos = click_pos;
			// Fork (2026-09-25): Strength is per PASS, not per dab. A drag lays a dab every ~5.5 px of travel, so a
			// vertex under the brush got about 2 * radius / 5.5 dabs (18 at radius 50) and any strength saturated in one
			// drag. Each dab now applies the share of a pass that the travel since the last dab makes, so one steady pass
			// through the brush centre puts exactly Strength on a vertex, whatever the speed; the first dab of a stroke
			// (a click) counts as one whole pass.
			let pass_share = first_dab ? 1 : Math.min(1, moved / (radius * WEIGHT_BRUSH.PASS_RADII));
			first_dab = false;

			let mesh = element;
			if (mesh instanceof Mesh == false) return;
			let vec = new THREE.Vector2();
			let limit = limit_slider.get() / 100;
			let base_radius = 0.2;
			let target_average_x = 0;
			let affected_vkeys = new Set<string>();
			let smooth = !!BarItems.weight_brush_smooth?.value;
			let smooth_dab: {vkey: string, amount: number, influence: number}[] = [];

			updateScreenSpaceVertexPositions(mesh);

			for (let vkey in mesh.vertices) {
				let screen_pos = screen_space_vertex_positions[vkey];
				if (!screen_pos) continue;
				let distance = vec.set(screen_pos.x - click_pos[0], screen_pos.y - click_pos[1]).length();
				let falloff = (1-(distance / radius)) * (1 + base_radius);
				let influence = Math.hermiteBlend(Math.clamp(falloff, 0, 1));
				// Fork: the Falloff halo reaches past the ring with a light touch, so a low-poly mesh gets a gradient
				// without the brush landing on each vertex; inside the ring the stronger of the two wins, so no seam
				let halo = halo_slider.get() / 100;
				if (halo > 0) {
					let reach = radius * (1 + halo);
					influence = Math.max(influence, WEIGHT_BRUSH.HALO_PEAK * Math.hermiteBlend(Math.clamp(1 - distance / reach, 0, 1)));
				}
				if (influence <= 0) continue;
				if (!isVertexVisible(mesh, vkey)) continue;
				let value = armature_bone.getVertexWeight(mesh, vkey) ?? 0;
				let set_mode = blend_mode_select.value == 'set';
				// Set works in SHARES, which is what the colour shows: the vertex's weights are taken as fractions of their
				// total. A vertex whose bones summed far under 1 (34 of the cat's, round the neck: v7b 0.19) turned red at
				// once when painted and hardly moved when erased, since 0.2 on a bone was already most of its total.
				// Deformation normalizes weights anyway, so the pose is unchanged; the painted vertex is left normalized.
				let others: [ArmatureBone, number][] = [];
				let total = value;
				if (set_mode) {
					for (let bone of other_bones) { let w = bone.getVertexWeight(mesh, vkey); if (w) { others.push([bone, w]); total += w; } }
					// alone on the vertex there is nothing to share with: it stays raw, or an erase would store MORE weight
					if (total > 0 && others.length) { value /= total; others = others.map(([bone, w]) => [bone, w / total]); }
				}
				
				if (event.shiftKey || Pressing.overrides.shift) {
					influence /= 8;
				}
				// the fraction of the way to go that this dab covers: a whole pass covers Strength times the influence
				let per_pass = Math.clamp(influence * strength_slider.get() / 100, 0, 1);
				let amount = 1 - Math.pow(1 - per_pass, pass_share);
				if (smooth) {	// Smooth: gathered here, averaged and applied after the loop
					smooth_dab.push({vkey, amount, influence});
					continue;
				}
				if (subtract) {
					value = value * (1-amount);
				} else {
					value = value + (limit-value) * amount;
				}

				// Set: the weight is handed over. Painting, the other bones give up the same share of theirs as this bone
				// gained of what it lacked; erasing, they take back what this bone gave up, in proportion; so the vertex
				// totals 1 and its colour follows the brush both ways (stock took the raw influence off every other bone
				// on every dab, and erasing gave nothing back)
				if (set_mode && others.length) {
					let others_total = others.reduce((t, [, w]) => t + w, 0);
					for (let [bone, other] of others) {
						let next;
						if (subtract) {
							next = others_total > 0 ? other * (1 - value) / others_total : other;
						} else {
							let lower_limit = Math.min(Math.max(0, 1-limit), other);
							next = Math.max(other * (1 - amount), lower_limit);
						}
						bone.setVertexWeight(mesh, vkey, next);
					}
				}

				// stock dropped anything under 0.04 on every dab, which wiped a light brush or the Falloff halo before it
				// could build up; the cleanup stays for subtracting, where it is meant
				if (subtract ? value < 0.04 : value < WEIGHT_BRUSH.MIN_WEIGHT) {
					armature_bone.setVertexWeight(mesh, vkey);
				} else {
					armature_bone.setVertexWeight(mesh, vkey, value);
				}
				target_average_x += mesh.vertices[vkey][0];
				affected_vkeys.add(vkey);
			}
			// Fork (2026-09-25): Smooth. The vertices under the brush are averaged, every bone at once and in shares (each
			// vertex's weights as fractions of its total), each vertex counting once (weighting by the brush let the centre
			// vertex dominate, so it hardly moved); each then moves toward that average by the dab's amount (Strength per
			// pass, the falloff) and ends normalized. An unweighted vertex does not pull the average toward nothing, but
			// takes the blend. The selected bone and Ctrl play no part.
			if (smooth_dab.length) {
				let shares = (vkey: string) => {
					let out = new Map<ArmatureBone, number>(), total = 0;
					for (let bone of all_bones) { let w = bone.getVertexWeight(mesh, vkey); if (w) { out.set(bone, w); total += w; } }
					if (total > 0) for (let [bone, w] of out) out.set(bone, w / total);
					return out;
				};
				let average = new Map<ArmatureBone, number>(), weight_sum = 0;
				let before = smooth_dab.map(entry => shares(entry.vkey));
				smooth_dab.forEach((entry, i) => {
					if (!before[i].size) return;
					weight_sum += 1;
					for (let [bone, w] of before[i]) average.set(bone, (average.get(bone) ?? 0) + w);
				});
				if (weight_sum > 0) {
					for (let [bone, w] of average) average.set(bone, w / weight_sum);
					smooth_dab.forEach((entry, i) => {
						let now = before[i], next = new Map<ArmatureBone, number>(), total = 0;
						for (let bone of all_bones) {
							let from = now.get(bone) ?? 0, to = average.get(bone) ?? 0;
							if (from == 0 && to == 0) continue;
							let w = from + (to - from) * entry.amount;
							next.set(bone, w); total += w;
						}
						// drop the specks first, then scale what is left to total exactly 1
						let kept = [...next].filter(([, w]) => total > 0 && w / total >= WEIGHT_BRUSH.MIN_WEIGHT);
						let kept_total = kept.reduce((t, [, w]) => t + w, 0);
						for (let [bone] of next) bone.setVertexWeight(mesh, entry.vkey);
						for (let [bone, w] of kept) bone.setVertexWeight(mesh, entry.vkey, w / kept_total);
						affected_vkeys.add(entry.vkey);
					});
				}
			}
			// Fork (2026-09-25): at most Armature.MAX_INFLUENCES (8) bones on a vertex, the most the export writes and Godot
			// keeps; the smallest go, and in Set or Smooth (shares) what is kept is scaled back to total 1. The bone being
			// painted on is never the one dropped, or a ninth bone could not be painted onto a vertex at all
			let keep_painted = !smooth && !subtract;
			for (let vkey of affected_vkeys) {
				let on = all_bones.filter(bone => bone.getVertexWeight(mesh, vkey));
				if (on.length <= Armature.MAX_INFLUENCES) continue;
				on.sort((a, b) => keep_painted && (a == armature_bone) != (b == armature_bone) ? (a == armature_bone ? -1 : 1) : b.getVertexWeight(mesh, vkey) - a.getVertexWeight(mesh, vkey));
				for (let bone of on.slice(Armature.MAX_INFLUENCES)) bone.setVertexWeight(mesh, vkey);
				if (smooth || blend_mode_select.value == 'set') {
					let kept = on.slice(0, Armature.MAX_INFLUENCES), total = kept.reduce((t, bone) => t + bone.getVertexWeight(mesh, vkey), 0);
					if (total > 0) for (let bone of kept) bone.setVertexWeight(mesh, vkey, bone.getVertexWeight(mesh, vkey) / total);
				}
			}
			if (mirror_map) {
				let painted = [...affected_vkeys];
				for (let vkey of painted) {
					let twin = mirror_map.get(vkey);
					if (!twin || affected_vkeys.has(twin)) continue;
					for (let bone of all_bones) bone.setVertexWeight(mesh, twin);	// replace, not add
					for (let bone of all_bones) {
						let weight = bone.getVertexWeight(mesh, vkey);
						if (weight) bone_twin.get(bone).setVertexWeight(mesh, twin, weight);
					}
					affected_vkeys.add(twin);
				}
			}
			if (BarItems.mirror_modeling.value) {
				let mesh2 = symmetrizeArmature(armature, mesh, affected_vkeys);
				if (mesh2) Mesh.preview_controller.updateGeometry(mesh2);
			}
			// Fork (js/dew/dew_weight_perf.js): during a stroke only the touched vertices' colours change, so they are
			// rewritten in place; the full rebuild and the selection update run once, when the stroke ends
			// @ts-expect-error
			if (typeof DEWWeightPerf != 'undefined' && DEWWeightPerf.WEIGHT_PERF.FAST_STROKE && DEWWeightPerf.recolorWeights(mesh, affected_vkeys)) {
				stroke_dirty = true;
			} else {
				Mesh.preview_controller.updateGeometry(mesh);
				updateSelection();
			}
		}
		const stop = (event: MouseEvent) => {
			document.removeEventListener('pointermove', draw);
			document.removeEventListener('pointerup', stop);
			// one selection update at the end: it rebuilds the meshes' geometry itself, weight colours included
			if (stroke_dirty) updateSelection();

			Undo.finishEdit('Paint vertex weights');
		}
		document.addEventListener('pointermove', draw);
		document.addEventListener('pointerup', stop);
		draw(data.event as MouseEvent, data);

	},
	onSelect() {
		Canvas.updateView({elements: [...Mesh.all, ...ArmatureBone.all], element_aspects: {faces: true}});
		Canvas.meshVertexMaterial.size = 5;
		size_slider.update();
		limit_slider.update();
		strength_slider.update();	// fork: a NumSlider writes its text only on change, so these showed blank
		halo_slider.update();
		Interface.addSuggestedModifierKey('ctrl', 'modifier_actions.subtract');
		Interface.addSuggestedModifierKey('shift', 'modifier_actions.reduced_intensity');
		Interface.addSuggestedModifierKey('alt', 'modifier_actions.select_bone');

		brush_outline = brush_outline ?? Interface.createElement('div', {id: 'weight_brush_outline'});
		syncBrushOutline();
		document.addEventListener('pointermove', updateBrushOutline);
	},
	onUnselect() {
		setTimeout(() => {
			Canvas.updateView({elements: [...Mesh.all, ...ArmatureBone.all], element_aspects: {faces: true}});
		}, 0);
		Canvas.meshVertexMaterial.size = 7;
		Interface.removeSuggestedModifierKey('ctrl', 'modifier_actions.subtract');
		Interface.removeSuggestedModifierKey('shift', 'modifier_actions.reduced_intensity');
		Interface.removeSuggestedModifierKey('alt', 'modifier_actions.select_bone');

		if (brush_outline) brush_outline.remove()
		document.removeEventListener('pointermove', updateBrushOutline);
	}
})
let size_slider = new NumSlider('slider_weight_brush_size', {
	condition: () => Toolbox?.selected?.id == 'weight_brush',
	tool_setting: 'weight_brush_size',
	category: 'edit',
	settings: {
		// fork: 80, not stock 50 (user; 150 was the first try); on a low-poly mesh like the cat 50 px lands on almost no vertex
		min: 1, max: 1024, interval: 1, default: 80,
	}
})
size_slider.on('change', (data: {number: number}) => {
	if (brush_outline) {
		brush_outline.style.setProperty('--radius', data.number.toString());
	}
})
let limit_slider = new NumSlider('slider_weight_brush_limit', {
	condition: () => Toolbox?.selected?.id == 'weight_brush',
	tool_setting: 'slider_weight_brush_limit',
	category: 'edit',
	
	settings: {
		min: 1, max: 100, interval: 1, default: 100, show_bar: true,
	}
})
// Fork (2026-09-25): how far each dab goes toward the limit. Stock is 100: a dab at the brush centre sets the full
// limit in one step (black straight to red), where a lower strength builds the weight up over several passes and the
// colours step through blue and green on the way. Scales the other bones' reduction too, since that uses the influence.
// Fork (2026-09-25): the brush's own mirror. After each dab every painted vertex's weights are copied, exactly and
// replacing whatever was there, to the vertex at its mirrored position across the chosen axis of the mesh (through its
// pivot, as Live Mirror), with left and right bones swapped by name; a vertex with no twin within the tolerance, or on
// the plane, is left alone, and a vertex painted by this dab is never overwritten by its twin's copy.
export const WEIGHT_MIRROR = {
	TOLERANCE: 0.01,	// units: how far a vertex may sit from the exact mirrored position and still be the twin
};
function buildMirrorMap(mesh: Mesh, axis: number): Map<string, string> {
	let cell = WEIGHT_MIRROR.TOLERANCE * 2, grid = new Map<string, string[]>();
	let key = (p: number[]) => p.map(v => Math.floor(v / cell)).join(',');
	for (let vkey in mesh.vertices) { let k = key(mesh.vertices[vkey]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(vkey); }
	let map = new Map<string, string>();
	for (let vkey in mesh.vertices) {
		let p = mesh.vertices[vkey].slice(); p[axis] = -p[axis];
		let base = p.map(v => Math.floor(v / cell)), best = null, best_d = WEIGHT_MIRROR.TOLERANCE;
		for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
			for (let other of grid.get([base[0] + dx, base[1] + dy, base[2] + dz].join(',')) || []) {
				let q = mesh.vertices[other], d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
				if (d <= best_d) { best_d = d; best = other; }
			}
		}
		if (best && best != vkey) map.set(vkey, best);
	}
	return map;
}
// Fork (2026-09-26, user): Mirror Weights, a one-shot copy of one whole side's weights onto the other, for weights that
// were never symmetrical (the cat's right hind leg had its own, forgotten because it looked like the left). Axis: the
// brush Mirror dropdown's, X while that is off. Each vertex off the plane on the source side gives its weights, exactly
// and replacing what was there, to its twin (buildMirrorMap), left and right bones swapped by name (otherSide). A vertex
// ON the plane takes, for every left / right pair of bones, the source side bone's weight on the other one as well, then
// is scaled back to the total it had, so the centre line bends evenly both ways. Centre bones stay as they are. A
// source vertex with no twin is left alone and counted. One undo entry.
function isLeftName(name: string) { return /\.L$|_L$|\.l$|_l$|Left|left/.test(name); }
// The bone of each left / right pair whose head lies on the source side, measured on the axis in world space
function sourceBones(bones: ArmatureBone[], axis: number, sign: number): Set<ArmatureBone> {
	let set = new Set<ArmatureBone>(), head = new THREE.Vector3(), other = new THREE.Vector3();
	for (let bone of bones) {
		let twin = otherSide(bone, bones);
		if (twin === bone || !bone.scene_object || !twin.scene_object) continue;
		bone.scene_object.getWorldPosition(head); twin.scene_object.getWorldPosition(other);
		let a = head.getComponent(axis) * sign, b = other.getComponent(axis) * sign;
		if (a > b || (a == b && isLeftName(bone.name))) set.add(bone);
	}
	return set;
}
/** Which named side (left or right) lies on the positive half of the axis, from the rig's paired bones; null if none. */
export function positiveSideName(bones: ArmatureBone[], axis: number): string | null {
	let source = [...sourceBones(bones, axis, 1)];
	if (!source.length) return null;
	return isLeftName(source[0].name) ? 'left' : 'right';
}
export function mirrorWeights(meshes: Mesh[], axis: number, sign: number) {
	let report = {copied: 0, centre: 0, unmatched: 0, meshes: 0};
	meshes = meshes.filter(mesh => mesh.getArmature());
	if (!meshes.length) return report;
	let armatures = [...new Set(meshes.map(mesh => mesh.getArmature()))];
	let tracked = armatures.flatMap(armature => armature.getAllBones() as ArmatureBone[]);
	Undo.initEdit({elements: tracked, mirror_modeling: false});
	for (let mesh of meshes) {
		let bones = mesh.getArmature().getAllBones() as ArmatureBone[];
		let twin_bone = new Map(bones.map(bone => [bone, otherSide(bone, bones)]));
		let source = sourceBones(bones, axis, sign);
		let map = buildMirrorMap(mesh, axis);
		for (let vkey in mesh.vertices) {
			let position = mesh.vertices[vkey][axis];
			if (Math.abs(position) <= WEIGHT_MIRROR.TOLERANCE) {
				let total_before = bones.reduce((t, bone) => t + bone.getVertexWeight(mesh, vkey), 0);
				let changed = false;
				for (let bone of source) {
					let twin = twin_bone.get(bone), w = bone.getVertexWeight(mesh, vkey);
					if (twin.getVertexWeight(mesh, vkey) != w) { twin.setVertexWeight(mesh, vkey, w); changed = true; }
				}
				if (!changed) continue;
				let total = bones.reduce((t, bone) => t + bone.getVertexWeight(mesh, vkey), 0);
				if (total > 0 && total_before > 0) for (let bone of bones) { let w = bone.getVertexWeight(mesh, vkey); if (w) bone.setVertexWeight(mesh, vkey, w * total_before / total); }
				report.centre++;
				continue;
			}
			if (Math.sign(position) != sign) continue;
			let twin = map.get(vkey);
			if (!twin) { report.unmatched++; continue; }
			for (let bone of bones) bone.setVertexWeight(mesh, twin);	// replace, not add
			for (let bone of bones) {
				let weight = bone.getVertexWeight(mesh, vkey);
				if (weight) twin_bone.get(bone).setVertexWeight(mesh, twin, weight);
			}
			report.copied++;
		}
		report.meshes++;
	}
	Undo.finishEdit('Mirror weights');
	Canvas.updateView({elements: meshes, element_aspects: {geometry: true}});
	return report;
}
// @ts-ignore
window.DEWMirrorWeights = {mirrorWeights, positiveSideName};
function mirrorWeightsTargets(): Mesh[] {
	let bone = ArmatureBone.selected[0] as ArmatureBone | undefined;
	let armature = bone && bone.getArmature();
	return Mesh.all.filter(mesh => mesh.getArmature() && (!armature || mesh.getArmature() === armature));
}
new Action('weight_brush_mirror_weights', {
	name: 'Mirror Weights',
	description: 'Copy one whole side\'s weights onto the other side, left and right bones swapped (axis: the brush Mirror setting, X while it is off)',
	icon: 'flip',
	category: 'edit',
	condition: () => Toolbox?.selected?.id == 'weight_brush',
	click(event) {
		let axis = ({x: 0, y: 1, z: 2})[mirror_select.value as string] ?? 0, letter = 'XYZ'[axis];
		let meshes = mirrorWeightsTargets();
		if (!meshes.length) return Blockbench.showQuickMessage('No mesh attached to an armature');
		let bones = meshes[0].getArmature().getAllBones() as ArmatureBone[];
		let positive = positiveSideName(bones, axis), negative = positive == 'left' ? 'right' : positive == 'right' ? 'left' : null;
		let run = (sign: number, from: string, to: string) => {
			let r = mirrorWeights(meshes, axis, sign);
			Blockbench.showQuickMessage(`Weights mirrored ${from} to ${to}: ${r.copied} vertices copied, ${r.centre} on the centre line evened` + (r.unmatched ? `, ${r.unmatched} without a mirror partner left alone` : ''), 3000);
		};
		let label = (sign: number) => {
			let from = sign > 0 ? positive : negative, to = sign > 0 ? negative : positive;
			let axes = sign > 0 ? `+${letter} onto -${letter}` : `-${letter} onto +${letter}`;
			return from ? `${from[0].toUpperCase() + from.slice(1)} onto ${to} (${axes})` : axes;
		};
		new Menu([
			{name: label(1), icon: 'arrow_forward', click: () => run(1, positive || `+${letter}`, negative || `-${letter}`)},
			{name: label(-1), icon: 'arrow_back', click: () => run(-1, negative || `-${letter}`, positive || `+${letter}`)},
		]).open(event as MouseEvent);
	}
});
// Fork (2026-09-25): Smooth, a toggle: the brush averages the weights under it instead of painting the selected bone
new Toggle('weight_brush_smooth', {
	name: 'Smooth Weights',
	description: 'The brush averages the weights of the vertices under it, all bones at once, instead of painting the selected bone',
	icon: 'blur_on',
	category: 'edit',
	condition: () => Toolbox?.selected?.id == 'weight_brush',
	default: false,
});
let mirror_select = new BarSelect('weight_brush_mirror', {
	category: 'edit',
	condition: () => Toolbox?.selected?.id == 'weight_brush',
	options: {
		off: 'Mirror Off',
		x: 'Mirror X',
		y: 'Mirror Y',
		z: 'Mirror Z',
	}
})
export const WEIGHT_BRUSH = {
	HALO_PEAK: 0.3,		// influence of the Falloff halo at the brush centre, easing to 0 at the halo's edge
	// Mouse travel, in brush radii, that makes one pass. Not 2 (the diameter): the influence is 1 only over the middle
	// sixth and eases to 0 at the ring, and averaged along a line through the centre it is worth 7/6 of a radius, so a
	// steady pass through the centre adds Strength (at low strengths; higher ones compound a little less)
	PASS_RADII: 7 / 6,
	MIN_WEIGHT: 0.0005,	// a painted weight below this is dropped (subtracting keeps stock's 0.04)
};
// Fork (2026-09-25): how far past the ring the brush reaches with a light touch, in percent of its radius. 0 is stock.
let halo_slider = new NumSlider('slider_weight_brush_falloff', {
	condition: () => Toolbox?.selected?.id == 'weight_brush',
	tool_setting: 'slider_weight_brush_falloff',
	category: 'edit',
	settings: {
		min: 0, max: 300, interval: 5, default: 20,	// user: 20
	}
})
function syncBrushOutline() {
	if (!brush_outline) return;
	brush_outline.style.setProperty('--radius', size_slider.get().toString());
	let halo = halo_slider.get() / 100;
	brush_outline.style.setProperty('--halo', halo.toString());
	brush_outline.classList.toggle('has_halo', halo > 0);
}
halo_slider.on('change', () => syncBrushOutline());
let strength_slider = new NumSlider('slider_weight_brush_strength', {
	condition: () => Toolbox?.selected?.id == 'weight_brush',
	tool_setting: 'slider_weight_brush_strength',
	category: 'edit',
	settings: {
		min: 1, max: 100, interval: 1, default: 20, show_bar: true,	// user: 20, so a pass builds up gently
	}
})
new Toggle('weight_brush_xray', {
	icon: 'disabled_visible',
	category: 'edit',
	condition: () => Toolbox?.selected?.id == 'weight_brush',
})
let blend_mode_select = new BarSelect('weight_brush_blend_mode', {
	category: 'edit',
	options: {
		set: 'action.weight_brush_blend_mode.set',
		add: 'action.weight_brush_blend_mode.add',
	}
})

const vertex_weight_view_modes = ['vertex_weight', 'weighted_bone_colors'];
function updateWeightPreview() {
	if (Toolbox.selected.id == 'weight_brush' || 
		vertex_weight_view_modes.includes(Project.view_mode)
	) {
		Canvas.updateView({
			elements: Mesh.all.filter(mesh => mesh.getArmature()),
			element_aspects: {geometry: true},
		});
		if (Modes.animate) Animator.preview();
	}
}
Blockbench.on('update_selection', updateWeightPreview);

declare global {
    interface BarItemRegistry {
		weight_brush: Tool
		slider_weight_brush_size: NumSlider
		slider_weight_brush_limit: NumSlider
		weight_brush_xray: Toggle
		weight_brush_blend_mode: BarSelect
    }
}
