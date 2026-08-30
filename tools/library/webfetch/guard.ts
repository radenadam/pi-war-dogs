/**
 * SSRF / scheme guard. The tool fetches agent-supplied URLs, and an agent can be
 * steered (e.g. by prompt injection in previously-fetched content) into choosing
 * the URL — so it must not be able to reach the local disk, loopback, cloud
 * metadata, or the internal network.
 *
 * Three layers:
 *   - guardUrl(url): async pre-flight check — rejects non-http(s) schemes,
 *     denylisted hostnames, WHATWG bad ports, and hosts that resolve to a
 *     private/reserved address. Advisory in the rebinding sense (the transport
 *     resolves again), but it is what produces the typed
 *     "blocked-by-policy: …" refusals.
 *   - guardedLookup(): ENFORCEMENT for the static tier — installed as the
 *     undici Agent's connect-time DNS lookup, so the addresses checked ARE the
 *     addresses dialled. A rebinding flip between a guard check and the
 *     connect cannot slip through, because there is no second resolution.
 *   - isRequestHostBlockedSync(url): fast per-request check for Playwright
 *     route interception — catches literal private IPs and bad ports on
 *     page-initiated subresources without a DNS round-trip.
 *
 * Redirects on the render tier are NOT a special case of the above: a route
 * handler fires once per request and never again for a 30x Chrome follows
 * itself, so render.ts owns the chain and calls guardUrl() on every Location
 * before taking it (see dev/internals/README.md's load-bearing note).
 *
 * Remaining limitation — documented, not closed: the render tier's Chrome
 * resolves DNS itself and cannot be pinned from here, so its guardUrl checks
 * (TTL-bounded per host in render.ts) narrow but do not close the rebinding
 * window. Chrome's own restricted-port list still applies. Full closure means
 * a guarding proxy in front of the daemon Chrome — a structural change to
 * propose, not a patch to slip in here.
 */

import { lookup as lookupCb } from "node:dns";
import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface GuardResult {
	ok: boolean;
	reason?: string;
}

const BLOCKED_HOSTNAMES = /(^|\.)(localhost|local|internal|localdomain)$/i;

/**
 * The WHATWG fetch "bad ports" — non-HTTP service ports (SMTP, IRC, X11, …)
 * that browsers refuse, copied verbatim from the installed undici's own list
 * so the guard and the transport can never disagree. undici and Chrome both
 * enforce this themselves; checking it here too turns a cryptic
 * "fetch failed" into a typed blocked-by-policy refusal BEFORE any transport
 * runs (and before tier:auto pointlessly escalates a bad-port static failure
 * into Chrome). Ordinary web ports (80, 443, 8080, 3000, …) are unaffected.
 */
