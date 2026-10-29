// ESLint's recommended rules, and typescript-eslint's for the TypeScript (make lint). Formatting is left to Prettier;
// these catch mistakes.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** A parameter only named to document what an override gets starts with _ (FileImporter.readRow). */
const UNUSED = ['error', {argsIgnorePattern: '^_'}];

export default [
	// What make pages compiles from src/ and make docs writes, and the library make pages copies from node_modules.
	{ignores: ['public/', 'api-docs/out/']},
	js.configs.recommended,
	{rules: {'no-unused-vars': UNUSED}},
	...tseslint.configs.recommended.map(config => ({...config, files: ['**/*.ts', '**/*.mts']})),
	{
		files: ['**/*.ts', '**/*.mts'],
		rules: {
			'@typescript-eslint/no-unused-vars': UNUSED,
			// `any` stays where the code means "whatever this holds" (a stored record, a catalog's answer), as it did in
			// the JSDoc types before; the type check still checks everything around it.
			'@typescript-eslint/no-explicit-any': 'off',
		},
	},
	{files: ['src/**/*.ts'], languageOptions: {globals: globals.browser}},
	{files: ['src/sw.ts'], languageOptions: {globals: globals.serviceworker}},
	// The app's server runs as a Cloudflare Worker, whose globals are a service worker's; its .mjs files run in Node.
	{files: ['server/**/*.ts'], languageOptions: {globals: globals.serviceworker}},
	{
		files: ['tests/**/*.mjs', 'build.mjs', 'server/**/*.mjs', 'eslint.config.js'],
		languageOptions: {globals: globals.node},
	},
];
