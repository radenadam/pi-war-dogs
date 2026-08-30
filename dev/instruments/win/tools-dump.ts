// A throwaway pi extension for the rig: writes the active tool set, every
// registered tool name and the agent tool's `tools` enum to $TOOLS_OUT from a
// delayed session_start (`get_state` does not carry the tool list). Load it
// with `-e <this file>`.
import * as fs from "node:fs";
const out = process.env.TOOLS_OUT || "";
export default function (pi: any) {
	pi.on("session_start", async () => {
		setTimeout(() => {
			if (!out) return;
			try {
				const defs = pi.getAllTools?.() ?? [];
				const agent = defs.find((d: any) => d?.name === "agent");
				const props = agent?.parameters?.properties ?? {};
				const toolsEnum = props.tools?.items?.enum ?? props.tools?.items?.anyOf?.map((x: any) => x.const) ?? null;
				fs.writeFileSync(
					out,
					JSON.stringify({
						active: pi.getActiveTools(),
						all: defs.map((t: any) => t?.name ?? t),
						agentToolsEnum: toolsEnum,
					}),
				);
			} catch (e: any) {
				fs.writeFileSync(out + ".err", String(e?.stack ?? e));
			}
		}, 2500);
	});
}
