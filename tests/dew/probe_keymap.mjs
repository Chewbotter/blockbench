const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find(t => t.type == 'page' && t.url.includes('index.html')) ?? targets.find(t => t.type == 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text); return r.result.result.value; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { if (await ev('typeof Blockbench != "undefined" && !!window.Preview && Preview.all.length > 0')) break; await sleep(500); }

// Full live keymap: main keybinds, sub keybinds (select options, slider nudges), Keybinds.extra,
// plus the raw stored keymap decoded, so nothing hides behind a label or a missing field.
const out = await ev(`(() => {
	let rows = [];
	let label = kb => kb.label || (kb.getText && kb.getText()) || JSON.stringify(kb);
	let add = (id, kb) => { if (!kb || kb.key == undefined || kb.key == -1 || kb.key === null) return; rows.push([label(kb), id, kb.key, !!kb.ctrl, !!kb.shift, !!kb.alt]); };
	for (let id in BarItems) {
		let item = BarItems[id];
		add(id, item.keybind);
		if (item.sub_keybinds) for (let sub in item.sub_keybinds) add(id + '.' + sub, item.sub_keybinds[sub].keybind);
	}
	for (let id in Keybinds.extra) add('extra:' + id, Keybinds.extra[id].keybind);
	rows.sort((a, b) => a[0].localeCompare(b[0]));
	let stored = JSON.parse(localStorage.getItem('keybindings') || '{}');
	let stored_bound = Object.entries(stored).filter(([k, v]) => v && v.key != undefined && v.key != -1).map(([k, v]) => [k, v.key, !!v.ctrl, !!v.shift, !!v.alt]);
	return JSON.stringify({rows, stored_count: Object.keys(stored).length, stored_bound});
})()`);
const data = JSON.parse(out);
console.log('live bindings:', data.rows.length);
for (const [l, id] of data.rows) console.log(l.padEnd(26), id);
console.log('\nstored keymap entries:', data.stored_count, 'with a key:', data.stored_bound.length);
for (const [k, code, c, s, a] of data.stored_bound) console.log('stored', k.padEnd(40), code, c ? 'ctrl' : '', s ? 'shift' : '', a ? 'alt' : '');

// Candidate check: bare key codes, no modifiers
const cand = { Tab: 9, PageUp: 33, PageDown: 34, Up: 38, Down: 40, A: 65, C: 67, D: 68, J: 74, K: 75, L: 76, N: 78, O: 79, W: 87, Y: 89, '[': 219, ']': 221 };
console.log('\ncandidate bare keys:');
for (const [name, code] of Object.entries(cand)) {
	const hits = data.rows.filter(r => r[2] == code && !r[3] && !r[4] && !r[5]).map(r => r[1]);
	const any = data.rows.filter(r => r[2] == code).map(r => r[0] + ' ' + r[1]);
	console.log(name.padEnd(9), hits.length ? 'TAKEN bare: ' + hits.join(', ') : 'free bare', any.length ? ' | with modifiers: ' + any.filter(x => !hits.some(h => x.endsWith(' ' + h))).join(', ') : '');
}
ws.close();
