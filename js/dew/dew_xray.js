// View > X-Ray (Alt + X): every element drawn see-through, so faces, edges and vertices inside or behind an object show.
// The face shaders multiply their alpha by the shared XRAY_OPACITY uniform (js/preview/canvas.js). Alpha alone is not
// enough: a face still writes depth and hides whatever is drawn after it, so while X-Ray is on every element material
// is made transparent without depth writes. Materials are created lazily (a new texture, a view mode switch), so the
// flags are applied right before each render rather than once on toggle. Clicks in vertex and edge selection mode
// reach through the front faces too (`Preview.raycast`, reading `Canvas.xray`); a rectangle select already ignored
// occlusion. Face mode still picks the nearest face.

export const XRAY = {
	OPACITY: 0.3,	// face opacity while X-Ray is on
};

Canvas.xray = false;
const touched = new Set();

function applyMaterial(material) {
	if (!material || !material.uniforms || !material.uniforms.XRAY_OPACITY) return;
	if (!material.userData.xray_stock) {
		material.userData.xray_stock = {transparent: material.transparent, depthWrite: material.depthWrite};
	}
	if (!material.transparent) {
		material.transparent = true;
		material.needsUpdate = true;
	}
	material.depthWrite = false;
	touched.add(material);
}

function restoreMaterials() {
	for (let material of touched) {
		let stock = material.userData.xray_stock;
		if (material.transparent != stock.transparent) material.needsUpdate = true;
		material.transparent = stock.transparent;
		material.depthWrite = stock.depthWrite;
	}
	touched.clear();
}

// Installed on first use: Canvas.scene does not exist yet when the bundle loads (initCanvas runs at boot)
let hooked_scene = null;
function hookScene() {
	if (hooked_scene == Canvas.scene) return;
	hooked_scene = Canvas.scene;
	const stockBeforeRender = Canvas.scene.onBeforeRender;
	Canvas.scene.onBeforeRender = function(...args) {
		if (Canvas.xray) {
			for (let element of Outliner.elements) {
				let mesh = element.mesh;
				if (!mesh || !mesh.material) continue;
				if (mesh.material instanceof Array) mesh.material.forEach(applyMaterial);
				else applyMaterial(mesh.material);
			}
		}
		return stockBeforeRender.apply(this, args);
	};
}

BARS.defineActions(function() {
	new Toggle('dew_xray', {
		name: 'X-Ray',
		description: 'Draw every element see-through, so faces, edges and vertices behind the front surface show and can be clicked',
		icon: 'flip_to_back',
		category: 'view',
		keybind: new Keybind({key: 'x', alt: true}),
		default: false,
		condition: () => !!Project,
		onChange(value) {
			if (value) hookScene();
			Canvas.xray = value;
			Canvas.backfaceUniforms.XRAY_OPACITY.value = value ? XRAY.OPACITY : 1;
			if (!value) restoreMaterials();
			Preview.all.forEach(preview => preview.render());
		}
	});
});

Object.assign(window, {DEWXRay: {XRAY}});
