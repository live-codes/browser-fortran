// The entry every environment gets unless something more specific matches, so it has to work without
// a filesystem: no `node:fs` here, and `baseUrl` is required because a browser cannot read a file
// that lives inside an npm package.
import { createApi } from './api.js';

export const createCompiler = createApi({ packaged: null }).createCompiler;
