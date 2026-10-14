import sqlite3
from pathlib import Path

backup_dir = Path("/data/app/backups")
backup_dir.mkdir(exist_ok=True)
source = sqlite3.connect("/data/app/vita29.db")
target = sqlite3.connect(backup_dir / "pre-discussions-20260822.db")
with target:
    source.backup(target)
target.close()
source.close()
