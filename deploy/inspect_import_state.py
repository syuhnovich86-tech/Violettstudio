import sqlite3


database = sqlite3.connect("/data/app/vita29.db")

print("USERS")
for row in database.execute(
    "select id, display_name, login, role from users order by display_name"
):
    print("|".join(map(str, row)))

print("WORKSPACES")
for row in database.execute(
    "select id, display_name, kind, owner_id from workspaces order by kind desc, display_name"
):
    print("|".join(map(str, row)))
