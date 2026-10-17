"""Shared test helpers."""

import glob
import os
import shutil
import subprocess
from contextlib import contextmanager

import pytest

from app import auth


@pytest.fixture(autouse=True)
def _fresh_sign_in_checks():
    """Every test starts with no remembered sign-in checks (app/auth.py keeps passed ones for CHECKED_FOR seconds)."""
    auth._checked.clear()
    yield
    auth._checked.clear()


def pg_bin(name: str) -> str | None:
    found = shutil.which(name) or sorted(glob.glob(f"/usr/lib/postgresql/*/bin/{name}"))
    return found if isinstance(found, str) else (found[-1] if found else None)


@contextmanager
def throwaway_postgres(root):
    """A real Postgres in a temporary folder, reachable only through a socket there (no port, so it can't clash with
    another Postgres). Yields its DSN and is deleted afterwards. Skips the test without the Postgres server programs
    (sudo apt install postgresql)."""
    initdb, pg_ctl = pg_bin("initdb"), pg_bin("pg_ctl")
    if not (initdb and pg_ctl):
        if os.environ.get("REQUIRE_POSTGRES"):  # CI: a skipped real-SQL test would hide a broken query
            pytest.fail("REQUIRE_POSTGRES is set but initdb / pg_ctl were not found")
        pytest.skip("Postgres is not installed (sudo apt install postgresql); the real-SQL tests are skipped")
    datadir, sock = root / "data", root / "sock"
    sock.mkdir()
    subprocess.run([initdb, "-D", str(datadir), "-U", "postgres", "-A", "trust", "--no-sync"],
                   check=True, capture_output=True)
    subprocess.run([pg_ctl, "-D", str(datadir), "-l", str(root / "log"), "-w", "start",
                    "-o", f"-k {sock} -c listen_addresses='' -F"], check=True, capture_output=True)
    try:
        yield f"postgresql://postgres@/postgres?host={sock}"
    finally:
        subprocess.run([pg_ctl, "-D", str(datadir), "-m", "immediate", "stop"], capture_output=True)
