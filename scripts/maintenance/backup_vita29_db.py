import sqlite3
from datetime import datetime
from pathlib import Path

source = sqlite3.connect("/data/app/vita29.db")
target_path = Path("/data/app") / f"vita29-before-private-publication-{datetime.now():%Y%m%d-%H%M%S}.db"
target = sqlite3.connect(target_path)
with target:
    source.backup(target)
target.close()
source.close()
print(target_path)
