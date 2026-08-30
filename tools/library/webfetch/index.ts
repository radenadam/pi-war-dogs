/**
 * Public API. Import { betterFetch } to fetch a page; call closeBrowser() on
 * shutdown to release the headless Chrome.
 */

export { betterFetch } from "./fetch.ts";
export { closeBrowser } from "./render.ts";
export type {
	FetchOpts,
	FetchResult,
	FetchStatus,
	Extracted,
	PageChrome,
	Landmark,
	TabInfo,
	Control,
	MdTable,
	CodeBlock,
} from "./types.ts";
