/**
 * The typed boundary to the bundled adapter. `pi-mcp-adapter` publishes its
 * TypeScript SOURCE as its types entry, so a bare import would make our tsc
 * typecheck the adapter's whole tree under OUR flags — its own tsconfig
 * differs, and one stray error there would fail our gate for nothing (jiti
 * runs it untyped either way). tsconfig.json `paths` maps the specifier here
 * instead; only what mcp/index.ts actually touches is declared.
 */
declare module "pi-mcp-adapter" {
	import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
	export interface McpAdapterOptions {
		configPath?: string;
		config?: unknown;
	}
	export function createMcpAdapter(options?: McpAdapterOptions): (pi: ExtensionAPI) => void;
	/** A server definition as the adapter's mcp.json takes it (stdio here; the adapter's own types.ts has the rest). */
	export interface ServerEntry {
		command?: string;
		args?: string[];
		env?: Record<string, string>;
		[key: string]: unknown;
	}
	export interface McpServerRegistration {
		dispose(): Promise<void>;
	}
	/**
	 * A runtime, never-persisted server on the adapter installed for `pi` (the
	 * object the factory was invoked with — a WeakMap key, so it must be the
	 * SAME object). Throws `MCP server "<name>" is already registered` when a
	 * configured server of that name exists.
	 */
	export function registerMcpServer(options: {
		pi: ExtensionAPI;
		name: string;
		definition: ServerEntry;
	}): McpServerRegistration;
	const mcpAdapter: (pi: ExtensionAPI) => void;
	export default mcpAdapter;
}
