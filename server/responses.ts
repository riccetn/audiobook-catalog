// What the server's routes (proxy.ts, sync.ts, worker.ts) answer with: JSON, and the CORS headers for the page asking.

/**
 * The CORS headers for an allowed origin (none for a request without one, as from curl).
 */
export function corsHeaders(origin: string | null): Record<string, string> {
	return origin
		? {'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'Retry-After', Vary: 'Origin'}
		: {Vary: 'Origin'};
}

/**
 * A JSON answer, never cached.
 */
export function jsonResponse(status: number, body: unknown, headers: Record<string, string>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'},
	});
}
