// Custom transform orientation: a gizmo frame that stays put while you work down a limb that lies on no world axis
// (an A-pose arm). Stock Blockbench has Normal space, which takes its frame from the first selected face and so changes
// with every selection. Custom is the same machinery with a STORED frame: "Custom" in the Move / Scale space menu and in
// the Rotate tool's, set from the selection or from the bone that carries it.
//
// Everything that orients the gizmo or moves, scales and rotates mesh vertices in Normal space asks one function,
// Mesh.getSelectionRotation, so that is the one override. getEditTransformSpace (edit_transform.js) sends Custom down
// Normal's path, and the Rotate tool's mesh branch (transform.js) tilts its axis the same way: the two core touches.
// The frame is kept per project, in memory only: it is a working aid like the cage, not model data, and what gets
// saved is only where the vertices ended up.
import { THREE } from "../lib/libs";

export const ORIENT = {
	LINE_RATIO: 4,			// the selection counts as a line when its longest spread is this many times its second
	MESSAGE_TIME: 2500,
};

const frames = new WeakMap();	// ModelProject -> THREE.Quaternion, world space

export function getOrientation() { return Project ? frames.get(Project) || null : null; }
export function setOrientation(quaternion, source) {
	if (!Project) return;
	frames.set(Project, quaternion.clone().normalize());
	// Picking a frame is asking to work in it
	for (let id of ['transform_space', 'rotation_space']) {
		let select = BarItems[id];
		if (select && select.value != 'custom') { select.set('custom'); }
	}
	updateSelection();
	if (source) Blockbench.showQuickMessage('Custom orientation from ' + source, ORIENT.MESSAGE_TIME);
}
function spaceInUse() {
	let id = Toolbox.selected && Toolbox.selected.id == 'rotate_tool' ? 'rotation_space' : 'transform_space';
	return BarItems[id] && BarItems[id].value;
}

// A frame whose Y runs along `main`, the way an armature bone points, with Z kept as near the world's front as it
// can be so the other two arrows read the same from one limb to the next.
export function frameAlong(main) {
	let y = main.clone().normalize();
	let reference = Math.abs(y.z) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
	let x = new THREE.Vector3().crossVectors(y, reference).normalize();
	let z = new THREE.Vector3().crossVectors(x, y).normalize();
	return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

// The direction a selection implies. Two vertices, an edge or a chain of edges is a line: the line itself. A ring around
// a limb or a face is flat: what it faces, which for a ring is the limb's own direction. Found from how the selected
// points spread (covariance, power iteration on a 3 x 3), so no topology is needed.
export function directionOfSelection(mesh) {
	let keys = mesh.getSelectedVertices();
	if (keys.length < 2) return null;
	let points = keys.map(vkey => mesh.mesh.localToWorld(new THREE.Vector3().fromArray(mesh.vertices[vkey])));
	let centre = points.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(points.length);
	let c = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
	for (let p of points) { let d = [p.x - centre.x, p.y - centre.y, p.z - centre.z]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) c[i][j] += d[i] * d[j]; }
	let multiply = (m, v) => new THREE.Vector3(m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z, m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z, m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z);
	let dominant = (m, start) => { let v = start.clone().normalize(), value = 0; for (let i = 0; i < 60; i++) { let next = multiply(m, v); value = next.length(); if (value < 1e-12) break; v = next.divideScalar(value); } return {vector: v, value}; };
	let first = dominant(c, new THREE.Vector3(1, 0.7, 0.4));
	if (first.value < 1e-12) return null;
	// Take the first direction out and ask again for the second. The search has to start square to the first: on an
	// even ring the two spreads are equal, the first answer is the start vector's own shadow on the ring's plane, and
	// the same start then has nothing left in the second direction and reads the ring as a line. Two starts that span
	// everything square to the first cannot both miss.
	let deflated = c.map((row, i) => row.map((value, j) => value - first.value * first.vector.getComponent(i) * first.vector.getComponent(j)));
	let least = ['x', 'y', 'z'].reduce((a, b) => Math.abs(first.vector[a]) <= Math.abs(first.vector[b]) ? a : b);
	let side_a = new THREE.Vector3().crossVectors(first.vector, new THREE.Vector3().setComponent(['x', 'y', 'z'].indexOf(least), 1)), side_b = new THREE.Vector3().crossVectors(first.vector, side_a);
	let second = [dominant(deflated, side_a), dominant(deflated, side_b)].sort((a, b) => b.value - a.value)[0];
	let line = keys.length == 2 || second.value < 1e-12 || first.value / second.value > ORIENT.LINE_RATIO * ORIENT.LINE_RATIO;
	let direction = line ? first.vector : new THREE.Vector3().crossVectors(first.vector, second.vector).normalize();
	// Neither a line nor a ring says which way along it: point away from the body, so Y runs down a limb toward its end
	let all = Object.values(mesh.vertices), middle = all.reduce((sum, p) => sum.add(new THREE.Vector3().fromArray(p)), new THREE.Vector3()).divideScalar(all.length);
	if (direction.dot(centre.clone().sub(mesh.mesh.localToWorld(middle))) < 0) direction.negate();
	return {direction, kind: line ? (keys.length == 2 ? 'two vertices' : 'a line of vertices') : 'a ring or face'};
}

