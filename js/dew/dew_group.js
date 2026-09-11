// Grouping for DEW scenes: the selected tiles become their own element, so a building can be selected once and
// then duplicated, moved, rotated or deleted as a unit with the stock tools. Two constraints keep the result
// readable by the tile tools: moves snap to the half cell (the format sets the edit size while a DEW scene is
// open) and rotation is 90 degrees in place, so tiles stay axis aligned and on the grid.
import { THREE } from "../lib/libs";
import { DEW } from "./dew_scene";
import { describeTile } from "./tile_brush";

const GROUP = {
	NAME: 'group',
};

const round3 = v => Math.round(v * 1000) / 1000;

function worldVertex(mesh, vkey) {
	return mesh.mesh.localToWorld(new THREE.Vector3().fromArray(mesh.vertices[vkey]));
}
function removeLooseVertices(mesh) {
	let used = new Set();
	for (let fkey in mesh.faces) mesh.faces[fkey].vertices.forEach(vkey => used.add(vkey));
	for (let vkey in mesh.vertices) {
		if (!used.has(vkey)) delete mesh.vertices[vkey];
	}
}
function selectedFaces() {
	let sources = [];
	for (let mesh of Mesh.all) {
		let fkeys = mesh.getSelectedFaces();
		if (fkeys && fkeys.length) sources.push({mesh, fkeys: fkeys.slice()});
	}
	return sources;
}

// Moves the selected faces of every mesh into one new element, keeping their textures and UVs
function groupTiles() {
	let sources = selectedFaces();
	if (!sources.length) return;
	let meshes = sources.map(source => source.mesh);
	Undo.initEdit({elements: meshes, outliner: true, selection: true});

	let group = new Mesh({name: GROUP.NAME, vertices: {}});
	let by_position = new Map();
	for (let {mesh, fkeys} of sources) {
		mesh.mesh.updateMatrixWorld(true);
		for (let fkey of fkeys) {
			let face = mesh.faces[fkey];
			if (!face) continue;
			// Vertex order carries the winding, so copying it keeps the faces pointing the same way
			let vkeys = face.vertices.map(vkey => {
				let point = worldVertex(mesh, vkey);
				let id = [point.x, point.y, point.z].map(round3).join(',');
				let existing = by_position.get(id);
				if (existing) return existing;
				let added = group.addVertices([round3(point.x), round3(point.y), round3(point.z)])[0];
				by_position.set(id, added);
				return added;
			});
			let uv = {};
			face.vertices.forEach((vkey, index) => uv[vkeys[index]] = face.uv[vkey] ? face.uv[vkey].slice() : [0, 0]);
			group.addFaces(new MeshFace(group, {vertices: vkeys, uv, texture: face.texture}));
			delete mesh.faces[fkey];
		}
	}
	group.init();

	let emptied = [];
	for (let mesh of meshes) {
		removeLooseVertices(mesh);
		delete Project.mesh_selection[mesh.uuid];
		if (!Object.keys(mesh.faces).length) emptied.push(mesh);
	}
	emptied.forEach(mesh => mesh.remove());

	unselectAllElements();
	group.select();
	let left = meshes.filter(mesh => !emptied.includes(mesh));
	Undo.finishEdit('Group tiles', {elements: [...left, group], outliner: true, selection: true});
	Canvas.updateView({elements: [...left, group], element_aspects: {geometry: true, faces: true, uv: true}, selection: true});
	return group;
}

// Turns the selection a quarter turn around Y and puts it back on its own footprint, so every coordinate stays a
// multiple of the half cell instead of swinging around the scene origin like the stock rotate does
function rotateGroup(clockwise) {
	let meshes = Mesh.selected.slice();
	if (!meshes.length) return;
	Undo.initEdit({elements: meshes});

	let points = new Map();
	let min = new THREE.Vector3(Infinity, Infinity, Infinity);
	for (let mesh of meshes) {
		mesh.mesh.updateMatrixWorld(true);
		for (let vkey in mesh.vertices) {
			let point = worldVertex(mesh, vkey);
			points.set(mesh.uuid + '|' + vkey, point);
			min.min(point);
		}
	}
	let turned = new Map();
	let new_min = new THREE.Vector3(Infinity, Infinity, Infinity);
	for (let [key, point] of points) {
		let dx = point.x - min.x, dz = point.z - min.z;
		let spun = new THREE.Vector3(min.x + (clockwise ? -dz : dz), point.y, min.z + (clockwise ? dx : -dx));
		turned.set(key, spun);
		new_min.min(spun);
	}
	let offset = new THREE.Vector3(min.x - new_min.x, 0, min.z - new_min.z);
	for (let mesh of meshes) {
		for (let vkey in mesh.vertices) {
			let point = turned.get(mesh.uuid + '|' + vkey).add(offset);
			let local = mesh.mesh.worldToLocal(point);
			mesh.vertices[vkey] = [round3(local.x), round3(local.y), round3(local.z)];
		}
	}
	Undo.finishEdit('Rotate group');
	Canvas.updateView({elements: meshes, element_aspects: {geometry: true, faces: true, uv: true}, selection: true});
}

