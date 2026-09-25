// Edges stay visible on their own faces (2026-09-25). A mesh's edges are a LineSegments drawn with the depth test on,
// lying exactly on the faces they border, so every edge pixel is a depth tie that float precision breaks one way or the
// other: an edge came out dotted, faint or missing, worst where the face is seen at a steep angle (the user's report on
// the soldier's arm, the edge coming back as the camera turned). Every element's face material gets a polygon offset
// that pushes the faces back a hair in depth, so the line wins the tie. Nothing moves; it is viewport only, and applied
// just before each render because materials are made lazily and swapped by the view modes.
export const EDGE_OFFSET = {
	FACTOR: 1,	// depth slope scaled: what fixes steep angles
	UNITS: 1,	// smallest depth step: what fixes head-on views
};

function offsetMaterial(material) {
	if (!material || material.isLineBasicMaterial || material.isPointsMaterial) return;
	if (material.polygonOffset && material.polygonOffsetFactor == EDGE_OFFSET.FACTOR && material.polygonOffsetUnits == EDGE_OFFSET.UNITS) return;
	material.polygonOffset = EDGE_OFFSET.FACTOR != 0 || EDGE_OFFSET.UNITS != 0;
	material.polygonOffsetFactor = EDGE_OFFSET.FACTOR;
	material.polygonOffsetUnits = EDGE_OFFSET.UNITS;
}

export function applyEdgeOffset() {
	for (let element of Outliner.elements) {
		let material = element.mesh && element.mesh.material;
		if (Array.isArray(material)) material.forEach(offsetMaterial);
		else offsetMaterial(material);
	}
}

let installed = false;
function install() {
	if (installed || !Canvas.scene) return;
	installed = true;
	let inner = Canvas.scene.onBeforeRender;
	Canvas.scene.onBeforeRender = function(...args) { applyEdgeOffset(); if (inner) return inner.apply(this, args); };
}
Blockbench.on('select_project', install);
Blockbench.on('setup_project', install);

Object.assign(window, {DEWEdgeOffset: {EDGE_OFFSET, applyEdgeOffset}});
