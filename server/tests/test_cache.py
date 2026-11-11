import os
import time

import pytest

from vayu import cache


def test_cache_hits_once():
    calls = []

    def fetch():
        calls.append(1)
        return b"data"

    assert cache.cached_bytes("ns", "k", fetch) == b"data"
    assert cache.cached_bytes("ns", "k", fetch) == b"data"
    assert len(calls) == 1


def test_ttl_expiry_refetches(tmp_path):
    cache.cached_bytes("ns", "k", lambda: b"old", ttl_s=60)
    (path,) = (tmp_path / "cache" / "ns").iterdir()
    old = time.time() - 120
    os.utime(path, (old, old))
    assert cache.cached_bytes("ns", "k", lambda: b"new", ttl_s=60) == b"new"
    assert cache.cached_bytes("ns", "k", lambda: b"newer", ttl_s=60) == b"new"


def test_no_ttl_never_expires(tmp_path):
    cache.cached_bytes("ns", "k", lambda: b"old")
    (path,) = (tmp_path / "cache" / "ns").iterdir()
    os.utime(path, (1, 1))
    assert cache.cached_bytes("ns", "k", lambda: b"new") == b"old"


def test_failed_fetch_is_not_cached():
    def boom():
        raise RuntimeError("x")

    with pytest.raises(RuntimeError):
        cache.cached_bytes("ns", "k", boom)
    assert cache.cached_bytes("ns", "k", lambda: b"ok") == b"ok"


def test_key_hashed_in_filename(tmp_path):
    cache.cached_bytes("ns", "secret-looking-key", lambda: b"x")
    (path,) = (tmp_path / "cache" / "ns").iterdir()
    assert "secret" not in path.name and len(path.name) == 40


def test_two_threads_racing_on_one_key_both_succeed(tmp_path):
    """Both writers miss together: each uses its own temp file, so neither replace fails and the
    stored file is one writer's complete body."""
    import threading

    body = b"x" * 2_000_000
    barrier = threading.Barrier(2)
    results, errors = [], []

    def fetch():
        barrier.wait(timeout=5)  # both threads are past the cache check
        return body

    def worker():
        try:
            results.append(cache.cached_bytes("ns", "race", fetch))
        except Exception as exc:  # noqa: BLE001 - collected for the assertion
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert results == [body, body]
    files = list((tmp_path / "cache" / "ns").iterdir())
    assert len(files) == 1 and files[0].read_bytes() == body
