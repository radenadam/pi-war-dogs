/**
 * Open a file or URL with the platform's opener, and REPORT instead of
 * crashing when there is none (2026-08-30). `spawn` of a missing binary does
 * not throw: it returns a child with no pid and emits `error` a tick later,
 * and an `error` event with no listener is an uncaught exception — pi then
 * exits 1 with no session_shutdown (demonstrated: node, a bogus opener,
 * `UNCAUGHT: ENOENT`). So the child is listened to, and the caller gets
 * `{ ok: false, reason }` to put on the footer. xdg-open on Linux, `open`
 * on macOS, `cmd /c start "" <target>` on Windows (the empty string is
 * start's window title, so a quoted path is not taken for one); the
 * non-Linux commands are reasoned from their manuals, not yet driven.
 */
import { spawn } from "node:child_process";

export type OpenResult = { ok: boolean; reason?: string };

export function openExternal(target: string): Promise<OpenResult> {
	const [cmd, args]: [string, string[]] =
		process.platform === "win32"
			? ["cmd", ["/c", "start", "", target]]
			: process.platform === "darwin"
				? ["open", [target]]
				: ["xdg-open", [target]];
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(cmd, args, { detached: process.platform !== "win32", stdio: "ignore", windowsHide: true });
		} catch (e) {
			resolve({ ok: false, reason: String((e as Error)?.message ?? e) });
			return;
		}
		child.once("error", (e: Error) => resolve({ ok: false, reason: `${cmd}: ${e.message}` }));
		child.once("spawn", () => {
			child.unref();
			resolve({ ok: true });
		});
	});
}