const BLOCKED_PORTS = new Set([
	1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
	111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
	540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
	6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

function blockedPort(u: URL): number | null {
	if (!u.port) return null; // default port for the scheme
	const n = Number(u.port);
	return BLOCKED_PORTS.has(n) ? n : null;
}

function isPrivateV4(ip: string): boolean {
	const p = ip.split(".").map(Number);
	if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → deny
	const [a, b] = p;
	if (a === 127) return true; // loopback 127/8
	if (a === 10) return true; // private 10/8
	if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
	if (a === 192 && b === 168) return true; // private 192.168/16
	if (a === 169 && b === 254) return true; // link-local 169.254/16 (incl. cloud metadata)
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
	if (a === 0) return true; // 0/8 "this" network
	if (a >= 224) return true; // multicast/reserved 224+
	if (a === 192 && b === 0) return true; // 192.0.0.0/24 reserved
	if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
	return false;
}

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or null if it does not
 * parse. Textual matching is not enough here: the WHATWG URL parser NORMALISES
 * `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so a regex looking for the dotted
 * form saw a plain hex address and every v4-mapped private target walked
 * straight through the guard (audit-demonstrated: `http://[::ffff:7f00:1]:PORT`
 * reached loopback). Everything below therefore works on the parsed groups.
 */
function v6Groups(ip: string): number[] | null {
	let s = ip.toLowerCase().trim();
	const zone = s.indexOf("%"); // fe80::1%eth0 — the zone id is not part of the address
	if (zone >= 0) s = s.slice(0, zone);
	// A trailing dotted quad (::ffff:127.0.0.1) is two hex groups.
	const dotted = s.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/);
	if (dotted) {
		const p = dotted[2].split(".").map(Number);
		if (p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
		s = `${dotted[1]}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
	}
	const halves = s.split("::");
	if (halves.length > 2) return null;
	const parse = (part: string): number[] | null => {
		if (!part) return [];
		const out: number[] = [];
		for (const g of part.split(":")) {
			if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
			out.push(parseInt(g, 16));
		}
		return out;
	};
	const head = parse(halves[0]);
	const tail = halves.length === 2 ? parse(halves[1]) : [];
	if (!head || !tail) return null;
	if (halves.length === 2) {
		const fill = 8 - head.length - tail.length;
		if (fill < 0) return null;
		return [...head, ...new Array<number>(fill).fill(0), ...tail];
	}
	return head.length === 8 ? head : null;
}

/** The dotted v4 address carried in two 16-bit groups. */
function dottedV4(hi: number, lo: number): string {
	return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isPrivateV6(ip: string): boolean {
	const g = v6Groups(ip);
	if (!g) return true; // unparseable → deny (fail closed)
	const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
	if (zeros(7) && g[7] === 1) return true; // ::1 loopback
	if (zeros(8)) return true; // :: unspecified
	if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
	if ((g[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
	if ((g[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
	// A v4 address wearing a v6 hat: IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible
	// (::a.b.c.d) and IPv4-translated (::ffff:0:a.b.c.d) all put the real target in
	// the low 32 bits. Judge that target with the v4 rules, whatever the spelling.
	if (zeros(4) && ((g[4] === 0 && (g[5] === 0xffff || g[5] === 0)) || (g[4] === 0xffff && g[5] === 0))) {
		return isPrivateV4(dottedV4(g[6], g[7]));
	}
	// NAT64 well-known prefix 64:ff9b::/96 — the v4 destination is the low 32 bits.
	if (g[0] === 0x0064 && g[1] === 0xff9b && zeroRange(g, 2, 6)) return isPrivateV4(dottedV4(g[6], g[7]));
	// 6to4 2002::/16 — the v4 address is groups 1-2.
	if (g[0] === 0x2002) return isPrivateV4(dottedV4(g[1], g[2]));
	return false;
}

function zeroRange(g: number[], from: number, to: number): boolean {
	for (let i = from; i < to; i++) if (g[i] !== 0) return false;
	return true;
}

/** True if an IP literal is loopback, private, link-local, or reserved. */
export function isPrivateIp(ip: string): boolean {
	const v = isIP(ip);
	if (v === 4) return isPrivateV4(ip);
	if (v === 6) return isPrivateV6(ip);
	return true; // not a valid IP → deny (fail closed)
}

/** Full validation for the entry URL. Resolves hostnames to catch DNS-based bypasses. */
export async function guardUrl(raw: string): Promise<GuardResult> {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return { ok: false, reason: "malformed URL" };
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") {
		return { ok: false, reason: `scheme not allowed (${u.protocol})` };
	}
	const badPort = blockedPort(u);
	if (badPort !== null) return { ok: false, reason: `blocked port (${badPort} is a non-HTTP service port)` };
	const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
	if (!host) return { ok: false, reason: "no host" };
	if (BLOCKED_HOSTNAMES.test(host)) return { ok: false, reason: `blocked host (${host})` };
	if (isIP(host)) {
		return isPrivateIp(host) ? { ok: false, reason: `private/reserved IP (${host})` } : { ok: true };
	}
	try {
		const addrs = await lookup(host, { all: true });
		if (!addrs.length) return { ok: false, reason: "host did not resolve" };
		for (const { address } of addrs) {
			if (isPrivateIp(address)) return { ok: false, reason: `host resolves to private IP (${address})` };
		}
	} catch (e) {
		return { ok: false, reason: `DNS resolution failed (${String((e as Error)?.message ?? e)})` };
	}
	return { ok: true };
}

/**
 * Fast synchronous check for route interception. Blocks non-http(s) schemes,
 * denylisted hostnames, and literal private IPs — the vectors reachable on
 * redirects and page-initiated subresources without a DNS round-trip.
 */
export function isRequestHostBlockedSync(rawUrl: string): boolean {
	try {
		const u = new URL(rawUrl);
		if (u.protocol !== "http:" && u.protocol !== "https:") return true;
		if (blockedPort(u) !== null) return true;
		const host = u.hostname.replace(/^\[|\]$/g, "");
		if (!host || BLOCKED_HOSTNAMES.test(host)) return true;
		if (isIP(host)) return isPrivateIp(host);
		return false; // hostnames validated async at entry; navigations re-checked in the route handler
	} catch {
		return true;
	}
}

/** Error code carried by a guardedLookup refusal, recognisable in a cause chain. */
export const POLICY_CODE = "EBLOCKEDBYPOLICY";

/**
 * Connect-time DNS lookup for the static tier's undici Agent — the
 * ENFORCEMENT layer. The transport connects only to addresses this function
 * returned, and it refuses if ANY resolved address is private/reserved (same
 * any-address policy as guardUrl), so resolution and connection are one event
 * and a rebinding flip between them is structurally impossible. IP-literal
 * hosts never reach a lookup (net.connect dials them directly); guardUrl
 * rejects the private ones up front on every hop.
 *
 * Shaped as node's net.LookupFunction: honours options.family and answers in
 * the form the caller asked for (all → LookupAddress[], else address+family).
 */
export function guardedLookup(
	hostname: string,
	options: LookupOptions,
	callback: (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void,
): void {
	lookupCb(hostname, { all: true }, (err, addresses) => {
		if (err) return callback(err);
		const wantFamily =
			options?.family === 4 || options?.family === "IPv4"
				? 4
				: options?.family === 6 || options?.family === "IPv6"
					? 6
					: 0;
		let list = addresses as LookupAddress[];
		if (wantFamily) list = list.filter((a) => a.family === wantFamily);
		if (!list.length) {
			const e: NodeJS.ErrnoException = new Error(`no address found for ${hostname}`);
			e.code = "ENOTFOUND";
			return callback(e);
		}
		for (const { address } of list) {
			if (isPrivateIp(address)) {
				const e: NodeJS.ErrnoException = new Error(`${hostname} resolves to private/reserved address ${address}`);
				e.code = POLICY_CODE;
				return callback(e);
			}
		}
		if (options?.all) return callback(null, list);
		callback(null, list[0].address, list[0].family);
	});
}

/**
 * The policy-refusal message inside an error's cause chain, or null. undici
 * wraps connect errors in TypeError("fetch failed", { cause }) — and node's
 * autoSelectFamily can wrap per-address failures in an AggregateError — so
 * both `cause` and `errors` are walked (probed against undici 8.10.0).
 */
export function policyBlockReason(err: unknown): string | null {
	const seen = new Set<unknown>();
	const walk = (e: unknown): string | null => {
		if (!e || typeof e !== "object" || seen.has(e)) return null;
		seen.add(e);
		const any = e as { code?: string; message?: string; cause?: unknown; errors?: unknown[] };
		if (any.code === POLICY_CODE) return any.message ?? "blocked by policy";
		if (any.cause) {
			const r = walk(any.cause);
			if (r) return r;
		}
		if (Array.isArray(any.errors)) {
			for (const sub of any.errors) {
				const r = walk(sub);
				if (r) return r;
			}
		}
		return null;
	};
	return walk(err);
}
