// Node, where the assets that ship in this package can be read off disk, so `baseUrl` becomes
// optional and `createCompiler()` is enough on its own.
import { createApi } from './api.js';
import { packagedAssets } from './packaged.node.js';

export const createCompiler = createApi({ packaged: packagedAssets }).createCompiler;
