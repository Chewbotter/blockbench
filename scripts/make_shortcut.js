// Creates Blockbench.lnk in the repo root pointing at the unpacked build.
// The unpacked exe keeps a stable path across rebuilds, so Windows Firewall
// only asks for permission once (a portable exe unpacks to a new temp folder every launch).
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const root = process.cwd();
const target = path.join(root, 'dist-electron', 'win-unpacked', 'Blockbench.exe');
const link = path.join(root, 'Blockbench.lnk');

if (!fs.existsSync(target)) {
	console.error(`Unpacked build not found at ${target}`);
	process.exit(1);
}
const ps = `
$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${link}');
$s.TargetPath = '${target}';
$s.WorkingDirectory = '${path.dirname(target)}';
$s.IconLocation = '${target},0';
$s.Description = 'Blockbench (custom build)';
$s.Save();
`;
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' });
console.log(`Created ${link} -> ${target}`);
