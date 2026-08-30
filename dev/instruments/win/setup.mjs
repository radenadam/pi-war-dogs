// Builds the rig's private agent dirs under SCRATCH from the real one (auth,
// models-store; settings with war-dogs ON in `agent` and OFF in `agent-off`,
// theme canopy; war-dogs themes copied; the war-dogs folder linked in as a
// junction; pi's downloaded rg/fd copied when present) and the test image
// (a 64×64 magenta PNG whose name has a space). Your own settings, sessions
// and auth are never written. Re-runnable.
//
//   node dev/instruments/win/setup.mjs        [WD_SOURCE_AGENT=<agent dir>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execSync } from "node:child_process";
import { AGENT, AGENT_OFF, SCRATCH, WD } from "./rig.mjs";

const SOURCE =
	process.env.WD_SOURCE_AGENT || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
if (!fs.existsSync(path.join(SOURCE, "auth.json")))
	throw new Error("no auth.json in " + SOURCE + " (set WD_SOURCE_AGENT)");

function link(target, at) {
	if (fs.existsSync(at)) return;
	if (process.platform === "win32") execSync(`mklink /J "${at}" "${target}"`, { shell: "cmd.exe", stdio: "ignore" });
	else fs.symlinkSync(target, at);
}

function build(dir, enabled) {
	for (const d of [dir, path.join(dir, "extensions"), path.join(dir, "themes"), path.join(dir, "sessions")])
		fs.mkdirSync(d, { recursive: true });
	for (const f of ["auth.json", "models-store.json"])
		if (fs.existsSync(path.join(SOURCE, f))) fs.copyFileSync(path.join(SOURCE, f), path.join(dir, f));
	const s = JSON.parse(fs.readFileSync(path.join(SOURCE, "settings.json"), "utf8"));
	delete s.packages;
	s["war-dogs"] = { ...(s["war-dogs"] ?? {}), enabled };
	if (enabled) s["war-dogs"]._prevTheme = "dark";
	else delete s["war-dogs"]._prevTheme;
	s.theme = enabled ? "canopy" : "dark";
	fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(s, null, 2));
	for (const f of fs.readdirSync(path.join(WD, "visual", "theme")))
		if (f.endsWith(".json")) fs.copyFileSync(path.join(WD, "visual", "theme", f), path.join(dir, "themes", f));
	link(WD, path.join(dir, "extensions", "war-dogs"));
	const bin = path.join(SOURCE, "bin");
	if (fs.existsSync(bin) && !fs.existsSync(path.join(dir, "bin")))
		fs.cpSync(bin, path.join(dir, "bin"), { recursive: true });
}

/** A solid PNG (RGB, 8-bit), written by hand so no image tool is needed. */
function png(w, h, [r, g, b]) {
	const crcTable = [];
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		crcTable.push(c >>> 0);
	}
	const crc = (buf) => {
		let c = 0xffffffff;
		for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const c = Buffer.alloc(4);
		c.writeUInt32BE(crc(td));
		return Buffer.concat([len, td, c]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const rowBytes = Buffer.alloc(1 + w * 3);
	for (let x = 0; x < w; x++) {
		rowBytes[1 + x * 3] = r;
		rowBytes[2 + x * 3] = g;
		rowBytes[3 + x * 3] = b;
	}
	const rawData = Buffer.concat(Array.from({ length: h }, () => rowBytes));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(rawData)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

fs.mkdirSync(SCRATCH, { recursive: true });
build(AGENT, true);
build(AGENT_OFF, false);
fs.writeFileSync(path.join(SCRATCH, "my shot.png"), png(64, 64, [255, 0, 255]));
console.log("rig ready under " + SCRATCH + " (source agent dir: " + SOURCE + ")");
