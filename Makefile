NODE ?= node
PORT ?= 8000
TSC ?= node_modules/.bin/tsc
ESLINT ?= node_modules/.bin/eslint

.PHONY: help check test typecheck lint serve

help:            ## list the available commands
	@grep -E "^[a-z-]+:.*##" $(MAKEFILE_LIST) | sed "s/:.*##/ -/"

check: test typecheck lint   ## run everything CI runs: the tests, the type check and lint

test:            ## run the tests: the catalog classes and the browser smoke test
	$(NODE) --experimental-vm-modules --test tests/*.test.mjs

typecheck:       ## check the JavaScript against its JSDoc types with TypeScript (run `npm install` once first; nothing is compiled)
	@test -x $(TSC) || { echo 'TypeScript is not installed: run npm install first'; exit 1; }
	$(TSC) -p jsconfig.json
	$(TSC) -p jsconfig.sw.json

lint:            ## check the JavaScript for likely mistakes with ESLint (run `npm install` once first)
	@test -x $(ESLINT) || { echo 'ESLint is not installed: run npm install first'; exit 1; }
	$(ESLINT) .

serve:           ## open the app at http://localhost:8000/ (serves public/; any static server works, but the pages are ES modules, so not from a file)
	python3 -m http.server $(PORT) --bind 127.0.0.1 --directory public
