PY ?= python3

.PHONY: help test validate build serve format init

help:            ## list the available commands
	@grep -E "^[a-z-]+:.*##" $(MAKEFILE_LIST) | sed "s/:.*##/ -/"

test: build     ## run the Python tests and the browser smoke test
	$(PY) -m unittest discover -s tests -t .
	@if command -v node >/dev/null; then node --test tests/app.smoke.test.mjs; else echo "node not found: skipped the browser smoke test"; fi

validate:        ## check data/ for errors and suspicious entries
	$(PY) -m catalog validate

build:           ## write dist/audiobook-catalog.html (single file, works offline)
	$(PY) -m catalog build

serve: build     ## preview at http://localhost:8000/audiobook-catalog.html
	$(PY) -m http.server 8000 --directory dist

format:          ## rewrite data/*.json in the canonical layout
	$(PY) -m catalog format

init:            ## create your own (git-ignored) data files, empty
	$(PY) -m catalog init
