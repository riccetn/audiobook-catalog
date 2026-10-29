// What makes a browser yours beside the catalog: your server, the sync passphrase and your keys for the catalogs,
// which are kept in each browser only (never in a backup). Import & export's Set up another device hands them to
// another device in one link, shown as a QR code; the phone's camera opens it, and the page asks before saving them.
// They travel after the # (`import.html#setup=…`), which a browser never sends to any server, as base64url JSON, so
// the link is plain ASCII and as short as a QR code can hold it.

import type {Unchecked} from './text.js';

/**
 * The settings a link hands over, each only when it was picked: the server's address and key, the sync passphrase,
 * and your keys by their catalog's key in ExternalCatalog (`hardcover`, `audiobookdb`).
 */
export type DeviceSettings = {server?: {url: string; key: string}; passphrase?: string; keys?: Record<string, string>};

/** Writes the settings into a link to the app, and reads them back out of the address it opens. */
export class DeviceSetup {
	/** The address's `#setup=` part holds the settings. */
	static HASH_KEY = 'setup';

	/**
	 * The link that hands `settings` to another device: `page` (the Import & export page's address) with them after the #.
	 */
	static link(page: string, settings: DeviceSettings): string {
		return `${page.replace(/#.*$/, '')}#${DeviceSetup.HASH_KEY}=${DeviceSetup.encode(settings)}`;
	}

	/**
	 * The settings an address's hash holds, or null when it holds none (or they can't be read). Values that aren't
	 * what their setting holds are left out, so a mangled link saves nothing wrong.
	 * @param hash `location.hash`, with or without its #
	 */
	static fromHash(hash: string): DeviceSettings | null {
		const prefix = `${DeviceSetup.HASH_KEY}=`;
		const text = hash.replace(/^#/, '');
		if (!text.startsWith(prefix)) return null;
		let v: Unchecked;
		try {
			v = DeviceSetup.decode(text.slice(prefix.length));
		} catch {
			return null;
		}
		if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
		const settings: DeviceSettings = {};
		const server = v.server;
		if (server && typeof server.url === 'string' && typeof server.key === 'string' && server.url && server.key)
			settings.server = {url: server.url, key: server.key};
		if (typeof v.passphrase === 'string' && v.passphrase) settings.passphrase = v.passphrase;
		if (v.keys && typeof v.keys === 'object' && !Array.isArray(v.keys)) {
			const keys = Object.entries(v.keys).filter(
				(entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
			);
			if (keys.length) settings.keys = Object.fromEntries(keys);
		}
		return DeviceSetup.isEmpty(settings) ? null : settings;
	}

	/**
	 * Whether `settings` hand over nothing.
	 */
	static isEmpty(settings: DeviceSettings): boolean {
		return !settings.server && !settings.passphrase && !Object.keys(settings.keys || {}).length;
	}

	/**
	 * `settings` as base64url JSON (UTF-8, so a passphrase may hold any letter).
	 */
	static encode(settings: DeviceSettings): string {
		let binary = '';
		for (const byte of new TextEncoder().encode(JSON.stringify(settings))) binary += String.fromCharCode(byte);
		return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}

	/**
	 * What `encode` wrote, parsed; throws when it isn't base64url JSON.
	 */
	static decode(text: string): Unchecked {
		const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
		const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
		return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
	}
}
