import sqlite3

connection = sqlite3.connect("/data/app/vita29.db")
print("workspaces", list(connection.execute("select kind, count(*) from workspaces group by kind")))
print("media", list(connection.execute("select workspace_id, count(*), sum(location_key is not null) from media_files where deleted_at is null group by workspace_id")))
query = """
select
    media.location_country,
    media.location_city,
    media.location_key,
    count(*)
from media_files as media
join workspaces as workspace on workspace.id = media.workspace_id
where workspace.kind = 'PRIVATE' and media.deleted_at is null
group by 1, 2, 3
order by 4 desc
limit 100
"""
for row in connection.execute(query):
    print(repr(row))
