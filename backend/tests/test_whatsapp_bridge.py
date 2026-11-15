import httpx
import pytest

from vita29.content.whatsapp_stories import WhatsAppBridge, WhatsAppNotPublishedError, WhatsAppUncertainError


class BrokenClient:
    def __init__(self, *args, **kwargs): pass
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def request(self, *args, **kwargs): raise httpx.ReadTimeout('timeout')


def test_publication_timeout_is_uncertain_and_not_retried(monkeypatch, tmp_path):
    monkeypatch.setattr(httpx, 'Client', BrokenClient)
    bridge = WhatsAppBridge(tmp_path / 'bridge.sock')
    with pytest.raises(WhatsAppUncertainError):
        bridge.request('POST', '/publish', json={'id': 'publication-id'})
    with pytest.raises(WhatsAppNotPublishedError):
        bridge.request('GET', '/status')
    with pytest.raises(ValueError):
        bridge.request('GET', 'http://example.com/')


def test_send_failure_and_partial_send_do_not_blindly_retry(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from vita29.content import whatsapp_stories as whatsapp
    from vita29.db.models import MediaType

    file = tmp_path / 'photo.jpg'
    file.write_bytes(b'test')
    monkeypatch.setattr(whatsapp, '_prepare_media', lambda *args: (file, 0))
    calls = []

    def fake_request(self, method, path, *, json=None):
        calls.append(json['id'])
        if len(calls) == 1:
            return {'outcome': 'sent', 'id': 'confirmed-1'}
        raise WhatsAppNotPublishedError('not sent')

    monkeypatch.setattr(whatsapp.WhatsAppBridge, 'request', fake_request)
    publication = SimpleNamespace(id='publication', external_id=None)
    media = SimpleNamespace(media_type=MediaType.IMAGE)
    settings = SimpleNamespace(integration_secrets_path=tmp_path / 'secrets')
    db = SimpleNamespace(commit=lambda: None)
    with pytest.raises(WhatsAppUncertainError):
        whatsapp.publish_whatsapp_stories(db, settings, publication, 'caption', [media, media])
    assert calls == ['publication:0', 'publication:1']
    assert 'confirmed-1' in publication.external_id


def test_whatsapp_qr_is_admin_only_and_never_cached(client, tmp_path, monkeypatch):
    from tests.test_media import add_user, sign_in, sign_out
    from vita29.db.models import UserRole
    from vita29.api import whatsapp_story_login

    add_user(tmp_path / 'test.db', 'whatsapp-admin', UserRole.OWNER)
    add_user(tmp_path / 'test.db', 'whatsapp-user', UserRole.EMPLOYEE)
    monkeypatch.setattr(whatsapp_story_login.WhatsAppBridge, 'request', lambda self, method, path: {'status': 'waiting', 'qr': 'pair-secret'})
    csrf = sign_in(client, 'whatsapp-user')
    assert client.get('/api/v1/integrations/whatsapp-story/status').status_code == 403
    assert client.post('/api/v1/integrations/whatsapp-story/start', headers={'X-CSRF-Token': csrf}).status_code == 403
    sign_out(client, csrf)
    sign_in(client, 'whatsapp-admin')
    result = client.get('/api/v1/integrations/whatsapp-story/status')
    assert result.status_code == 200
    assert result.headers['cache-control'] == 'no-store'
    assert result.json()['qr'].startswith('data:image/png;base64,')
    assert 'pair-secret' not in result.text


def test_whatsapp_is_separate_story_only_target(client, tmp_path):
    from datetime import UTC, datetime, timedelta
    from tests.test_media import add_user, sign_in
    from vita29.db.models import UserRole

    add_user(tmp_path / 'test.db', 'whatsapp-editor', UserRole.OWNER)
    csrf = sign_in(client, 'whatsapp-editor')
    payload = {'title': 'Статус', 'scheduled_at': (datetime.now(UTC) + timedelta(days=1)).isoformat(), 'platforms': ['telegram', 'whatsapp_studio'], 'platform_formats': {'telegram': 'post', 'whatsapp_studio': 'story'}}
    created = client.post('/api/v1/content/items', json=payload, headers={'X-CSRF-Token': csrf})
    assert created.status_code == 201, created.text
    assert {(item['platform'], item['publication_format']) for item in created.json()['publications']} == {('telegram', 'post'), ('whatsapp_studio', 'story')}
    payload['platform_formats']['whatsapp_studio'] = 'post'
    assert client.post('/api/v1/content/items', json=payload, headers={'X-CSRF-Token': csrf}).status_code == 422