// The bone that carries most of the selection's weight, on a rigged mesh
export function boneOfSelection(mesh) {
	let armature = mesh.getArmature && mesh.getArmature();
	if (!armature) return null;
	let keys = mesh.getSelectedVertices();
	if (!keys.length) keys = Object.keys(mesh.vertices);
	let best = null, best_weight = 0;
	for (let bone of armature.getAllBones()) {
		let total = 0;
		for (let vkey of keys) total += bone.getVertexWeight(mesh, vkey) || 0;
		if (total > best_weight) { best_weight = total; best = bone; }
	}
	return best;
}

// The one override: Custom answers with the stored frame, expressed in the mesh's own space as Normal's is
const stockSelectionRotation = Mesh.prototype.getSelectionRotation;
Mesh.prototype.getSelectionRotation = function() {
	let frame = getOrientation();
	if (!frame || Transformer.dragging || spaceInUse() != 'custom') return stockSelectionRotation.call(this);
	let local = this.mesh.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(frame);
	return new THREE.Euler().setFromQuaternion(local);
};

BARS.defineActions(function() {
	new Action('dew_orient_from_selection', {
		name: 'Custom Orientation from Selection',
		description: 'Point the gizmo along the selection and keep it there: along two vertices, an edge or a line of vertices, or square to a ring or a face. Switches Move, Scale and Rotate to the Custom space',
		icon: 'explore',
		category: 'transform',
		condition: () => Modes.edit && Mesh.selected.length && Mesh.selected[0].getSelectedVertices().length >= 2,
		click() {
			let found = directionOfSelection(Mesh.selected[0]);
			if (!found) return Blockbench.showQuickMessage('Select at least two vertices that are apart', ORIENT.MESSAGE_TIME);
			setOrientation(frameAlong(found.direction), found.kind);
		}
	});
	new Action('dew_orient_from_bone', {
		name: 'Custom Orientation from Bone',
		description: 'Point the gizmo along the bone that carries most of the selected vertices, so a rigged limb is worked along its own length. Switches Move, Scale and Rotate to the Custom space',
		icon: 'accessibility',
		category: 'transform',
		condition: () => Modes.edit && Mesh.selected.length && !!(Mesh.selected[0].getArmature && Mesh.selected[0].getArmature()),
		click() {
			let bone = boneOfSelection(Mesh.selected[0]);
			if (!bone) return Blockbench.showQuickMessage('No bone carries these vertices', ORIENT.MESSAGE_TIME);
			scene.updateMatrixWorld(true);
			setOrientation(bone.scene_object.getWorldQuaternion(new THREE.Quaternion()), 'bone ' + bone.name);
		}
	});
});
// Custom with no frame stored would silently be Normal: say so once it is picked
Blockbench.on('update_selection', () => {
	if (spaceInUse() == 'custom' && !getOrientation() && Mesh.selected.length && !setOrientation.warned) {
		setOrientation.warned = true;
		Blockbench.showQuickMessage('No custom orientation yet: Transform > Custom Orientation from Selection or from Bone', ORIENT.MESSAGE_TIME);
	}
});

Object.assign(window, {DEWOrient: {ORIENT, getOrientation, setOrientation, frameAlong, directionOfSelection, boneOfSelection, stockSelectionRotation}});
