"""Shared exception types."""


class SetupError(RuntimeError):
    """The installation is incomplete (a key or a download is missing). The message says how to
    fix it, contains no secret, and is shown to the user verbatim."""


class UpstreamError(Exception):
    """An upstream data service failed or returned something unusable."""

    def __init__(self, service: str, message: str):
        super().__init__(f"{service}: {message}")
        self.service = service
        self.message = message
