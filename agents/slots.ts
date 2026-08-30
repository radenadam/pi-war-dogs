/**
 * Concurrency slots: how many agents may be WORKING at once under one
 * owner (the session, or a parent agent). Beyond the cap a run is
 * recorded as "queued" and its build waits here for a slot; the receipt
 * says so, and list/status show the state. Queueing rather than refusing
 * means a fan-out of twelve is one message and the tool serialises it.
 *
 * The budget is OWNED, not copied (the research's fan-out rule): each
 * owner has one counter, and a slot is released exactly once, at settle,
 * gated by rec.slotHeld.
 */

interface Owner {
	active: number;
	queue: { grant: () => void; signal?: AbortSignal }[];
}

const owners = new Map<string, Owner>();

function ownerOf(key: string): Owner {
	let o = owners.get(key);
	if (!o) owners.set(key, (o = { active: 0, queue: [] }));
	return o;
}

/** Working agents under this owner right now (for the receipt's "behind N"). */
export function activeCount(key: string): number {
	return ownerOf(key).active;
}

/** True when a run started now would queue. */
export function wouldQueue(key: string, cap: number): boolean {
	return ownerOf(key).active >= Math.max(1, cap);
}

/**
 * Acquire a slot, waiting when the owner is at cap. Resolves false when
 * the signal aborts first (the run was stopped while queued).
 */
export function acquireSlot(key: string, cap: number, signal?: AbortSignal): Promise<boolean> {
	const o = ownerOf(key);
	if (o.active < Math.max(1, cap)) {
		o.active++;
		return Promise.resolve(true);
	}
	return new Promise<boolean>((resolve) => {
		const entry = {
			grant: () => {
				signal?.removeEventListener("abort", onAbort);
				o.active++;
				resolve(true);
			},
			signal,
		};
		const onAbort = () => {
			const i = o.queue.indexOf(entry);
			if (i >= 0) o.queue.splice(i, 1);
			resolve(false);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		o.queue.push(entry);
	});
}

/** Release a slot and hand it to the next queued run, if any. */
export function releaseSlot(key: string): void {
	const o = ownerOf(key);
	o.active = Math.max(0, o.active - 1);
	const next = o.queue.shift();
	if (next) next.grant();
}
