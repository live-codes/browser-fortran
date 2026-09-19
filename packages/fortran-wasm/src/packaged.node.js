// The Node half of the packaged-asset source: reading the files that ship in this package.
//
// This module is only reachable through the `node` condition in package.json, so a browser bundle
// never includes it and never trips over `node:fs`.
import { readFile } from 'node:fs/promises';

export const PACKAGED_ROOT = new URL('../assets/', import.meta.url);

export const packagedAssets = {
	root: PACKAGED_ROOT,
	readFile: async (name) => new Uint8Array(await readFile(new URL(name, PACKAGED_ROOT)))
};
