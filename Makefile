NODE ?= node
PORT ?= 8000
HOST ?= 127.0.0.1
TSC ?= node_modules/.bin/tsc
ESLINT ?= node_modules/.bin/eslint
PRETTIER ?= node_modules/.bin/prettier
TYPEDOC ?= node_modules/.bin/typedoc
API_DOCS ?= api-docs/out

.PHONY: help check pages test typecheck lint format format-check docs serve deploy-server

help:            ## list the available commands
	@grep -E "^[a-z-]+:.*##" $(MAKEFILE_LIST) | sed "s/:.*##/ -/"

check: test typecheck lint format-check   ## run everything CI runs: the tests, the type check, lint and the format check

pages:           ## build public/: compile src/ with TypeScript, and write the pages from the Liquid templates in templates/ (run `npm install` once first)
	@test -d node_modules/liquidjs || { echo 'Liquid is not installed: run npm install first'; exit 1; }
	$(NODE) build.mjs

test: pages      ## run the tests: the catalog classes and the browser smoke test
	$(NODE) --experimental-vm-modules --enable-source-maps --test tests/*.test.mjs

typecheck:       ## check the types of the app (src/) and the server (server/) with TypeScript, writing nothing (run `npm install` once first)
	@test -x $(TSC) || { echo 'TypeScript is not installed: run npm install first'; exit 1; }
	$(TSC) -p tsconfig.json --noEmit
	$(TSC) -p tsconfig.sw.json --noEmit
	$(TSC) -p tsconfig.server.json

lint:            ## check the code for likely mistakes with ESLint and typescript-eslint (run `npm install` once first)
	@test -x $(ESLINT) || { echo 'ESLint is not installed: run npm install first'; exit 1; }
	$(ESLINT) .

format:          ## format the code, JSON, Markdown and YAML with Prettier (the pre-commit hook does this to what you commit)
	@test -x $(PRETTIER) || { echo 'Prettier is not installed: run npm install first'; exit 1; }
	$(PRETTIER) --write .

format-check:    ## check that everything is formatted as Prettier would (run `make format` to fix it)
	@test -x $(PRETTIER) || { echo 'Prettier is not installed: run npm install first'; exit 1; }
	$(PRETTIER) --check .

docs:            ## write the API documentation from the code's doc comments into api-docs/out/ with TypeDoc (run `npm install` once first)
	@test -x $(TYPEDOC) || { echo 'TypeDoc is not installed: run npm install first'; exit 1; }
	$(TYPEDOC) --options api-docs/typedoc.json --out $(API_DOCS)

serve: pages     ## open the app at http://localhost:8000/ with its server: the catalog proxy and sync, kept in SQLite (server/serve.mjs; HOST=0.0.0.0 for your network)
	PORT=$(PORT) HOST=$(HOST) $(NODE) --disable-warning=ExperimentalWarning server/serve.mjs

deploy-server: pages  ## deploy the app's server to Cloudflare with its sync database, serving the pages too (server/deploy.mjs; npx wrangler login once first)
	$(NODE) server/deploy.mjs
