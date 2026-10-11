import type { z as ZodNamespace } from 'zod';

// Creator3.7's resolver substitutes .js siblings for .cjs; build copies the actual CJS distribution to a .js-only vendor tree.
const runtime: unknown = require('./vendor/zod/index.js');
if (!runtime || typeof runtime !== 'object' || !('z' in runtime) || !runtime.z || typeof runtime.z !== 'object') throw new Error('Compatible schema validator runtime is unavailable.');
// The vendor tree is the installed Zod CJS distribution, copied with extension-only rewrites by the build step.
export const z = runtime.z as typeof ZodNamespace;
