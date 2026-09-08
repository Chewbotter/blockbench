// Copies the freshly built portable exe from dist-electron/ to the project root as Blockbench.exe
import fs from 'fs';
import path from 'path';

const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));
const src = path.join('dist-electron', `Blockbench_x64_${pkg.version}.exe`);
const dest = 'Blockbench.exe';

if (!fs.existsSync(src)) {
	console.error(`Portable build not found at ${src}`);
	process.exit(1);
}
fs.copyFileSync(src, dest);
console.log(`Copied ${src} -> ${dest}`);
