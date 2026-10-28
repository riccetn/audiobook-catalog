NODE ?= node
PORT ?= 8000
TSC ?= node_modules/.bin/tsc
ESLINT ?= node_modules/.bin/eslint
PRETTIER ?= node_modules/.bin/prettier
TYPEDOC ?= api-docs/node_modules/.bin/typedoc
API_DOCS ?= api-docs/out

.PHONY: help check pages test typecheck lint format format-check docs serve deploy-proxy

help:            ## list the available commands
	@grep -E "^[a-z-]+:.*##" $(MAKEFILE_LIST) | sed "s/:.*##/ -/"

check: test typecheck lint format-check   ## run everything CI runs: the tests, the type check, lint and the format check

pages:           ## write the pages into public/ from the Liquid templates in templates/ (run `npm install` once first)
	@test -d node_modules/liquidjs || { echo 'Liquid is not installed: run npm install first'; exit 1; }
	$(NODE) build.mjs

test: pages      ## run the tests: the catalog classes and the browser smoke test
	$(NODE) --experimental-vm-modules --test tests/*.test.mjs

typecheck:       ## check the JavaScript against its JSDoc types with TypeScript (run `npm install` once first; nothing is compiled)
	@test -x $(TSC) || { echo 'TypeScript is not installed: run npm install first'; exit 1; }
	$(TSC) -p jsconfig.json
	$(TSC) -p jsconfig.sw.json

lint:            ## check the JavaScript for likely mistakes with ESLint (run `npm install` once first)
	@test -x $(ESLINT) || { echo 'ESLint is not installed: run npm install first'; exit 1; }
	$(ESLINT) .

format:          ## format the code, JSON, Markdown and YAML with Prettier (the pre-commit hook does this to what you commit)
	@test -x $(PRETTIER) || { echo 'Prettier is not installed: run npm install first'; exit 1; }
	$(PRETTIER) --write .

format-check:    ## check that everything is formatted as Prettier would (run `make format` to fix it)
	@test -x $(PRETTIER) || { echo 'Prettier is not installed: run npm install first'; exit 1; }
	$(PRETTIER) --check .

docs:            ## write the API documentation from the code's JSDoc into api-docs/out/ with TypeDoc (run `npm install` once first)
	@test -x $(TYPEDOC) || { echo 'TypeDoc is not installed: run npm install first'; exit 1; }
	$(TYPEDOC) --options api-docs/typedoc.json --out $(API_DOCS)

serve: pages     ## open the app at http://localhost:8000/ (serves public/; any static server works, but the pages are ES modules, so not from a file)
	python3 -m http.server $(PORT) --bind 127.0.0.1 --directory public

deploy-proxy:    ## deploy the catalog proxy to Cloudflare with its sync database (proxy/deploy.mjs; npx wrangler login once first)
	$(NODE) proxy/deploy.mjs
