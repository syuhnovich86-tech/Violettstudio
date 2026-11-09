"""Explicit, read-only VK Bridge imports; values are reported by the administrator's client."""
import json
from datetime import UTC, datetime
from sqlalchemy import text

METRICS = ('reach', 'visitors', 'views', 'subscribed', 'unsubscribed', 'likes', 'comments', 'reposts')


def _init(db):
    db.execute(text('CREATE TABLE IF NOT EXISTS vk_bridge_snapshots (account_id VARCHAR(64) PRIMARY KEY, observed_at VARCHAR(40) NOT NULL, payload TEXT NOT NULL)'))


def save(db, account, payload):
    _init(db)
    observed = datetime.now(UTC).isoformat()
    db.execute(text('INSERT INTO vk_bridge_snapshots (account_id, observed_at, payload) VALUES (:a,:t,:p) ON CONFLICT (account_id) DO UPDATE SET observed_at=excluded.observed_at, payload=excluded.payload'), {'a': account, 't': observed, 'p': json.dumps(payload, ensure_ascii=False)})
    db.commit()
    return observed


def read(db, account, days):
    _init(db)
    row = db.execute(text('SELECT observed_at, payload FROM vk_bridge_snapshots WHERE account_id=:a'), {'a': account}).first()
    if not row:
        return None
    payload = json.loads(row.payload)
    period = payload['periods'].get(str(days))
    if not period:
        return None
    daily = payload.get('daily', [])
    cutoff = datetime.now(UTC).timestamp() - days * 86400
    charts = {key: [{'time': item['time'] * 1000, 'value': item[key]} for item in daily if item['time'] >= cutoff and item.get(key) is not None] for key in ('reach', 'visitors', 'views')}
    return {'status': 'limited', 'updated_at': row.observed_at, 'followers': payload.get('followers'),
            'stats': period, 'charts': charts, 'posts': [], 'posts_status': 'unavailable',
            'stats_status': 'ok', 'source': 'vk_bridge', 'message': 'Данные сохранены через мини-приложение VK; обновите их вручную для получения свежей статистики.'}
