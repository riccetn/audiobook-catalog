# The Makefile's commands for Windows, where make is usually missing: .\make.ps1 test, typecheck, serve or help.
# Keep the two in step: a command added to one belongs in the other.
param(
	[ValidateSet('help', 'test', 'typecheck', 'serve')]
	[string]$Command = 'help',
	[int]$Port = 8000
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
		'test      - run the tests: the catalog classes and the browser smoke test'
		'typecheck - check the JavaScript against its JSDoc types with TypeScript (run `npm install` once first; nothing is compiled)'
		'serve     - open the app at http://localhost:8000/ (serves public/; -Port for another port)'
	}
	'test' {
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
	'serve' {
		# Windows usually has the py launcher or python rather than python3.
		$python = @('py', 'python3', 'python') | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
		if (-not $python) {
			Write-Host 'Python is not installed: any static server for public/ works too'
			exit 1
		}
		Invoke-Native $python @('-m', 'http.server', "$Port", '--bind', '127.0.0.1', '--directory', 'public')
	}
}
