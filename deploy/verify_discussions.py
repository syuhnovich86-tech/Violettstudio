import sqlite3

database = sqlite3.connect("/data/app/vita29.db")
print(database.execute("select version_num from alembic_version").fetchone()[0])
tables = {
    row[0]
    for row in database.execute(
        "select name from sqlite_master where type = 'table'"
    )
}
required = {"discussion", "discussion_message", "notification"}
print("tables=ok" if required <= tables else f"tables=missing:{required - tables}")
