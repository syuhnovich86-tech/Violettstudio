import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from tests.test_media import PASSWORD, add_user, jpeg_bytes, sign_in
from vita29.content import agent, scheduled_delivery, visual
from vita29.db.models import ContentItem, ContentPublication, ContentStatus, User, UserRole, Workspace, WorkspaceKind
from vita29.db.session import create_database_engine
from vita29.settings import Settings


@pytest.mark.parametrize('auth', ['web', 'mobile'])
def test_no_caption_preparation_and_send(client, tmp_path, monkeypatch, auth):
    owner, _ = add_user(tmp_path / 'test.db', 'options-owner', UserRole.OWNER)
    engine = create_database_engine(f"sqlite:///{tmp_path / 'test.db'}")
    with Session(engine) as db:
        folder = Workspace(display_name='Фото', kind=WorkspaceKind.STUDIO, owner_id=owner.id)
        db.add(folder); db.commit(); folder_id = folder.id
    if auth == 'mobile':
        response = client.post('/api/v1/mobile/auth/login', json={'login': 'options-owner', 'password': PASSWORD})
        headers = {'Authorization': 'Bearer ' + response.json()['access_token']}
    else:
        headers = {'X-CSRF-Token': sign_in(client, 'options-owner')}
    uploaded = client.post(f'/api/v1/media?workspace_id={folder_id}&publication_allowed=true', headers=headers,
                           files={'upload': ('test.jpg', jpeg_bytes(), 'image/jpeg')})
    assert uploaded.status_code == 201, uploaded.text
    media_id = uploaded.json()['id']
    created = client.post('/api/v1/content/items', headers=headers, json={
        'title': 'Тема', 'caption': 'Старый текст', 'no_caption': True, 'no_title_on_image': True,
        'editor_instruction': 'Сделать светлый фон', 'scheduled_at': (datetime.now(UTC) + timedelta(days=1)).isoformat(),
        'publication_date_assigned': False, 'platforms': ['telegram'], 'media_ids': [media_id]})
    assert created.status_code == 201, created.text
    item_id = created.json()['id']
    assert created.json()['no_caption'] and created.json()['no_title_on_image']
    monkeypatch.setattr('vita29.api.content.prepare_telegram_draft', lambda *args: SimpleNamespace(caption='Лишний текст', media_ids=[media_id]))
    monkeypatch.setattr('vita29.api.content.generate_branded_visual', lambda *args, **kwargs: SimpleNamespace(id=media_id))
    prepared = client.post(f'/api/v1/content/items/{item_id}/prepare', headers=headers)
    assert prepared.status_code == 200, prepared.text
    assert prepared.json()['publications'][0]['caption'] is None
    sent = []
    monkeypatch.setattr(scheduled_delivery, '_status', lambda settings: SimpleNamespace(telegram=SimpleNamespace(configured=True)))
    monkeypatch.setattr(scheduled_delivery, 'snapshot_publication', lambda *args: None)
    monkeypatch.setattr(scheduled_delivery, 'publish_to_channel', lambda settings, caption, files: sent.append((caption, len(files))) or 'test-id')
    with Session(engine) as db:
        item = db.get(ContentItem, item_id)
        publication = db.scalar(select(ContentPublication).where(ContentPublication.content_item_id == item_id))
        scheduled_delivery.publish_now(db, item, publication, db.get(User, owner.id))
    assert sent == [('', 1)]


def test_agent_schema_does_not_ask_for_caption(tmp_path, monkeypatch):
    engine = create_database_engine(f"sqlite:///{tmp_path / 'agent.db'}")
    from vita29.db.models import Base
    Base.metadata.create_all(engine)
    item = ContentItem(title='Тема', no_caption=True, media_limit=1, media_ids_json='[]',
                       scheduled_at=datetime.now(UTC), availability_slots_json='[]')
    item.content_format = __import__('vita29.db.models', fromlist=['ContentFormat']).ContentFormat.POST
    seen = []
    class Response:
        def raise_for_status(self): pass
        def json(self): return {'output_text': json.dumps({'selected_media': []})}
    monkeypatch.setattr(agent, 'read_openai_secret', lambda settings: 'fixture')
    monkeypatch.setattr(agent, 'content_model', lambda settings: 'test-model')
    monkeypatch.setattr(agent, '_openai_post', lambda url, api_key, payload, timeout: seen.append(payload) or Response())
    with Session(engine) as db:
        draft = agent.prepare_telegram_draft(db, item, Settings())
    schema = seen[0]['text']['format']['schema']
    assert 'caption' not in schema['properties'] and 'caption' not in schema['required']
    assert draft.caption == ''


def test_prompt_only_collage_excludes_title_and_caption(monkeypatch):
    item = SimpleNamespace(id='item', title='СЕКРЕТНОЕ НАЗВАНИЕ', no_title_on_image=True, visual_style='auto')
    source = [SimpleNamespace(media_type=visual.MediaType.IMAGE), SimpleNamespace(media_type=visual.MediaType.IMAGE)]
    captured = []
    monkeypatch.setattr(visual, 'config_value', lambda *args: 'false')
    monkeypatch.setattr(visual, '_before_after_collage', lambda *args, **kwargs: captured.append((args, kwargs)) or b'image')
    monkeypatch.setattr(visual, '_save_generated_image', lambda db, settings, item, actor, instruction, image: image)
    result = visual.generate_branded_visual(None, None, item, 'actor', 'Коллаж до и после. Надпись: Привет', source, copy_hint='Чужая подпись')
    assert result == b'image'
    args, kwargs = captured[0]
    assert args[2] == '' and args[4] is None and kwargs['prompt_only'] is True
