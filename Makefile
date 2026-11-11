# One-command workflow. Ports are overridable: make dev API_PORT=8010 WEB_PORT=5183
API_PORT ?= 8000
WEB_PORT ?= 5173
EPISODE ?= 2025-11-03 2025-11-09

.PHONY: setup dev test validate build

# Python deps (with dev extra), web deps, and the EDGAR inventory if it is not there yet.
setup:
	cd server && uv sync --extra dev
	npm --prefix web ci
	cd server && uv run python scripts/fetch_inventory.py --if-missing

# API and Vite together; Ctrl-C stops both. If either one exits (e.g. its port is busy), the
# other is stopped and make fails.
dev:
	@stop() { trap - INT TERM EXIT; kill $$api $$web 2>/dev/null; wait 2>/dev/null; }; \
	trap 'stop; exit 130' INT TERM; trap stop EXIT; \
	(cd server && exec uv run uvicorn vayu.api:app --port $(API_PORT)) & api=$$!; \
	(cd web && VAYU_API_PORT=$(API_PORT) exec ./node_modules/.bin/vite --port $(WEB_PORT)) & web=$$!; \
	sleep 2; echo ""; echo "  Open http://localhost:$(WEB_PORT)  (API on port $(API_PORT); Ctrl-C stops both)"; echo ""; \
	while kill -0 $$api 2>/dev/null && kill -0 $$web 2>/dev/null; do sleep 1; done; \
	echo "make dev: the API or the web server exited (port in use?); stopping the other" >&2; exit 1

test:
	cd server && uv run --extra dev pytest
	@if [ -f web/package.json ]; then npm --prefix web test; fi

# Model vs CPCB measurements for the validation episode; writes server/data/validation.json and
# docs/validation/<YYYY-MM>.md. Builds any run that is not stored yet (about a minute each).
validate:
	cd server && uv run python -m vayu.validate $(EPISODE)

build:
	npm --prefix web run build