// Tiles of other elements sitting exactly where this element has tiles: the overlap a duplicated group leaves on
// what was already there. Facing is ignored, so a tile and a back-to-back twin both go.
function cullOverlappingFaces(mesh) {
	if (!(mesh instanceof Mesh)) return 0;
	let cells = new Set();
	for (let fkey in mesh.faces) {
		let tile = describeTile(mesh, mesh.faces[fkey]);
		if (tile) cells.add(`${tile.axis}|${tile.depth}|${tile.u}|${tile.v}`);
	}
	let victims = [];
	for (let other of Mesh.all) {
		if (other == mesh || other.locked) continue;
		for (let fkey in other.faces) {
			let tile = describeTile(other, other.faces[fkey]);
			if (tile && cells.has(`${tile.axis}|${tile.depth}|${tile.u}|${tile.v}`)) victims.push({mesh: other, fkey});
		}
	}
	if (!victims.length) {
		Blockbench.showQuickMessage('No overlapping tiles', 1200);
		return 0;
	}
	let meshes = [...new Set(victims.map(victim => victim.mesh))];
	Undo.initEdit({elements: meshes, outliner: true});
	victims.forEach(victim => delete victim.mesh.faces[victim.fkey]);
	let emptied = [];
	for (let other of meshes) {
		removeLooseVertices(other);
		if (!Object.keys(other.faces).length) emptied.push(other);
	}
	emptied.forEach(other => other.remove());
	let left = meshes.filter(other => !emptied.includes(other));
	Undo.finishEdit('Cull overlapping faces', {elements: left, outliner: true});
	Canvas.updateView({elements: left, element_aspects: {geometry: true, faces: true, uv: true}, selection: true});
	Blockbench.showQuickMessage(`Removed ${victims.length} overlapping tiles`, 1500);
	return victims.length;
}

BARS.defineActions(function() {
	new Action('dew_cull_overlapping', {
		name: 'Cull Overlapping Faces',
		description: 'Remove tiles of other elements that sit exactly where this element has tiles',
		icon: 'layers_clear',
		category: 'edit',
		condition: () => Format.id == 'dew_scene',
		click(context) {
			cullOverlappingFaces(context instanceof Mesh ? context : Mesh.selected[0]);
		},
	});
	new Action('dew_group_tiles', {
		name: 'Group Tiles',
		description: 'Move the selected tiles into their own element, to select, duplicate, move or rotate as a unit',
		icon: 'workspaces',
		category: 'edit',
		condition: () => Format.id == 'dew_scene' && Mesh.all.some(mesh => mesh.getSelectedFaces().length),
		click: groupTiles,
	});
	new Action('dew_rotate_group_cw', {
		name: 'Rotate Group 90 CW',
		description: 'Turn the selected elements a quarter turn clockwise, in place and on the grid',
		icon: 'rotate_right',
		category: 'transform',
		condition: () => Format.id == 'dew_scene' && Mesh.selected.length,
		click: () => rotateGroup(true),
	});
	new Action('dew_rotate_group_ccw', {
		name: 'Rotate Group 90 CCW',
		description: 'Turn the selected elements a quarter turn counterclockwise, in place and on the grid',
		icon: 'rotate_left',
		category: 'transform',
		condition: () => Format.id == 'dew_scene' && Mesh.selected.length,
		click: () => rotateGroup(false),
	});
});

Object.assign(window, {DEWGroup: {groupTiles, rotateGroup, GROUP}});
