// UV guard on texture apply (2026-09-22). A mesh built with Flat Color, or straight from an importer, may carry UVs that
// were never laid out: every corner of a face on one point, so the face has no area in the texture. Flat Color never
// reads UVs, so nothing shows until a texture is applied, and then each such face is painted with the one texel under
// its point (the user's pillow: side strips went black on the drawer's shadow line and read as missing faces). So
// Texture.apply is wrapped: when the faces that just took the texture include collapsed ones, a message says how many,
// selects them, and offers Auto Unwrap on those meshes (the fork's, all faces of the mesh) or leaving them as they are.
import { autoUnwrap } from "../uv/auto_unwrap";

export const UV_GUARD = {
	MIN_AREA: 1e-4,			// square texture units below which a face's uv polygon counts as collapsed
	UNWRAP_MAX_EDGE_ANGLE: 95,	// the Auto Unwrap defaults, used when the message's Unwrap button runs it
	UNWRAP_PADDING: 2,
};

/** Area of a face's uv polygon in texture units, corners in the face's sorted order */
export function uvArea(face) {
	let keys = face.getSortedVertices ? face.getSortedVertices() : face.vertices;
	let uvs = keys.map(key => face.uv[key]).filter(Boolean);
	if (uvs.length < 3) return 0;
	let area = 0;
	for (let i = 0; i < uvs.length; i++) {
		let a = uvs[i], b = uvs[(i + 1) % uvs.length];
		area += a[0] * b[1] - b[0] * a[1];
	}
	return Math.abs(area) / 2;
}

/** The faces of a mesh carrying this texture whose uvs have no area */
export function collapsedFaces(mesh, texture_uuid) {
	let keys = [];
	for (let key in mesh.faces) {
		let face = mesh.faces[key];
		if (face.texture !== texture_uuid || face.vertices.length < 3) continue;
		if (uvArea(face) < UV_GUARD.MIN_AREA) keys.push(key);
	}
	return keys;
}

function warnCollapsed(texture, elements) {
	let found = [];
	for (let element of elements) {
		if (!(element instanceof Mesh)) continue;
		let keys = collapsedFaces(element, texture.uuid);
		if (keys.length) found.push({mesh: element, keys});
	}
	if (!found.length) return null;
	let count = found.reduce((n, f) => n + f.keys.length, 0);
	let names = found.map(f => f.mesh.name).join(', ');
	// select the faces so the UV panel shows the point they sit on
	unselectAllElements();
	for (let {mesh, keys} of found) {
		mesh.select();
		if (!Project.mesh_selection[mesh.uuid]) Project.mesh_selection[mesh.uuid] = {faces: [], vertices: [], edges: []};
		Project.mesh_selection[mesh.uuid].faces = keys.slice();
		Project.mesh_selection[mesh.uuid].vertices = [...new Set(keys.flatMap(key => mesh.faces[key].vertices))];
	}
	updateSelection();
	Blockbench.showMessageBox({
		title: 'Faces without a UV layout',
		message: `${count} face${count == 1 ? '' : 's'} of ${names} ha${count == 1 ? 's' : 've'} no UV layout: every corner sits on one point, so each face shows the single texel under it. They are selected. Auto Unwrap lays out every face of ${found.length == 1 ? 'that mesh' : 'those meshes'} afresh.`,
		buttons: ['Auto Unwrap', 'Keep as is'],
		confirm: 0,
		cancel: 1,
	}, result => {
		if (result !== 0) return;
		autoUnwrap(found.map(f => f.mesh), {max_edge_angle: UV_GUARD.UNWRAP_MAX_EDGE_ANGLE, padding: UV_GUARD.UNWRAP_PADDING, reserve: 0});
	});
	return found;
}

const stockApply = Texture.prototype.apply;
Texture.prototype.apply = function(all) {
	let elements = Outliner.selected.filter(el => el.faces);
	let result = stockApply.call(this, all);
	if (Format.per_group_texture) return result;
	warnCollapsed(this, elements);
	return result;
};

Object.assign(window, {DEWUVGuard: {UV_GUARD, uvArea, collapsedFaces, stockApply}});
