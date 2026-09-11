import { THREE } from '../lib/libs';
// getSelectionCenter is used through its global: importing the transform module here would
// reorder bundle evaluation and break the canvas setup.

/**
 * Orbit around selection. Whenever the selection changes, the orbit pivot of every perspective
 * preview slides along its line of sight to the depth of the selection centre. Nothing on screen
 * moves, but the next orbit revolves around what is selected instead of the old pivot.
 */

// The pivot never comes closer to the camera than this (selection behind or at the camera is ignored)
const MIN_PIVOT_DISTANCE = 1;

function updateOrbitPivots() {
	if (!settings.orbit_around_selection.value) return;
	if (Modes.display) return;
	if (!Outliner.selected.length && !Group.first_selected) return;

	let center = new THREE.Vector3().fromArray(getSelectionCenter()).add(scene.position);
	for (let preview of Preview.all) {
		if (preview.isOrtho || !preview.controls?.enabled) continue;
		let camera = preview.camera;
		let direction = camera.getWorldDirection(new THREE.Vector3());
		let depth = center.clone().sub(camera.position).dot(direction);
		if (depth < MIN_PIVOT_DISTANCE) continue;
		preview.controls.target.copy(camera.position).addScaledVector(direction, depth);
	}
}

Blockbench.on('update_selection', updateOrbitPivots);
