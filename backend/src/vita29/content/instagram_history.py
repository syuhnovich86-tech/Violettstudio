"""Store observed Instagram material statistics without manufacturing past values."""
import json
from datetime import UTC, datetime, timedelta
from sqlalchemy import text


def merge_instagram_media(db, account, media, days, now=None):
    now = now or datetime.now(UTC)
    db.execute(text('CREATE TABLE IF NOT EXISTS analytics_instagram_media (account_id VARCHAR(64) NOT NULL, media_id VARCHAR(128) NOT NULL, published_at VARCHAR(40) NOT NULL, observed_at VARCHAR(40) NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (account_id, media_id))'))
    for item in media:
        mid, published = item.get('id'), item.get('timestamp')
        if not mid or not published:
            continue
        existing = db.execute(text('SELECT payload FROM analytics_instagram_media WHERE account_id=:a AND media_id=:m'), {'a': account, 'm': str(mid)}).first()
        old = json.loads(existing.payload) if existing else {}
        merged = {**old, **{k: v for k, v in item.items() if v is not None}}
        if item.get('insights'):
            merged['insights_observed_at'] = now.isoformat()
        elif old.get('insights'):
            merged['insights'] = old['insights']
            merged['insights_observed_at'] = old.get('insights_observed_at')
        db.execute(text('INSERT INTO analytics_instagram_media (account_id,media_id,published_at,observed_at,payload) VALUES (:a,:m,:p,:t,:d) ON CONFLICT (account_id,media_id) DO UPDATE SET published_at=excluded.published_at, observed_at=excluded.observed_at, payload=excluded.payload'), {'a': account, 'm': str(mid), 'p': published, 't': now.isoformat(), 'd': json.dumps(merged, ensure_ascii=False)})
        item.update(merged)
    current_ids = {str(item.get('id')) for item in media}
    cutoff = now - timedelta(days=days)
    for row in db.execute(text('SELECT media_id,payload FROM analytics_instagram_media WHERE account_id=:a'), {'a': account}):
        if row.media_id in current_ids:
            continue
        item = json.loads(row.payload)
        try:
            published = datetime.fromisoformat(item['timestamp'].replace('Z', '+00:00'))
        except (KeyError, TypeError, ValueError):
            continue
        if cutoff <= published <= now:
            item['cached'] = True
            media.append(item)
    db.commit()
    return media
