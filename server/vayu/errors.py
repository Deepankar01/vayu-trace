"""Shared exception types."""


class UpstreamError(Exception):
    """An upstream data service failed or returned something unusable."""

    def __init__(self, service: str, message: str):
        super().__init__(f"{service}: {message}")
        self.service = service
        self.message = message
