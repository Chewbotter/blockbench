// Splitting a polygon with any number of corners into faces Blockbench can draw: triangles and CONVEX quads.
// Shared by the OBJ importer and Quads from OBJ Reference (fork, 2026-10-09). A fan from the first corner, the
// previous rule, is right for a convex polygon and wrong for a concave one: its pieces leave the outline and
// overlap each other (on the user's house, 01.obj, 72 of 533 n-gons drew too much area, the worst 2.3 times).
import { THREE } from "../../lib/libs";

export const POLYGON = {
	// a corner whose turn is under this share of the polygon's extent squared is collinear
	COLLINEAR: 1e-6,
	// a corner farther off the polygon's mean plane than this share of its extent makes it non-planar
	PLANAR: 1e-3,
};

type Vec3 = number[] | ArrayVector3;
type Point = [number, number];

/** The polygon's mean plane (Newell normal, which follows its winding) and its corners projected onto it,
 *  counter-clockwise about that normal; `planar` says whether every corner lies on the plane. */
export function polygonPlane(positions: Vec3[]): {normal: THREE.Vector3, points: Point[], extent: number, planar: boolean} {
	let normal = new THREE.Vector3();
	let n = positions.length;
	for (let i = 0; i < n; i++) {
		let a = positions[i], b = positions[(i + 1) % n];
		normal.x += (a[1] - b[1]) * (a[2] + b[2]);
		normal.y += (a[2] - b[2]) * (a[0] + b[0]);
		normal.z += (a[0] - b[0]) * (a[1] + b[1]);
	}
	if (normal.lengthSq() == 0) normal.set(0, 1, 0); else normal.normalize();
	// a basis in the plane: u perpendicular to the normal and the axis it is least aligned with, v = n x u
	let least = Math.abs(normal.x) <= Math.abs(normal.y) && Math.abs(normal.x) <= Math.abs(normal.z) ? new THREE.Vector3(1, 0, 0)
		: Math.abs(normal.y) <= Math.abs(normal.z) ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
	let u = new THREE.Vector3().crossVectors(normal, least).normalize();
	let v = new THREE.Vector3().crossVectors(normal, u);
	let origin = new THREE.Vector3().fromArray(positions[0] as number[]);
	let points: Point[] = [], depth: number[] = [];
	let p = new THREE.Vector3();
	for (let pos of positions) {
		p.fromArray(pos as number[]).sub(origin);
		points.push([p.dot(u), p.dot(v)]);
		depth.push(p.dot(normal));
	}
	let min = [Infinity, Infinity], max = [-Infinity, -Infinity];
	for (let [x, y] of points) { min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y); }
	let extent = Math.hypot(max[0] - min[0], max[1] - min[1]) || 1;
	let planar = depth.every(d => Math.abs(d) <= POLYGON.PLANAR * extent);
	return {normal, points, extent, planar};
}

function cross(points: Point[], a: number, b: number, c: number): number {
	return (points[b][0] - points[a][0]) * (points[c][1] - points[b][1]) - (points[b][1] - points[a][1]) * (points[c][0] - points[b][0]);
}
function signedArea(points: Point[], order: number[]): number {
	let area = 0;
	for (let i = 0; i < order.length; i++) {
		let a = points[order[i]], b = points[order[(i + 1) % order.length]];
		area += a[0] * b[1] - b[0] * a[1];
	}
	return area / 2;
}
/** Every corner turns left (counter-clockwise) or is straight; `strict` refuses straight corners too. */
function isConvex(points: Point[], order: number[], epsilon: number, strict = false): boolean {
	let n = order.length;
	for (let i = 0; i < n; i++) {
		let turn = cross(points, order[(i + n - 1) % n], order[i], order[(i + 1) % n]);
		if (turn < -epsilon || (strict && turn <= epsilon)) return false;
	}
	return true;
}

/** Joins triangles (index triples into `points`, any winding) into convex quads where two share an edge and their
 *  union turns only one way; the rest stay triangles. The triangles of one polygon form a tree by adjacency, so a
 *  leaf is matched with its only neighbour first, which pairs as many as a tree allows. Pieces come back
 *  counter-clockwise in `points`. */
