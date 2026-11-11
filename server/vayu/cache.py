"""Content cache on disk, keyed by namespace and a hash of the caller's key."""
import hashlib
import os
import time
from collections.abc import Callable

from vayu import config


def cached_bytes(
    namespace: str, key: str, fetch: Callable[[], bytes], ttl_s: float | None = None
) -> bytes:
    """Return the cached bytes for `key`, calling `fetch` on a miss or after `ttl_s` seconds.

    `ttl_s=None` means the entry never expires. Nothing is stored if `fetch` raises.
    """
    path = config.data_dir() / "cache" / namespace / hashlib.sha1(key.encode()).hexdigest()
    if path.is_file() and (ttl_s is None or time.time() - path.stat().st_mtime < ttl_s):
        return path.read_bytes()
    data = fetch()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)
    return data
