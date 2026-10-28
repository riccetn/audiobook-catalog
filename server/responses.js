// What the server's routes (proxy.js, sync.js, worker.js) answer with: JSON, and the CORS headers for the page asking.

/**
 * The CORS headers for an allowed origin (none for a request without one, as from curl).
 * @param {string | null} origin
 * @returns {Record<string, string>}
 */
export function corsHeaders(origin) {
	return origin
		? {'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'Retry-After', Vary: 'Origin'}
		: {Vary: 'Origin'};
}

/**
 * A JSON answer, never cached.
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} headers
 * @returns {Response}
 */
export function jsonResponse(status, body, headers) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'},
	});
}