export function joinTrianglesToQuads(points: Point[], triangles: number[][], extent?: number): number[][] {
	extent = extent || 1;
	let epsilon = POLYGON.COLLINEAR * extent * extent;
	let tris = triangles.map(t => signedArea(points, t) < 0 ? t.slice().reverse() : t.slice());
	let edge_key = (a: number, b: number) => a < b ? a + '_' + b : b + '_' + a;
	let by_edge = new Map<string, number[]>();
	tris.forEach((t, i) => { for (let k = 0; k < 3; k++) { let key = edge_key(t[k], t[(k + 1) % 3]); if (!by_edge.has(key)) by_edge.set(key, []); by_edge.get(key).push(i); } });
	let neighbours = tris.map((t, i) => { let set = new Set<number>(); for (let k = 0; k < 3; k++) for (let j of by_edge.get(edge_key(t[k], t[(k + 1) % 3]))) if (j != i) set.add(j); return set; });
	let quadOf = (i: number, j: number): number[] | null => {
		let t1 = tris[i], t2 = tris[j];
		for (let k = 0; k < 3; k++) {
			let a = t1[k], b = t1[(k + 1) % 3], c = t1[(k + 2) % 3];
			if (!t2.includes(a) || !t2.includes(b)) continue;
			let d = t2.find(x => x != a && x != b);
			if (d === undefined || d == c) return null;
			let quad = [a, d, b, c];	// t2 runs b, a, d on its side of the shared edge, so the union walks a, d, b, c
			return isConvex(points, quad, epsilon, true) ? quad : null;
		}
		return null;
	};
	let left = new Set(tris.map((t, i) => i));
	let pieces: number[][] = [];
	while (left.size) {
		let degree = (i: number) => [...neighbours[i]].filter(j => left.has(j)).length;
		let pick = [...left].reduce((best, i) => degree(i) < degree(best) ? i : best, [...left][0]);
		left.delete(pick);
		let joined: number[] | null = null;
		for (let j of neighbours[pick]) {
			if (!left.has(j)) continue;
			joined = quadOf(pick, j);
			if (joined) { left.delete(j); break; }
		}
		pieces.push(joined || tris[pick]);
	}
	return pieces;
}

/** Splits a polygon (corner positions in order, any winding) into drawable pieces, as index lists into `positions`
 *  in the polygon's own winding: itself when it is a triangle or a convex quad, a fan of quads and a last triangle
 *  when it is a convex n-gon, and for anything concave an ear-clipping triangulation (three's earcut) with
 *  neighbouring triangles joined into convex quads. A collinear corner that earcut leaves out is put back by
 *  splitting the triangle whose edge it lies on, so every corner stays part of the surface. */
export function polygonPieces(positions: Vec3[]): number[][] {
	let n = positions.length;
	let order = positions.map((p, i) => i);
	if (n < 3) return [];
	if (n == 3) return [order];
	let {points, extent} = polygonPlane(positions);
	let epsilon = POLYGON.COLLINEAR * extent * extent;
	// strictly convex: the fan is the best split there is. A straight corner goes the earcut way instead, so it
	// ends up inside no quad (a quad with three corners in a line draws a zero-area triangle)
	if (isConvex(points, order, epsilon, true)) {
		if (n == 4) return [order];
		let pieces: number[][] = [];
		for (let start = 1; start < n - 1; start += 2) pieces.push([0, ...order.slice(start, Math.min(start + 3, n))]);
		return pieces;
	}
	let triangles: number[][] = THREE.ShapeUtils.triangulateShape(points.map(p => new THREE.Vector2(p[0], p[1])), []).map(t => [t[0], t[1], t[2]]);
	triangles = triangles.map(t => signedArea(points, t) < 0 ? t.reverse() : t);
	// Earcut can emit a sliver whose three corners lie in a line (01.obj, a 22-corner wall): dropped, it drew
	// nothing. Then every corner lying in the middle of a triangle's edge is put into that triangle: a corner earcut
	// left out as collinear comes back, and no corner sits on the side of a piece it is not part of.
	triangles = triangles.filter(t => Math.abs(signedArea(points, t)) > epsilon);
	for (let k = 0; k < n; k++) {
		let [x, y] = points[k];
		for (let i = 0; i < triangles.length; i++) {
			let t = triangles[i];
			if (t.includes(k)) continue;
			for (let e = 0; e < 3; e++) {
				let a = t[e], b = t[(e + 1) % 3], c = t[(e + 2) % 3];
				let [ax, ay] = points[a], [bx, by] = points[b];
				let dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
				if (len2 == 0) continue;
				let along = ((x - ax) * dx + (y - ay) * dy) / len2;
				let off = Math.abs((x - ax) * dy - (y - ay) * dx);
				if (along > 0 && along < 1 && off <= epsilon) {
					triangles.splice(i, 1, [a, k, c], [k, b, c]);
					i++;	// both halves hold k now; carry on past them
					break;
				}
			}
		}
	}
	return joinTrianglesToQuads(points, triangles, extent);
}
