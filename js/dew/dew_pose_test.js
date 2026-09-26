// Pose Test (2026-09-25, user): hold a key while weight painting to see the rig in a pose, release to go back. The
// weight brush toolbar gets a dropdown of the project's animations and the Pose Test button; holding O (checked free in
// the user's live keymap: P is the Pivot tool) shows the chosen animation's first keyframe, the frame Export Poses
// writes, with the weight colours still on the mesh; letting go puts the rest pose back. View only: nothing is keyed or
// saved, and the brush aims at rest positions, so the preview ends before any stroke (and on focus loss or tool change).
export const POSE_TEST = {
	KEY: 79,	// O
};

let active = false;
let saved_time = 0;
let posed_buffers = new Map();	// mesh -> the position buffer the pose was written into
let textured = new Map();		// mesh -> the textured material it wears while posed

// The weight brush gives every mesh the weight material whatever the view mode, and an unpainted mesh is black, so the
// posed shape could not be read (user). While posed each mesh wears what Textured view gives it: the stock material code
// (updateFaces) is asked with a tool other than the brush and Textured view, both put back within the same call.
function wearTextured(mesh) {
	let tool = Toolbox.selected, tool_id = tool.id, view_mode = Project.view_mode;
	try {
		tool.id = 'dew_pose_test_view';
		Project.view_mode = 'textured';
		Mesh.preview_controller.updateFaces(mesh);
	} finally {
		tool.id = tool_id;
		Project.view_mode = view_mode;
	}
	textured.set(mesh, mesh.mesh.material);
}

function animationChoices() {
	let options = {};
	for (let animation of Animation.all) options[animation.uuid] = animation.name;
	return options;
}
function refreshChoices() {
	let select = BarItems.dew_pose_test_animation;
	if (!select) return;
	select.options = animationChoices();
	let keys = Object.keys(select.options);
	if (!keys.length) return;
	if (!keys.includes(select.value)) select.set((Animation.selected && keys.includes(Animation.selected.uuid)) ? Animation.selected.uuid : keys[0]);
	else select.set(select.value);	// repaints the name
}
function chosenAnimation() {
	let uuid = BarItems.dew_pose_test_animation && BarItems.dew_pose_test_animation.value;
	return Animation.all.find(a => a.uuid == uuid) || Animation.selected || Animation.all[0] || null;
}
function firstKeyTime(animation) {
	let times = [];
	for (let id in animation.animators) {
		let animator = animation.animators[id];
		for (let channel of ['rotation', 'position', 'scale']) animator[channel]?.forEach(kf => times.push(kf.time));
	}
	return times.length ? Math.min(...times) : 0;
}
function setOverlays(visible) {
	for (let mesh of Mesh.all) if (mesh.mesh && mesh.mesh.vertex_points) mesh.mesh.vertex_points.visible = visible && Toolbox.selected.id == 'weight_brush';
	let outline = document.getElementById('weight_brush_outline');
	if (outline) outline.style.visibility = visible ? '' : 'hidden';
}

