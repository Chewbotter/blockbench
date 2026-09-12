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
	FIGURE_NAME: 'scale_figure',
	FIGURE_SIZE: [32, 48, 32],		// a soldier: 2 x 2 half cells on the ground, 3 half cells tall
	FIGURE_POSITION: [-48, 0, 0],	// parked outside the cluster so it never sits in the way
	FIGURE_COLOR: 4,				// marker color index
};

let previous_edit_size = null;	// the user's move snap, restored when another format takes over

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

// A body-sized block for checking doors, windows and headroom by eye. It is a normal element, so it moves and
// snaps with the usual tools, but it is marked as not exported: the glTF exporter skips it and the tile tools
// ignore it, so it can stand in a doorway without getting in the way.
export function createScaleFigure() {
	let [x, y, z] = DEW.FIGURE_POSITION;
	let [width, height, depth] = DEW.FIGURE_SIZE;
	let figure = new Cube({
		name: DEW.FIGURE_NAME,
		from: [x, y, z],
		to: [x + width, y + height, z + depth],
		origin: [x, y, z],
		autouv: 0,
		color: DEW.FIGURE_COLOR,
	}).init();
	figure.export = false;
	return figure;
}

export function frameCluster(preview = Preview.selected) {
	if (!preview || !preview.controls) return;
	let center = DEW.CLUSTER_SIZE / 2;
	preview.controls.target.set(center, 0, center);
	preview.camera.position.set(center + DEW.CAMERA_OFFSET[0], DEW.CAMERA_OFFSET[1], center + DEW.CAMERA_OFFSET[2]);
	if (preview.controls.update) preview.controls.update();
}

let hide_back_faces = true;

new ModelFormat('dew_scene', {
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
	buildGrid: buildDewGrid,	// Canvas.buildGrid uses this instead of the default grid
	// Tiles are drawn only from the side they face, so a click, the gizmo and the tile tools all reach through
	// a wall seen from behind. The raycaster honours material.side, so hidden also means unselectable.
	render_sides: () => hide_back_faces ? 'front' : 'double',
	export_render_sides: 'double',	// the glb stays double-sided: the handoff calls that correct
	// Viewport only: the exporter never sees the shader tint
	onActivation() {
		// The toggle keeps its value across sessions, the flag does not
		if (BarItems.dew_hide_back_faces) hide_back_faces = BarItems.dew_hide_back_faces.value;
		Canvas.backfaceUniforms.BACKFACE_TINT.value = DEW.BACKFACE_TINT;
		Canvas.backfaceUniforms.BACKFACE_COLOR.value.set(DEW.BACKFACE_COLOR);
		// Moves and nudges step by a half cell here: canvasGridSize is 16 / edit_size
		if (previous_edit_size === null) previous_edit_size = settings.edit_size.value;
		settings.edit_size.value = 16 / DEW.HALF_CELL;
	},
	onDeactivation() {
		Canvas.backfaceUniforms.BACKFACE_TINT.value = 0;
		if (previous_edit_size !== null) {
			settings.edit_size.value = previous_edit_size;
			previous_edit_size = null;
		}
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
		createScaleFigure();
	},
});

BARS.defineActions(function() {
	new Toggle('dew_scale_figure', {
		name: 'Scale Figure',
		description: 'Show a soldier-sized block (2 x 2 half cells, 3 tall) for checking doors and headroom. Never exported',
		icon: 'accessibility_new',
		category: 'view',
		default: true,
		condition: () => Format.id == 'dew_scene',
		onChange(value) {
			let figures = Cube.all.filter(cube => cube.name == DEW.FIGURE_NAME);
			if (!figures.length && value) {
				Undo.initEdit({outliner: true, elements: [], selection: true});
				figures = [createScaleFigure()];
				Undo.finishEdit('Add scale figure', {outliner: true, elements: figures, selection: true});
			}
			figures.forEach(figure => figure.visibility = value);
			if (Canvas.updateVisibility) Canvas.updateVisibility();
			updateSelection();
		}
	});

	new Toggle('dew_hide_back_faces', {
		name: 'Hide Back Faces',
		description: 'Draw a tile only from the side it faces, so clicks and the gizmo reach through a wall seen from behind. The export stays double-sided',
		icon: 'flip_to_front',
		category: 'view',
		default: true,
		condition: () => Format.id == 'dew_scene',
		onChange(value) {
			hide_back_faces = value;
			Canvas.updateRenderSides();
		}
	});
});

Object.assign(window, {DEW});
