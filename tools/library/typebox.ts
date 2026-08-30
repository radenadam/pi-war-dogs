/**
 * Local StringEnum — a byte-faithful copy of pi-ai's helper
 * (utils/typebox-helpers.js): a plain `enum` string schema, because some
 * providers reject anyOf/const patterns.
 *
 * Local since 2026-08-25 (the 0.84.3 pre-sweep): pi 0.84.3 resolves
 * `@earendil-works/pi-ai` to its COMPAT entrypoint, which does not export
 * StringEnum (it moved to a subpath the extension loader's virtual-module
 * map does not carry). Five lines owned here beat an import that breaks on
 * the next pi. tools/library/ imports no pi API by rule; typebox is pi's
 * own bundled schema lib, aliased by its loader on every runtime.
 */

import { Type } from "typebox";

export function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: [...values],
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}
