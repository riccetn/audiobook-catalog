PY ?= python3

.PHONY: help test validate serve format init

help:            ## list the available commands
	@grep -E "^[a-z-]+:.*##" $(MAKEFILE_LIST) | sed "s/:.*##/ -/"

test:            ## run the Python tests, the JS importer tests and the browser smoke test
	$(PY) -m unittest discover -s tests -t .
	@if command -v node >/dev/null; then node --test tests/app.smoke.test.mjs tests/importers.test.mjs; else echo "node not found: skipped the JS tests"; fi

validate:        ## check data/ for errors and suspicious entries
	$(PY) -m catalog validate

serve:           ## open the app at http://localhost:8000/
	$(PY) -m http.server 8000 --bind 127.0.0.1

format:          ## rewrite data/*.json in the canonical layout
	$(PY) -m catalog format

init:            ## create your own (git-ignored) data files, empty
	$(PY) -m catalog init
