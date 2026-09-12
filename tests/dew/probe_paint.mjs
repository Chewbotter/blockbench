// Everything that can make a brush stroke come out transparent, read from the app that is running.
// Run it while the problem is happening, on the dev build (npm run dev), and read the flags:
//   node tests/dew/run_cdp.mjs tests/dew/probe_paint.mjs
const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find(t => t.type == 'page' && t.url.includes('index.html')) ?? targets.find(t => t.type == 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result.result.value; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { if (await ev('typeof Blockbench != "undefined" && !!window.Painter')) break; await sleep(500); }

console.log('what the app is set to right now:');
console.log(await ev(`(() => {
	let out = {
		mode: Mode.selected ? Mode.selected.id : null,
		tool: Toolbox.selected ? Toolbox.selected.id : null,
		// The eraser clears whatever it touches, whichever colour is picked
		tool_erases: Toolbox.selected && Toolbox.selected.id == 'eraser',
		// destination-out: strokes clear pixels instead of laying colour down
		erase_mode: Painter.erase_mode,
		// Only paints where the texture is already opaque, so strokes on clear pixels do nothing
		lock_alpha: Painter.lock_alpha,
		blend_mode: BarItems.blend_mode ? BarItems.blend_mode.value : null,
		// The stroke takes its alpha from here, not from the colour
		brush_opacity: BarItems.slider_brush_opacity ? BarItems.slider_brush_opacity.get() : null,
		brush_size: BarItems.slider_brush_size ? BarItems.slider_brush_size.get() : null,
		colour: typeof ColorPanel != 'undefined' ? ColorPanel.get() : null,
		texture: Texture.selected ? Texture.selected.name : null,
		layer: Texture.selected && Texture.selected.selected_layer ? Texture.selected.selected_layer.name : null,
		layer_opacity: Texture.selected && Texture.selected.selected_layer ? Texture.selected.selected_layer.opacity : null,
	};
	return JSON.stringify(out, null, 1); })()`));
console.log('anything true in tool_erases, erase_mode or lock_alpha, or a brush_opacity near 0, explains a stroke that clears');
ws.close();
