NODE ?= node
PORT ?= 8000

.PHONY: help test serve

help:            ## list the available commands
	@grep -E "^[a-z-]+:.*##" $(MAKEFILE_LIST) | sed "s/:.*##/ -/"

test:            ## run the tests: importers, data checks and the browser smoke test
	$(NODE) --experimental-vm-modules --test tests/*.test.mjs

serve:           ## open the app at http://localhost:8000/ (serves public/; any static server works, but the pages are ES modules, so not from a file)
	python3 -m http.server $(PORT) --bind 127.0.0.1 --directory public
