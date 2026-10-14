import sqlite3
from pathlib import Path


source_path = Path("/data/app/vita29.db")
backup_path = Path("/data/app/backups/pre-user-permissions-20260826.db")
backup_path.parent.mkdir(exist_ok=True)

source = sqlite3.connect(source_path)
integrity = source.execute("PRAGMA integrity_check").fetchone()[0]
if integrity != "ok":
    raise RuntimeError(f"Database integrity check failed: {integrity}")

target = sqlite3.connect(backup_path)
with target:
    source.backup(target)
target.close()
source.close()

print(f"backup={backup_path} integrity={integrity}")
