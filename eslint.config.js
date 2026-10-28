// ESLint's recommended rules (make lint). Formatting is left to .editorconfig; these catch mistakes.
import js from '@eslint/js';
import globals from 'globals';

export default [
	// What make docs writes, and the library make pages copies from node_modules.
	{ignores: ['api-docs/out/', 'public/vendor/']},
	js.configs.recommended,
	{
		rules: {
			// A parameter only named to document what an override gets starts with _ (Importer.readRow).
			'no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
		},
	},
	{files: ['public/**/*.js'], languageOptions: {globals: globals.browser}},
	{files: ['public/sw.js'], languageOptions: {globals: globals.serviceworker}},
	// The app's server runs as a Cloudflare Worker, whose globals are a service worker's; its .mjs files run in Node.
	{files: ['server/**/*.js'], languageOptions: {globals: globals.serviceworker}},
	{
		files: ['tests/**/*.mjs', 'build.mjs', 'server/**/*.mjs', 'eslint.config.js'],
		languageOptions: {globals: globals.node},
	},
];
