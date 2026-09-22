// Animate mode picks bones, not meshes. A click meant for a bone nearly always landed on the mesh in front of it, which
// cannot be posed and only answers with a warning. So while animating, a press takes the bone NEAREST the pointer on
// screen, through whatever is in front of it (bones are drawn over everything anyway), and a near miss still takes it.
// The mesh is still there to be selected: click where no bone is near. Preview.raycast asks nearestBone first
// (js/preview/preview.ts), so hover highlighting follows the same rule as the click. One thing beats a bone there: a
// null object (an IK handle) on the ray, since it sits on the bone it drives and would otherwise never be clickable.
import { THREE } from "../lib/libs";

export const BONE_PICK = {
	RADIUS_PX: 26,			// a bone within this of the pointer, measured to the line from its head to its tip, is taken
	HEAD_BIAS_PX: 1,		// at a joint two bones tie (one's tip, the next one's head): the one that starts there wins
	ZERO_LENGTH_PX: 4,		// helper bones with no length sit on a real bone's head: they lose a tie to it
};

const head = new THREE.Vector3(), tip = new THREE.Vector3(), a = new THREE.Vector2(), b = new THREE.Vector2(), p = new THREE.Vector2();

export function nearestBone(preview, event) {
	if (!preview || !preview.canvas || typeof ArmatureBone == 'undefined' || !ArmatureBone.all.length) return null;
	let rect = preview.canvas.getBoundingClientRect();
	if (!rect.width || !rect.height || event.clientX === undefined) return null;
	p.set(event.clientX - rect.left, event.clientY - rect.top);
	let camera = preview.camera;
	let toScreen = (v, target) => { v.project(camera); return v.z > 1 ? null : target.set((v.x + 1) / 2 * rect.width, (1 - v.y) / 2 * rect.height); };
	let best = null, best_score = BONE_PICK.RADIUS_PX;
	for (let bone of ArmatureBone.all) {
		let object = bone.scene_object;
		if (!object || bone.visibility === false || bone.locked || !object.visible) continue;
		object.getWorldPosition(head);
		tip.set(0, bone.length || 0, 0); object.localToWorld(tip);
		if (!toScreen(head, a) || !toScreen(tip, b)) continue;	// behind the camera
		let span = b.clone().sub(a), length_sq = span.lengthSq();
		let t = length_sq > 1e-6 ? Math.clamp(p.clone().sub(a).dot(span) / length_sq, 0, 1) : 0;
		let distance = p.distanceTo(a.clone().addScaledVector(span, t));
		let score = distance + t * BONE_PICK.HEAD_BIAS_PX + (bone.length ? 0 : BONE_PICK.ZERO_LENGTH_PX);
		if (score < best_score) { best_score = score; best = bone; }
	}
	return best;
}

Object.assign(window, {DEWBonePick: {BONE_PICK, nearestBone}});
