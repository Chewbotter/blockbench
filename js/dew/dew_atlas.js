// DEW Atlas: a test texture where every tile is its own flat color, for trying out the texture brush
import { DEW } from "./dew_scene";

const ATLAS = {
	HUE_STEP: 137.508,			// golden angle, keeps consecutive tiles far apart on the color wheel
	SATURATION: 0.6,
	LIGHTNESS: [0.42, 0.62],	// alternates in a checker so neighboring tiles also differ in brightness
	MAX_TILES_PER_SIDE: 64,
};

export function createDewAtlas(name, tile_size, columns, rows) {
	let canvas = document.createElement('canvas');
	canvas.width = tile_size * columns;
	canvas.height = tile_size * rows;
	let ctx = canvas.getContext('2d');
	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < columns; col++) {
			let index = row * columns + col;
			let color = new tinycolor({h: (index * ATLAS.HUE_STEP) % 360, s: ATLAS.SATURATION, l: ATLAS.LIGHTNESS[(row + col) % 2]});
			ctx.fillStyle = color.toHexString();
			ctx.fillRect(col * tile_size, row * tile_size, tile_size, tile_size);
		}
	}
	// UV size follows the pixel size, so face UVs can be written in texels
	let texture = new Texture({name: name || 'atlas'}).fromDataURL(canvas.toDataURL()).add(true, true);
	texture.select();
	return texture;
}

BARS.defineActions(function() {
	new Action('create_dew_atlas', {
		name: 'DEW Atlas',
		description: 'Create a test atlas where every tile is a different flat color',
		icon: 'grid_view',
		category: 'textures',
		condition: () => Format.id == 'dew_scene',
		click() {
			new Dialog({
				id: 'create_dew_atlas',
				title: 'DEW Atlas',
				width: 420,
				form: {
					name: {label: 'generic.name', value: 'atlas'},
					tile_size: {label: 'Pixels per Tile', type: 'number', value: DEW.HALF_CELL, min: 1, max: 256, step: 1},
					columns: {label: 'Columns', type: 'number', value: 8, min: 1, max: ATLAS.MAX_TILES_PER_SIDE, step: 1},
					rows: {label: 'Rows', type: 'number', value: 8, min: 1, max: ATLAS.MAX_TILES_PER_SIDE, step: 1},
				},
				onConfirm(result) {
					createDewAtlas(result.name, Math.round(result.tile_size), Math.round(result.columns), Math.round(result.rows));
				}
			}).show();
		}
	});
});
