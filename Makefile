NODE ?= node

.PHONY: help test validate serve format init

help:            ## list the available commands
	@grep -E "^[a-z-]+:.*##" $(MAKEFILE_LIST) | sed "s/:.*##/ -/"

test:            ## run the tests: importers, command line, data checks and the browser smoke test
	$(NODE) --test tests/*.test.mjs

validate:        ## check data/ for errors and suspicious entries
	$(NODE) catalog.js validate

serve:           ## open the app at http://localhost:8000/
	$(NODE) catalog.js serve

format:          ## rewrite data/*.json in the canonical layout
	$(NODE) catalog.js format

init:            ## create your own (git-ignored) data files, empty
	$(NODE) catalog.js init
