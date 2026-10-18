// ESLint's recommended rules (make lint). Formatting is left to .editorconfig; these catch mistakes.
import js from '@eslint/js';
import globals from 'globals';

export default [
	js.configs.recommended,
	{
		rules: {
			// A catch that ignores its error, a parameter a subclass's override uses, and a key taken out of
			// `...rest` to leave it behind are on purpose.
			'no-unused-vars': ['error', {args: 'none', caughtErrors: 'none', ignoreRestSiblings: true}],
			'no-empty': ['error', {allowEmptyCatch: true}],
		},
	},
	{files: ['public/**/*.js'], languageOptions: {globals: globals.browser}},
	{files: ['public/sw.js'], languageOptions: {globals: globals.serviceworker}},
	{files: ['tests/**/*.mjs', 'eslint.config.js'], languageOptions: {globals: globals.node}},
];
