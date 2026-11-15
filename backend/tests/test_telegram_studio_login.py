import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from vita29.api import telegram_story_login as login
from vita29.content import telegram_stories
from vita29.db.models import UserRole
from tests.test_media import add_user, sign_in


def test_studio_login_saves_separate_session(monkeypatch):
    saved = []
    monkeypatch.setattr(login, 'write_secret', lambda settings, key, value: saved.append((key, value)))

    class Client:
        session = SimpleNamespace(save=lambda: 'studio-session')

        async def __call__(self, request):
            return None

        async def disconnect(self):
            pass

        async def get_me(self):
            return SimpleNamespace(bot=False, phone='79990001234')

    class QR:
        async def wait(self):
            pass

    attempt = {'status': 'waiting'}
    asyncio.run(login.finish_login(attempt, Client(), QR(), '', '', object(), 'studio'))
    assert attempt['status'] == 'connected'
    assert attempt['account_hint'] == '••••1234'
    assert saved == [('telegram_studio_story_session', 'studio-session')]


def test_old_qr_is_reported_as_expired(client, tmp_path):
    add_user(tmp_path / 'test.db', 'qr-admin', UserRole.OWNER)
    sign_in(client, 'qr-admin')
    response = client.get('/api/v1/integrations/telegram-story/status/old-attempt')
    assert response.status_code == 200
    assert response.json()['status'] == 'expired'
    assert response.headers['cache-control'] == 'no-store'


def test_disconnect_studio_keeps_channel_secret(monkeypatch):
    saved = []
    monkeypatch.setattr(login, 'write_secret', lambda settings, key, value: saved.append((key, value)))
    asyncio.run(login.disconnect(None, SimpleNamespace(id='admin'), object(), 'studio'))
    assert saved == [('telegram_studio_story_session', '')]


def test_studio_is_independent_story_target(client, tmp_path):
    add_user(tmp_path / 'test.db', 'studio-editor', UserRole.OWNER)
    csrf = sign_in(client, 'studio-editor')
    payload = {'title': 'История', 'scheduled_at': (datetime.now(UTC) + timedelta(days=1)).isoformat(), 'platforms': ['telegram', 'telegram_studio'], 'platform_formats': {'telegram': 'story', 'telegram_studio': 'story'}}
    created = client.post('/api/v1/content/items', json=payload, headers={'X-CSRF-Token': csrf})
    assert created.status_code == 201, created.text
    assert {(item['platform'], item['publication_format']) for item in created.json()['publications']} == {('telegram', 'story'), ('telegram_studio', 'story')}
    payload['platform_formats']['telegram_studio'] = 'post'
    assert client.post('/api/v1/content/items', json=payload, headers={'X-CSRF-Token': csrf}).status_code == 422


def test_studio_story_targets_account_and_not_existing_channel(monkeypatch):
    from pathlib import Path
    from vita29.db.models import MediaType
    from telethon import types
    seen = []
    monkeypatch.setattr(telegram_stories, 'telegram_account_credentials', lambda _: (123, 'hash'))
    monkeypatch.setattr(telegram_stories, 'read_secret', lambda settings, key, path, label: seen.append(key) or 'session')
    monkeypatch.setattr(telegram_stories, 'resolve_channel', lambda *args: (_ for _ in ()).throw(AssertionError('channel must not be used')))

    class Client:
        def __init__(self, *args, **kwargs): pass
        async def connect(self): pass
        async def disconnect(self): pass
        async def is_user_authorized(self): return True
        async def upload_file(self, path): return object()
        async def __call__(self, request):
            assert isinstance(request.peer, types.InputPeerSelf)
            if hasattr(request, 'random_id'):
                seen.append('sent-self')
                return SimpleNamespace(updates=[types.UpdateStoryID(id=42, random_id=request.random_id)])
            return None

    monkeypatch.setattr(telegram_stories, 'TelegramClient', Client)
    monkeypatch.setattr(telegram_stories, 'StringSession', lambda value: value)
    publication = SimpleNamespace(id='test', external_id=None)
    db = SimpleNamespace(commit=lambda: None)
    settings = SimpleNamespace(integration_secrets_path=Path('.'))
    result = asyncio.run(telegram_stories._send(db, settings, publication, 'text', [SimpleNamespace(media_type=MediaType.IMAGE)], [(Path('sample.jpg'), 0)], target='studio'))
    assert result == '[42]'
    assert seen == ['telegram_studio_story_session', 'sent-self']


def test_studio_submission_uses_independent_sender(client, tmp_path, monkeypatch):
    import json
    from sqlalchemy.orm import Session
    from vita29.db.session import create_database_engine
    from vita29.db.models import ContentItem, ContentPublication, ContentStatus
    from tests.test_media import jpeg_bytes
    from vita29.content import scheduled_delivery

    user, workspace = add_user(tmp_path / 'test.db', 'studio-publisher', UserRole.OWNER)
    csrf = sign_in(client, 'studio-publisher')
    uploaded = client.post(f'/api/v1/media?workspace_id={workspace.id}', headers={'X-CSRF-Token': csrf}, files={'upload': ('photo.jpg', jpeg_bytes(), 'image/jpeg')})
    assert uploaded.status_code == 201
    media_id = uploaded.json()['id']
    payload = {'title': 'История', 'scheduled_at': (datetime.now(UTC) + timedelta(days=1)).isoformat(), 'publication_date_assigned': False, 'platforms': ['telegram_studio'], 'media_ids': [media_id]}
    created = client.post('/api/v1/content/items', json=payload, headers={'X-CSRF-Token': csrf})
    assert created.status_code == 201, created.text
    item_id = created.json()['id']
    engine = create_database_engine(f"sqlite:///{tmp_path / 'test.db'}")
    with Session(engine) as db:
        item = db.get(ContentItem, item_id)
        item.status = ContentStatus.READY
        publication = db.query(ContentPublication).filter_by(content_item_id=item_id).one()
        publication.caption = 'Текст'
        publication.media_ids_json = json.dumps([media_id])
        db.commit()
    monkeypatch.setattr(scheduled_delivery, 'secret_is_configured', lambda *args: True)
    calls = []
    monkeypatch.setattr(scheduled_delivery, 'publish_telegram_stories', lambda *args, **kwargs: calls.append(kwargs['target']) or '[42]')
    monkeypatch.setattr(scheduled_delivery, 'snapshot_publication', lambda *args: None)
    with Session(engine) as db:
        item = db.get(ContentItem, item_id)
        publication = db.query(ContentPublication).filter_by(content_item_id=item_id).one()
        scheduled_delivery.publish_now(db, item, publication, db.get(type(user), user.id))
        assert publication.status.value == 'published'
    assert calls == ['studio']
