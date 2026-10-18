from __future__ import annotations

import argparse
import hashlib
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description="Restore a PostgreSQL custom-format backup into the Compose database")
    parser.add_argument("backup", type=Path)
    parser.add_argument("--confirm-overwrite", action="store_true", help="Required because matching tables and data will be replaced")
    args = parser.parse_args()
    if not args.confirm_overwrite:
        raise SystemExit("Restore can replace existing tables. Re-run with --confirm-overwrite after verifying the backup.")
    if not args.backup.is_file():
        raise SystemExit(f"Backup not found: {args.backup}")
    checksum_path = args.backup.with_suffix(args.backup.suffix + ".sha256")
    if not checksum_path.is_file():
        raise SystemExit(f"Backup checksum file not found: {checksum_path}")
    expected_digest = checksum_path.read_text(encoding="ascii").split()[0]
    digest_state = hashlib.sha256()
    with args.backup.open("rb") as backup:
        for chunk in iter(lambda: backup.read(1024 * 1024), b""):
            digest_state.update(chunk)
    actual_digest = digest_state.hexdigest()
    if actual_digest != expected_digest:
        raise SystemExit("Backup checksum does not match; refusing to restore.")

    command = [
        "docker", "compose", "exec", "-T", "db", "sh", "-c",
        'exec pg_restore --clean --if-exists --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
    ]
    with args.backup.open("rb") as backup:
        result = subprocess.run(command, cwd=ROOT, stdin=backup, capture_output=True)
    if result.returncode:
        raise SystemExit(result.stderr.decode(errors="replace") or "PostgreSQL restore failed.")
    print(f"Restore completed from {args.backup}.")


if __name__ == "__main__":
    main()
