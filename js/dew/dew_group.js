// Grouping for DEW scenes: the selected tiles become their own element, so a building can be selected once and
// then duplicated, moved, rotated or deleted as a unit with the stock tools. Two constraints keep the result
// readable by the tile tools: moves snap to the half cell (the format sets the edit size while a DEW scene is
// open) and rotation is 90 degrees in place, so tiles stay axis aligned and on the grid.
import { THREE } from "../lib/libs";
import { DEW } from "./dew_scene";
import { describeTile, tileUV, PLANE_AXES } from "./tile_brush";

const GROUP = {
	NAME: 'group',
	MESSAGE_TIME: 1200,
};
const H = DEW.HALF_CELL;

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

// Tiles sharing a plane and cell with this element's tiles: the overlap a duplicated group leaves on what was
// already there. Both sides go, since a coincident pair is hidden from outside and fights in the depth buffer.
// Facing is ignored, so a tile and a back-to-back twin both go.
function cullOverlappingFaces(mesh) {
	if (!(mesh instanceof Mesh)) return 0;
	let cells = new Map();
	for (let other of Mesh.all) {
		if (other.locked) continue;
		for (let fkey in other.faces) {
			let tile = describeTile(other, other.faces[fkey]);
			if (!tile) continue;
			let key = `${tile.axis}|${tile.depth}|${tile.u}|${tile.v}`;
			cells.set(key, (cells.get(key) || []).concat([{mesh: other, fkey}]));
		}
	}
	let victims = [];
	for (let faces of cells.values()) {
		if (faces.length > 1 && faces.some(face => face.mesh == mesh)) victims.push(...faces);
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

// Extrude: the selected tiles travel the way they face, and the gap they leave behind is skinned with tiles of
// the same size, so a floor pulled up comes back as a platform with walls around it. Blockbench's own extrude
// leaves the original faces where they were and skins a pull of any length with one quad.
function worldNormal(mesh, face) {
	let normal = new THREE.Vector3().fromArray(face.getNormal(true));
	return normal.applyQuaternion(mesh.mesh.getWorldQuaternion(new THREE.Quaternion()));
}
function vertexAt(mesh, point, known) {
	let local = mesh.mesh.worldToLocal(point.clone());
	let position = [round3(local.x), round3(local.y), round3(local.z)];
	let id = position.join(',');
	let existing = known.get(id);
	if (existing) return existing;
	let added = mesh.addVertices(position)[0];
	known.set(id, added);
	return added;
}
// One tile of the skin, wound to face away from the run and textured like the tile it came off
function addSkinTile(mesh, known, axis, sign, corners, texture) {
	let [ua, va] = PLANE_AXES[axis];
	let origin_u = Math.min(...corners.map(point => point[ua]));
	let origin_v = Math.min(...corners.map(point => point[va]));
	let vkeys = corners.map(point => vertexAt(mesh, point, known));
	let uv = {};
	corners.forEach((point, index) => uv[vkeys[index]] = tileUV(axis, sign, round3(point[ua] - origin_u), round3(point[va] - origin_v), H));
	let face = new MeshFace(mesh, {vertices: vkeys, uv, texture});
	mesh.addFaces(face);
	if (worldNormal(mesh, face)[axis] * sign < 0) face.invert();
}
function extrudeTiles(distance) {
	let sources = selectedFaces();
	if (!sources.length || !distance) return null;
	let meshes = sources.map(source => source.mesh);
	Undo.initEdit({elements: meshes, selection: true});

	let moved = 0, skin = 0;
	for (let {mesh, fkeys} of sources) {
		mesh.mesh.updateMatrixWorld(true);
		let known = new Map();
		for (let vkey in mesh.vertices) known.set(mesh.vertices[vkey].map(round3).join(','), vkey);

		// The selection split by the plane each tile stands in, since each plane leaves along its own facing
		let planes = new Map();
		for (let fkey of fkeys) {
			let face = mesh.faces[fkey];
			if (!face) continue;
			let tile = describeTile(mesh, face);
			if (!tile) continue;	// diagonals and triangles have no cell to skin
			let id = `${tile.axis}|${tile.depth}|${tile.sign}`;
			if (!planes.has(id)) planes.set(id, {axis: tile.axis, depth: tile.depth, sign: tile.sign, cells: new Map()});
			planes.get(id).cells.set(`${tile.u}|${tile.v}`, {face, tile});
		}

		for (let {axis, depth, sign, cells} of planes.values()) {
			let [ua, va] = PLANE_AXES[axis];
			let travel = sign * distance;
			let towards = Math.sign(travel);
			let steps = Math.round(Math.abs(distance) / H);

			// New vertices for the tiles that leave, so the ones staying keep the vertices they shared
			for (let {face} of cells.values()) {
				let keys = face.vertices.map(vkey => {
					let point = worldVertex(mesh, vkey);
					point[axis] += travel;
					return vertexAt(mesh, point, known);
				});
				let uv = {};
				face.vertices.forEach((vkey, index) => uv[keys[index]] = face.uv[vkey] ? face.uv[vkey].slice() : [0, 0]);
				face.vertices = keys;
				face.uv = uv;
				moved++;
			}

			// A cell side with no selected neighbour is on the outside of the run, so it gets skinned
			let sides = [
				{axis: ua, sign: -1, from: [0, 0], to: [0, H], neighbour: [-H, 0]},
				{axis: ua, sign: 1, from: [H, 0], to: [H, H], neighbour: [H, 0]},
				{axis: va, sign: -1, from: [0, 0], to: [H, 0], neighbour: [0, -H]},
				{axis: va, sign: 1, from: [0, H], to: [H, H], neighbour: [0, H]},
			];
			for (let {tile, face} of cells.values()) {
				for (let side of sides) {
					if (cells.has(`${tile.u + side.neighbour[0]}|${tile.v + side.neighbour[1]}`)) continue;
					let corner = (offset, at) => {
						let point = new THREE.Vector3();
						point[axis] = at;
						point[ua] = tile.u + offset[0];
						point[va] = tile.v + offset[1];
						return point;
					};
					for (let i = 0; i < steps; i++) {
						let near = depth + towards * H * i, far = near + towards * H;
						addSkinTile(mesh, known, side.axis, side.sign,
							[corner(side.from, near), corner(side.to, near), corner(side.to, far), corner(side.from, far)], face.texture);
						skin++;
					}
				}
			}
		}
		removeLooseVertices(mesh);
	}

	Canvas.updateView({elements: meshes, element_aspects: {geometry: true, faces: true, uv: true}, selection: true});
	Undo.finishEdit('Extrude tiles');
	return {moved, skin};
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
	new Action('dew_extrude_tiles', {
		name: 'Extrude Tiles',
		description: 'Pull the selected tiles along the way they face, skinning the sides with tiles of the same size',
		icon: 'open_in_full',
		category: 'edit',
		condition: () => Format.id == 'dew_scene' && Mesh.all.some(mesh => mesh.getSelectedFaces().length),
		click() {
			new Dialog({
				id: 'dew_extrude_tiles',
				title: 'Extrude Tiles',
				width: 420,
				form: {
					tiles: {label: 'Distance in tiles', type: 'number', value: 1, min: -64, max: 64, step: 0.5,
						description: `A tile is ${DEW.TILE} units, so 0.5 is one half cell (${DEW.HALF_CELL}). Negative pulls the other way.`},
				},
				onConfirm(result) {
					let distance = Math.round(result.tiles * DEW.TILE / H) * H;
					if (!distance) return;
					let counts = extrudeTiles(distance);
					if (counts) Blockbench.showQuickMessage(`Extruded ${counts.moved} tiles, ${counts.skin} added`, GROUP.MESSAGE_TIME);
				}
			}).show();
		},
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

Object.assign(window, {DEWGroup: {groupTiles, rotateGroup, extrudeTiles, GROUP}});
