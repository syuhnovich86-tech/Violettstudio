"""Persist observed follower counts, without inventing historical data."""
from datetime import UTC, datetime, timedelta
from sqlalchemy import text
from vita29.integrations.store import config_value


def record_and_compare(session_factory, settings, data, days, now=None):
    now = now or datetime.now(UTC)
    with session_factory() as db:
        db.execute(text('CREATE TABLE IF NOT EXISTS analytics_follower_snapshots (platform VARCHAR(32) NOT NULL, account_id VARCHAR(255) NOT NULL, observed_at VARCHAR(40) NOT NULL, followers BIGINT NOT NULL, PRIMARY KEY (platform, account_id, observed_at))'))
        for name, item in data.items():
            if item.get('status') not in ('ok', 'limited'):
                continue
            value = item.get('followers')
            if isinstance(value, dict):
                value = value.get('current')
            def telegram_account():
                try:
                    from vita29.api.telegram_story_login import telegram_credentials
                    return telegram_credentials(settings)[3]
                except Exception:
                    return config_value(settings, 'telegram_channel')
            account = {'telegram': telegram_account, 'instagram': lambda: config_value(settings, 'instagram_account_id'), 'max': lambda: config_value(settings, 'max_channel_id'), 'vk': lambda: config_value(settings, 'vk_group_id'), 'threads': lambda: item.get('account_id')}.get(name, lambda: None)()
            if not account or not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
                continue
            # One observation per hour; stable account identifier prevents mixing accounts.
            item_now = now
            if item.get('source') == 'vk_bridge':
                try:
                    item_now = datetime.fromisoformat(item['updated_at'])
                except (KeyError, TypeError, ValueError):
                    continue
            observed = item_now.replace(minute=0, second=0, microsecond=0).isoformat()
            db.execute(text('INSERT INTO analytics_follower_snapshots (platform, account_id, observed_at, followers) VALUES (:p,:a,:t,:v) ON CONFLICT (platform, account_id, observed_at) DO UPDATE SET followers=excluded.followers'), {'p': name, 'a': str(account), 't': observed, 'v': int(value)})
            target = item_now - timedelta(days=days)
            baseline = db.execute(text('SELECT observed_at, followers FROM analytics_follower_snapshots WHERE platform=:p AND account_id=:a AND observed_at <= :t ORDER BY observed_at DESC LIMIT 1'), {'p': name, 'a': str(account), 't': target.isoformat()}).first()
            # A missing interval cannot be represented as an exact period comparison.
            if baseline and datetime.fromisoformat(baseline.observed_at) >= target - timedelta(hours=30):
                difference = int(value) - baseline.followers
                item['follower_change'] = {'count': difference, 'percent': difference * 100 / baseline.followers if baseline.followers else None, 'baseline_at': baseline.observed_at}
            else:
                item['follower_change'] = None
            rows = db.execute(text('SELECT observed_at, followers FROM analytics_follower_snapshots WHERE platform=:p AND account_id=:a AND observed_at >= :t ORDER BY observed_at'), {'p': name, 'a': str(account), 't': target.isoformat()}).all()
            item['follower_history'] = [{'time': int(datetime.fromisoformat(row.observed_at).timestamp() * 1000), 'value': row.followers} for row in rows]
        db.commit()

