# One-command workflow. Ports are overridable: make dev API_PORT=8010 WEB_PORT=5183
API_PORT ?= 8000
WEB_PORT ?= 5173
EPISODE ?= 2025-11-03 2025-11-09

.PHONY: setup dev test validate build

# Python deps (with dev extra), web deps, and the EDGAR inventory if it is not there yet.
setup:
	cd server && uv sync --extra dev
	npm --prefix web ci
	@cd server && uv run python -c 'import sys; from vayu.emissions import inventory as i; sys.exit(0 if all((i._inventory_dir() / f).is_file() for f in i.source_files()) else 1)' \
		&& echo "EDGAR inventory present" \
		|| uv run python scripts/fetch_inventory.py

# API and Vite together; Ctrl-C stops both.
dev:
	@trap 'kill 0' INT TERM EXIT; \
	(cd server && uv run uvicorn vayu.api:app --port $(API_PORT)) & \
	VAYU_API_PORT=$(API_PORT) npm --prefix web run dev -- --port $(WEB_PORT) & \
	sleep 2; echo ""; echo "  Open http://localhost:$(WEB_PORT)  (API on port $(API_PORT); Ctrl-C stops both)"; echo ""; \
	wait

test:
	cd server && uv run --extra dev pytest
	@if [ -f web/package.json ]; then npm --prefix web test; fi

# Model vs CPCB measurements for the validation episode; writes server/data/validation.json and
# docs/validation/<YYYY-MM>.md. Builds any run that is not stored yet (about a minute each).
validate:
	cd server && uv run python -m vayu.validate $(EPISODE)

build:
	npm --prefix web run build
