.PHONY: test
test:
	cd server && uv run pytest
	@if [ -f web/package.json ]; then npm --prefix web test; fi
