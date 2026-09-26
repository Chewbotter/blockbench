import { Blockbench } from '../api';
import { THREE } from '../lib/libs';
import { Armature } from '../outliner/types/armature';
import { ArmatureBone } from '../outliner/types/armature_bone';
import { Preview, RaycastResult } from '../preview/preview';
import { symmetrizeArmature } from './mirror_modeling';

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
	vertex_visibility[vkey] = visible;
	return visible;
}
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
				
				if (event.shiftKey || Pressing.overrides.shift) {
					influence /= 8;
				}
				// the fraction of the way to go that this dab covers: a whole pass covers Strength times the influence
				let per_pass = Math.clamp(influence * strength_slider.get() / 100, 0, 1);
				let amount = 1 - Math.pow(1 - per_pass, pass_share);
				if (subtract) {
					value = value * (1-amount);
				} else {
					value = value + (limit-value) * amount;
				}

				// Set: the weight is handed over. The other bones give up the same share of theirs as this bone gained
				// of what it lacked, so the vertex's total stays put and its colour follows the painting smoothly (stock
				// took the raw influence off every other bone on every dab)
				if (blend_mode_select.value == 'set' && !subtract) {
					for (let bone of other_bones) {
						let other = bone.getVertexWeight(mesh, vkey);
						if (!other) continue;
						let lower_limit = Math.min(Math.max(0, 1-limit), other);
						bone.setVertexWeight(mesh, vkey, Math.max(other * (1 - amount), lower_limit));
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
		// fork: 150, not stock 50; on a low-poly mesh like the user's cat a 50 px brush lands on almost no vertex
		min: 1, max: 1024, interval: 1, default: 150,
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
		min: 0, max: 300, interval: 5, default: 0,
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
		min: 1, max: 100, interval: 1, default: 100, show_bar: true,
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
