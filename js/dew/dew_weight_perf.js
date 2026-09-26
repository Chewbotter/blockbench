// Weight brush without the crawl (2026-09-25). Each mouse move of a stroke used to rebuild the painted mesh's whole
// geometry and then run the global selection update, which rebuilt every mesh again: 233 ms a move on the cat's body
// (1864 faces, 69 bones), up to 476, mostly the weight colours, where every corner of every face sums its vertex's
// weight over all bones. During a stroke only the colours of the vertices the brush touched can change, so those are
// rewritten in place, with the stock colour code; the full rebuild and the selection update run once, at stroke end.
export const WEIGHT_PERF = {
	FAST_STROKE: true,	// false puts the stock per-move rebuild back (the tests' control)
};

// vertex key -> its slots in the geometry buffers, in the stock build order: faces in order, each face's corners in
// order, triangles and quads only (the stock build skips anything else)
const slot_maps = new WeakMap();
function slotMap(element) {
	let geometry = element.mesh && element.mesh.geometry;
	let cached = slot_maps.get(element);
	if (cached && cached.geometry === geometry && cached.count === geometry.attributes.position.count) return cached.map;
	let map = new Map(), slot = 0;
	for (let fkey in element.faces) {
		let face = element.faces[fkey];
		if (face.vertices.length != 3 && face.vertices.length != 4) continue;
		for (let vkey of face.vertices) {
			if (!map.has(vkey)) map.set(vkey, []);
			map.get(vkey).push(slot++);
		}
	}
	if (!geometry || !geometry.attributes.position || slot != geometry.attributes.position.count) return null;
	slot_maps.set(element, {geometry, count: slot, map});
	return map;
}

/** Rewrites the weight colours of these vertices in place. Returns false when the buffers do not match, so the caller
 * falls back to the stock rebuild. */
export function recolorWeights(element, vkeys) {
	let color = element.mesh && element.mesh.geometry.attributes.color;
	let map = color && slotMap(element);
	if (!map || !Mesh.VertexWeightColorGenerator || !element.getArmature()) return false;
	let generator = new Mesh.VertexWeightColorGenerator(element);
	let array = color.array;
	for (let vkey of vkeys) {
		let slots = map.get(vkey);
		if (!slots) continue;
		let c = generator.getVertexColor(vkey) ?? Mesh.PLAIN_VERTEX_COLOR;	// no weight: the stock plain colour
		for (let s of slots) { array[s * 3] = c[0]; array[s * 3 + 1] = c[1]; array[s * 3 + 2] = c[2]; }
	}
	color.needsUpdate = true;
	return true;
}

Object.assign(window, {DEWWeightPerf: {WEIGHT_PERF, recolorWeights}});
