.PHONY: test
test:
	cd server && uv run --extra dev pytest
	@if [ -f web/package.json ]; then npm --prefix web test; fi
