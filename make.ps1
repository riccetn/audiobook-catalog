# The Makefile's commands for Windows, where make is usually missing: .\make.ps1 check, pages, test, typecheck, lint, format, format-check, docs, serve, deploy-server or help.
# Keep the two in step: a command added to one belongs in the other.
param(
	[ValidateSet('help', 'check', 'pages', 'test', 'typecheck', 'lint', 'format', 'format-check', 'docs', 'serve', 'deploy-server')]
	[string]$Command = 'help',
	[int]$Port = 8000,
	[string]$Bind = '127.0.0.1',
	[string]$Out = 'api-docs/out'
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# A native command's failure doesn't stop the script by itself, so check its exit code.
function Invoke-Native([string]$exe, [string[]]$arguments){
	& $exe @arguments
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Invoke-Prettier([string]$mode){
	$prettier = 'node_modules/prettier/bin/prettier.cjs'
	if (-not (Test-Path $prettier)) {
		Write-Host 'Prettier is not installed: run npm install first'
		exit 1
	}
	Invoke-Native 'node' @($prettier, $mode, '.')
}

switch ($Command) {
	'help' {
		'help          - list the available commands'
		'check         - run everything CI runs: the tests, the type check, lint and the format check'
		'pages         - write the pages into public/ from the Liquid templates in templates/ (run `npm install` once first)'
		'test          - run the tests: the catalog classes and the browser smoke test'
		'typecheck     - check the JavaScript against its JSDoc types with TypeScript (run `npm install` once first; nothing is compiled)'
		'lint          - check the JavaScript for likely mistakes with ESLint (run `npm install` once first)'
		'format        - format the code, JSON, Markdown and YAML with Prettier (the pre-commit hook does this to what you commit)'
		'format-check  - check that everything is formatted as Prettier would (format fixes it)'
		'docs          - write the API documentation from the code''s JSDoc into api-docs/out/ with TypeDoc (run `npm install` once first; -Out for another folder)'
		'serve         - open the app at http://localhost:8000/ with its server: the catalog proxy and sync, kept in SQLite (-Port, -Bind 0.0.0.0 for your network)'
		'deploy-server - deploy the app''s server to Cloudflare with its sync database, serving the pages too (npx wrangler login once first)'
	}
	'check' {
		# Each step runs this script again, and the first that fails stops the rest, as make does.
		foreach ($step in @('test', 'typecheck', 'lint', 'format-check')) {
			& $PSCommandPath $step
			if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
		}
	}
	'pages' {
		if (-not (Test-Path 'node_modules/liquidjs')) {
			Write-Host 'Liquid is not installed: run npm install first'
			exit 1
		}
		Invoke-Native 'node' @('build.mjs')
	}
	'test' {
		# The tests read the pages, so write them first, as make does.
		& $PSCommandPath pages
		if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
		# PowerShell doesn't expand the glob, and Node before 21 doesn't either, so list the suites here.
		$suites = Get-ChildItem tests -Filter '*.test.mjs' | ForEach-Object { 'tests/' + $_.Name }
		Invoke-Native 'node' (@('--experimental-vm-modules', '--test') + $suites)
	}
	'typecheck' {
		$tsc = 'node_modules/typescript/bin/tsc'
		if (-not (Test-Path $tsc)) {
			Write-Host 'TypeScript is not installed: run npm install first'
			exit 1
		}
		Invoke-Native 'node' @($tsc, '-p', 'jsconfig.json')
		Invoke-Native 'node' @($tsc, '-p', 'jsconfig.sw.json')
	}
	'lint' {
		$eslint = 'node_modules/eslint/bin/eslint.js'
		if (-not (Test-Path $eslint)) {
			Write-Host 'ESLint is not installed: run npm install first'
			exit 1
		}
		Invoke-Native 'node' @($eslint, '.')
	}
	'format' {
		Invoke-Prettier '--write'
	}
	'format-check' {
		Invoke-Prettier '--check'
	}
	'docs' {
		$typedoc = 'api-docs/node_modules/typedoc/bin/typedoc'
		if (-not (Test-Path $typedoc)) {
			Write-Host 'TypeDoc is not installed: run npm install first'
			exit 1
		}
		Invoke-Native 'node' @($typedoc, '--options', 'api-docs/typedoc.json', '--out', $Out)
	}
	'serve' {
		& $PSCommandPath pages
		if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
		$env:PORT = "$Port"
		$env:HOST = $Bind
		Invoke-Native 'node' @('--disable-warning=ExperimentalWarning', 'server/serve.mjs')
	}
	'deploy-server' {
		& $PSCommandPath pages
		if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
		Invoke-Native 'node' @('server/deploy.mjs')
	}
}
