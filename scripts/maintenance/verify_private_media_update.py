import sqlite3

database = sqlite3.connect("/data/app/vita29.db")
private_filter = """
media.workspace_id in (
    select id from workspaces where kind = 'PRIVATE'
)
and media.deleted_at is null
"""
blocked = database.execute(
    f"select count(*) from media_files as media where {private_filter} and publication_allowed = 0"
).fetchone()[0]
locations = database.execute(
    f"""
    select media.location_key, count(*)
    from media_files as media
    where {private_filter} and media.location_key is not null
    group by media.location_key
    order by count(*) desc
    limit 8
    """
).fetchall()
print("blocked_private", blocked)
print("top_locations", locations)
