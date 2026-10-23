# The Makefile's commands for Windows, where make is usually missing: .\make.ps1 check, pages, test, typecheck, lint, docs, serve or help.
# Keep the two in step: a command added to one belongs in the other.
param(
	[ValidateSet('help', 'check', 'pages', 'test', 'typecheck', 'lint', 'docs', 'serve')]
	[string]$Command = 'help',
	[int]$Port = 8000,
	[string]$Out = 'api-docs/out'
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# A native command's failure doesn't stop the script by itself, so check its exit code.
function Invoke-Native([string]$exe, [string[]]$arguments){
	& $exe @arguments
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

switch ($Command) {
	'help' {
		'help      - list the available commands'
		'check     - run everything CI runs: the tests, the type check and lint'
		'pages     - write the pages into public/ from the Liquid templates in templates/ (run `npm install` once first)'
		'test      - run the tests: the catalog classes and the browser smoke test'
		'typecheck - check the JavaScript against its JSDoc types with TypeScript (run `npm install` once first; nothing is compiled)'
		'lint      - check the JavaScript for likely mistakes with ESLint (run `npm install` once first)'
		'docs      - write the API documentation from the code''s JSDoc into api-docs/out/ with TypeDoc (run `npm install` once first; -Out for another folder)'
		'serve     - open the app at http://localhost:8000/ (serves public/; -Port for another port)'
	}
	'check' {
		# Each step runs this script again, and the first that fails stops the rest, as make does.
		foreach ($step in @('test', 'typecheck', 'lint')) {
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
		# Windows usually has the py launcher or python rather than python3.
		$python = @('py', 'python3', 'python') | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
		if (-not $python) {
			Write-Host 'Python is not installed: any static server for public/ works too'
			exit 1
		}
		Invoke-Native $python @('-m', 'http.server', "$Port", '--bind', '127.0.0.1', '--directory', 'public')
	}
}
