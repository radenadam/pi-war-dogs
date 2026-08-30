/**
 * The user's interrupt, named the way pi's bash names it ("Command aborted").
 * pi's loop checks the steer queue and the abort only between tool calls, so
 * a tool that ignores its signal keeps the turn alive until it returns —
 * webfetch outlived an Esc by the whole fetch (2026-08-29 audit). Every
 * war-dogs tool that can take time races its work against the signal and
 * answers with one honest line; the work already in flight finishes on its
 * own and its result is dropped.
 */
export function raceAbort<T>(
	work: Promise<T>,
	signal: AbortSignal | undefined,
	text: string | (() => string),
): Promise<T> {
	const say = () => new Error(typeof text === "function" ? text() : text);
	if (!signal) return work;
	if (signal.aborted) return Promise.reject(say());
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(say());
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(v) => {
				signal.removeEventListener("abort", onAbort);
				resolve(v);
			},
			(e) => {
				signal.removeEventListener("abort", onAbort);
				reject(e);
			},
		);
	});
}
