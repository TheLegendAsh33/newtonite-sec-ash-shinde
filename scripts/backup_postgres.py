from __future__ import annotations

import hashlib
import subprocess
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKUP_DIR = ROOT / "backups"


def main() -> None:
    BACKUP_DIR.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = BACKUP_DIR / f"newtonite-{stamp}.dump"
    temporary_path = path.with_suffix(path.suffix + ".part")
    command = [
        "docker", "compose", "exec", "-T", "db", "sh", "-c",
        'exec pg_dump --format=custom --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
    ]
    with temporary_path.open("wb") as output:
        result = subprocess.run(command, cwd=ROOT, stdout=output, stderr=subprocess.PIPE)
    if result.returncode:
        temporary_path.unlink(missing_ok=True)
        raise SystemExit(result.stderr.decode(errors="replace") or "PostgreSQL backup failed.")
    temporary_path.replace(path)
    digest_state = hashlib.sha256()
    with path.open("rb") as backup:
        for chunk in iter(lambda: backup.read(1024 * 1024), b""):
            digest_state.update(chunk)
    digest = digest_state.hexdigest()
    path.with_suffix(path.suffix + ".sha256").write_text(f"{digest}  {path.name}\n", encoding="ascii")
    print(f"Backup saved: {path}")
    print(f"SHA-256: {digest}")


if __name__ == "__main__":
    main()