export function startPoseTest() {
	if (active) return true;	// key repeat while held
	if (!Mesh.all.some(mesh => mesh.getArmature && mesh.getArmature())) return false;
	let animation = chosenAnimation();
	if (!animation) { Blockbench.showQuickMessage('No animation to pose: make one in the Animate tab', 2000); return false; }
	active = true;
	saved_time = Timeline.time;
	posed_animation = animation;
	posed_time = firstKeyTime(animation);
	posePass();
	hookRender();
	Preview.all.forEach(preview => preview.render());
	return true;
}
let posed_animation = null, posed_time = 0;
let posed_bones = new Map();	// bone scene object -> [quaternion, position] as the pose left it
// The whole pose, from the rest: bones to rest, the animation applied at its first key, the meshes deformed. Measured
// equal to the Animate tab at that frame (0.000 on all three of the cat's animations).
function posePass() {
	Animator.showDefaultPose(true);
	Timeline.time = posed_time;
	Animator.stackAnimations([posed_animation], false);
	Animator.displayMeshDeformation();
	posed_buffers.clear();
	for (let mesh of Mesh.all) if (mesh.mesh) { posed_buffers.set(mesh, mesh.mesh.geometry.attributes.position); wearTextured(mesh); }
	posed_bones.clear();
	for (let bone of ArmatureBone.all) if (bone.scene_object) posed_bones.set(bone.scene_object, [bone.scene_object.quaternion.clone(), bone.scene_object.position.clone()]);
	setOverlays(false);
}
function poseDisturbed() {
	if (Mesh.all.some(mesh => mesh.mesh && posed_buffers.get(mesh) !== mesh.mesh.geometry.attributes.position)) return true;
	for (let [object, [q, p]] of posed_bones) if (!object.quaternion.equals(q) || !object.position.equals(p)) return true;
	return false;
}
// Anything that refreshes the view while the key is held (a deferred selection update, the rebuild at the end of a
// stroke) puts the bones back to rest and rebuilds the meshes at rest. The first version only re-deformed the meshes,
// against rest bones, which skinned them into garbage (99 units off on the cat's sitting_idle, user: "distorts the mesh
// incorrectly"). So before each frame, if a mesh was rebuilt or any bone moved off its posed transform, the whole pose is
// redone from the rest.
let hooked_scene = null;
function hookRender() {
	if (!Canvas.scene || hooked_scene === Canvas.scene) return;
	hooked_scene = Canvas.scene;
	let inner = Canvas.scene.onBeforeRender;
	Canvas.scene.onBeforeRender = function(...args) {
		if (active) {
			if (poseDisturbed()) posePass();
			else for (let mesh of Mesh.all) {
				if (mesh.mesh?.vertex_points?.visible) mesh.mesh.vertex_points.visible = false;
				if (mesh.mesh && textured.has(mesh) && mesh.mesh.material !== textured.get(mesh)) wearTextured(mesh);
			}
		}
		if (inner) return inner.apply(this, args);
	};
}
export function stopPoseTest() {
	if (!active) return false;
	active = false;
	posed_buffers.clear();
	posed_bones.clear();
	textured.clear();
	Timeline.time = saved_time;
	Animator.showDefaultPose(true);
	Canvas.updateView({elements: Mesh.all, element_aspects: {geometry: true, faces: true}});	// faces: the weight material back
	setOverlays(true);
	Preview.all.forEach(preview => preview.render());
	return true;
}
export function isPoseTestActive() { return active; }

BARS.defineActions(function() {
	new BarSelect('dew_pose_test_animation', {
		name: 'Pose Test Animation',
		description: 'The animation whose first frame Pose Test shows',
		category: 'edit',
		condition: () => Toolbox?.selected?.id == 'weight_brush',
		options: {},
	});
	new Action('dew_pose_test', {
		name: 'Pose Test (hold)',
		description: 'Hold to see the rig in the chosen animation\'s first frame, with the weights on it; let go for the rest pose',
		icon: 'accessibility_new',
		category: 'edit',
		keybind: new Keybind({key: POSE_TEST.KEY}),
		condition: () => Toolbox?.selected?.id == 'weight_brush',
		click() {
			// a click on the button (no key held) shows the pose until the next pointer press or key release
			startPoseTest();
		},
	});
	// the dropdown lists the project's animations whenever the weight brush is picked; leaving the brush ends a preview
	setTimeout(() => {
		let brush = BarItems.weight_brush;
		if (!brush) return;
		let on_select = brush.onSelect, on_unselect = brush.onUnselect;
		brush.onSelect = function(...args) { let r = on_select && on_select.apply(this, args); refreshChoices(); return r; };
		brush.onUnselect = function(...args) { stopPoseTest(); return on_unselect && on_unselect.apply(this, args); };
	}, 0);
});

// release of the key, focus loss, any press in the viewport, a tool or project change: back to rest
document.addEventListener('keyup', event => { if (active && event.which == (BarItems.dew_pose_test?.keybind?.key ?? POSE_TEST.KEY)) stopPoseTest(); });
window.addEventListener('blur', () => stopPoseTest());
document.addEventListener('pointerdown', () => stopPoseTest(), true);
Blockbench.on('select_project', () => { active = false; });
Blockbench.on('select_mode', () => stopPoseTest());
for (let event of ['add_animation', 'remove_animation', 'rename_animation', 'select_project', 'load_project']) Blockbench.on(event, () => refreshChoices());

Object.assign(window, {DEWPoseTest: {POSE_TEST, startPoseTest, stopPoseTest, isPoseTestActive, refreshChoices}});
