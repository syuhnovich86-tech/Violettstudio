import json
import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from vita29.api import content_analytics as api
from vita29.auth.dependencies import require_csrf
from vita29.db.session import get_db
from vita29.settings import get_settings
from vita29.content.instagram_history import merge_instagram_media
from vita29.content.vk_snapshots import read
import httpx


def test_bridge_import_requires_one_time_code(monkeypatch):
    engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    factory = sessionmaker(bind=engine)
    app = FastAPI()
    app.include_router(api.router)
    app.dependency_overrides[require_csrf] = lambda: SimpleNamespace()
    app.dependency_overrides[api.require_analytics] = lambda: SimpleNamespace(id='admin')
    app.dependency_overrides[get_settings] = lambda: SimpleNamespace()
    def database():
        with factory() as db:
            yield db
    app.dependency_overrides[get_db] = database
    monkeypatch.setattr(api, 'config_value', lambda *_: '123')
    client = TestClient(app)
    code = client.post('/content/analytics/vk-bridge/start').json()['code']
    payload = {'code': code, 'group': '123', 'followers': 100, 'periods': {str(n): {'reach': {'current': 20, 'previous': 10}} for n in (7, 30, 90)}, 'daily': []}
    assert client.post('/content/analytics/vk-bridge/import', json=payload).status_code == 200
    assert client.post('/content/analytics/vk-bridge/import', json=payload).status_code == 403
    with factory() as db:
        saved = read(db, '123', 30)
    assert saved['stats']['reach'] == {'current': 20, 'previous': 10}
    assert saved['followers'] == 100 and saved['source'] == 'vk_bridge'
    assert code not in json.dumps(saved)


def test_instagram_preserves_observed_insights_and_accounts():
    engine = create_engine('sqlite://')
    factory = sessionmaker(bind=engine)
    now = datetime.now(UTC)
    item = {'id': '1', 'timestamp': (now-timedelta(days=20)).isoformat(), 'insights': {'views': 50}}
    with factory() as db:
        merge_instagram_media(db, 'account-a', [item], 90, now)
        merged = merge_instagram_media(db, 'account-a', [{'id': '1', 'timestamp': item['timestamp'], 'insights_status': 'unavailable'}], 90, now)
        assert merged[0]['insights']['views'] == 50
        assert merged[0]['insights_observed_at'] == now.isoformat()
        assert merge_instagram_media(db, 'account-b', [], 90, now) == []
        assert merge_instagram_media(db, 'account-a', [], 7, now) == []
        assert merge_instagram_media(db, 'account-a', [], 90, now)[0]['cached']


def test_instagram_loads_additional_pages_within_selected_period(monkeypatch):
    now = datetime.now(UTC)
    calls = []
    def handler(request):
        calls.append(request)
        if request.url.path.endswith('/media'):
            old = request.url.params.get('after') == 'next'
            item = {'id': 'older' if old else 'recent', 'timestamp': (now-timedelta(days=50 if old else 2)).isoformat(), 'media_type': 'VIDEO', 'media_product_type': 'REELS'}
            return httpx.Response(200, json={'data': [item], 'paging': {} if old else {'next': 'opaque', 'cursors': {'after': 'next'}}})
        if request.url.path.endswith('/stories'):
            return httpx.Response(200, json={'data': []})
        if request.url.path.endswith('/insights'):
            return httpx.Response(200, json={'data': []})
        return httpx.Response(200, json={'followers_count': 10})
    real_client = httpx.AsyncClient
    monkeypatch.setattr(api.httpx, 'AsyncClient', lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    monkeypatch.setattr(api, 'config_value', lambda *_: '123')
    monkeypatch.setattr(api, 'read_secret', lambda *_: 'test')
    from vita29.db import session
    factory = sessionmaker(bind=create_engine('sqlite://'))
    monkeypatch.setattr(session, 'SessionLocal', factory)
    settings = SimpleNamespace(integration_secrets_path=__import__('pathlib').Path('.'))
    result = asyncio.run(api.instagram_overview(settings, 90))
    assert [item['id'] for item in result['media']] == ['recent', 'older']
    assert len([call for call in calls if call.url.path.endswith('/media')]) == 2
