from pathlib import Path
import sqlite3

database_path = "/srv/vita29/app-data/vita29.db"
sql_path = "/tmp/grant_iphone_private_access.sql"

with sqlite3.connect(database_path) as connection:
    connection.executescript(Path(sql_path).read_text(encoding="utf-8"))
    connection.commit()
    membership = connection.execute(
        """
        SELECT w.display_name, u.login
        FROM workspace_members AS wm
        JOIN workspaces AS w ON w.id = wm.workspace_id
        JOIN users AS u ON u.id = wm.user_id
        WHERE w.id = ? AND u.login = ?
        """,
        ("2f2164b5-f545-4e18-ad9b-87fa12625b2f", "stepan"),
    ).fetchone()

print(membership)
