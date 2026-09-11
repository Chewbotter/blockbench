// Distant Early Warning: project type for game clusters.
// The game's contract lives in D:/Work/DistantEarlyWarning/distantearly_game/BLOCKBENCH_HANDOFF.md
import { THREE } from "../lib/libs";

// Blockbench units, 1 unit = 1 texel
export const DEW = {
	HALF_CELL: 16,
	TILE: 32,
	STOREY: 64,
	CLUSTER_SIZE: 320,			// [proposed] 10 x 10 unit tiles, origin at the minimum corner
	STOREYS_SHOWN: 3,			// storey outlines drawn above the ground grid
	EXPORT_SCALE: 16,			// a 16-unit cube exports as 1.0, the game imports at 0.6 m per glTF unit
	GRID_Y: -0.05,				// ground grid sits just under y = 0 so floor tiles cover it
	THIN_LINE_OPACITY: 0.3,		// half-cell lines; full-tile lines are opaque
	STOREY_LINE_OPACITY: 0.35,
	CAMERA_OFFSET: [220, 260, 380],	// new scenes look at the cluster center from here
	BACKFACE_TINT: 0.85,		// how far back faces are pulled toward BACKFACE_COLOR in the viewport, 0 to 1
	BACKFACE_COLOR: '#2a3348',
};

function lineSegments(points, material) {
	let geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
	let lines = new THREE.LineSegments(geometry, material);
	lines.name = 'grid';
	return lines;
}

// Replaces the default grid in DEW scenes: half-cell lines, bold full-tile lines, storey outlines, axis edges
function buildDewGrid(parent) {
	const {HALF_CELL, TILE, STOREY, CLUSTER_SIZE: C, STOREYS_SHOWN, GRID_Y: y} = DEW;
	let color = new THREE.Color(CustomTheme.data.colors.grid);
	let thin = [], bold = [], storeys = [];
	for (let i = 0; i <= C; i += HALF_CELL) {
		let target = (i % TILE == 0) ? bold : thin;
		target.push(i, y, 0, i, y, C);
		target.push(0, y, i, C, y, i);
	}
	let top = STOREY * STOREYS_SHOWN;
	for (let s = 1; s <= STOREYS_SHOWN; s++) {
		let h = s * STOREY;
		storeys.push(0, h, 0, C, h, 0,  C, h, 0, C, h, C,  C, h, C, 0, h, C,  0, h, C, 0, h, 0);
	}
	for (let [x, z] of [[0, 0], [C, 0], [C, C], [0, C]]) {
		storeys.push(x, y, z, x, top, z);
	}
	parent.add(lineSegments(thin, new THREE.LineBasicMaterial({color, transparent: true, opacity: DEW.THIN_LINE_OPACITY})));
	parent.add(lineSegments(bold, new THREE.LineBasicMaterial({color})));
	parent.add(lineSegments(storeys, new THREE.LineBasicMaterial({color, transparent: true, opacity: DEW.STOREY_LINE_OPACITY})));

	// Cluster sides are named by axis, so the edges leaving the origin carry the axis colors
	let axis_y = y + 0.02;
	let x_color = typeof gizmo_colors != 'undefined' ? gizmo_colors.r : new THREE.Color(0xfd3043);
	let z_color = typeof gizmo_colors != 'undefined' ? gizmo_colors.b : new THREE.Color(0x2d5ee8);
	parent.add(lineSegments([0, axis_y, 0, C, axis_y, 0], new THREE.LineBasicMaterial({color: x_color})));
	parent.add(lineSegments([0, axis_y, 0, 0, axis_y, C], new THREE.LineBasicMaterial({color: z_color})));
}

export function frameCluster(preview = Preview.selected) {
	if (!preview || !preview.controls) return;
	let center = DEW.CLUSTER_SIZE / 2;
	preview.controls.target.set(center, 0, center);
	preview.camera.position.set(center + DEW.CAMERA_OFFSET[0], DEW.CAMERA_OFFSET[1], center + DEW.CAMERA_OFFSET[2]);
	if (preview.controls.update) preview.controls.update();
}

const dew_format = new ModelFormat('dew_scene', {
	name: 'DEW Scene',
	description: 'Distant Early Warning cluster: game grid, tile brush, glTF export at scale 16',
	icon: 'grid_on',
	category: 'general',
	target: ['Distant Early Warning'],
	meshes: true,
	billboards: true,
	armature_rig: true,
	splines: true,
	rotate_cubes: true,
	bone_rig: true,
	centered_grid: true,
	optional_box_uv: true,
	per_texture_uv_size: true,
	per_texture_wrap_mode: true,
	uv_rotation: true,
	animation_mode: true,
	per_animator_rotation_interpolation: true,
	animated_textures: true,
	locators: true,
	pbr: true,
	// Viewport only: the exporter never sees the shader tint
	onActivation() {
		Canvas.backfaceUniforms.BACKFACE_TINT.value = DEW.BACKFACE_TINT;
		Canvas.backfaceUniforms.BACKFACE_COLOR.value.set(DEW.BACKFACE_COLOR);
	},
	onDeactivation() {
		Canvas.backfaceUniforms.BACKFACE_TINT.value = 0;
	},
	onSetup(project, new_model) {
		if (!new_model) return;
		// Stored per project, so the global export scale used by other projects stays untouched
		project.export_options.gltf = {
			encoding: 'binary',
			scale: DEW.EXPORT_SCALE,
			embed_textures: true,
			armature: false,
			animations: false,
		};
		frameCluster();
	},
});
dew_format.buildGrid = buildDewGrid;

Object.assign(window, {DEW});
