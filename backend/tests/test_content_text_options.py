import base64
import io
import json
from contextlib import nullcontext

import httpx
from PIL import Image
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


@pytest.mark.parametrize("suffix", [", не крупно, внизу генерации", ", мелким шрифтом", "\nРасположить внизу"])
def test_banner_layout_notes_are_not_printed(suffix):
    offer = "Лазерное удаление и ремувер со скидкой 50%, 27 ноября"
    assert visual._campaign_copy("", "Написать: " + offer + suffix) == (offer, True)
    assert visual._campaign_copy("", "Напиши «Запись внизу, мелко»" + suffix) == ("Запись внизу, мелко", True)


@pytest.mark.parametrize("count, note, endpoint", [
    (0, "Сделай светлый баннер.", "generations"),
    (1, "Обработай фото.", "edits"),
    (2, "Оформи акцию.", "edits"),
    (2, "Коллаж до после.", "generations"),
])
def test_all_artwork_text_uses_image_api(tmp_path, monkeypatch, count, note, endpoint):
    item = SimpleNamespace(id="item", title="ПМ СЕКРЕТНОЕ НАЗВАНИЕ", no_title_on_image=True, visual_style="dark")
    settings = Settings(media_root=tmp_path / "media")
    sources = []
    for i, color in enumerate(["red", "blue"][:count]):
        key = f"qa/{i}.jpg"
        path = settings.originals_path / key
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (120, 40), color).save(path)
        sources.append(SimpleNamespace(id=str(i), media_type=visual.MediaType.IMAGE, storage_key=key))
    encoded = io.BytesIO()
    Image.new("RGB", (300, 450), "green").save(encoded, format="JPEG")
    calls = []

    def post(url, **kwargs):
        calls.append((url, kwargs))
        return httpx.Response(200, request=httpx.Request("POST", url),
                              json={"data": [{"b64_json": base64.b64encode(encoded.getvalue()).decode()}]})

    monkeypatch.setattr(visual, "openai_ipv4_client", lambda *args: nullcontext(SimpleNamespace(post=post)))
    monkeypatch.setattr(visual, "read_openai_secret", lambda *args: "fixture")
    monkeypatch.setattr(visual, "config_value", lambda cfg, name, default: "false" if name == "openai_native_visuals" else default)
    monkeypatch.setattr(visual, "_save_generated_image", lambda db, cfg, item, actor, note, image: image)
    note += " Написать: Скидка 50%, 27 ноября, не крупно, внизу генерации"
    result = visual.generate_branded_visual(None, settings, item, "actor", note, sources, copy_hint="ЛИШНЯЯ ПОДПИСЬ",
                                            force_edit=count == 1)
    (url, payload), = calls
    assert url.endswith("/images/" + endpoint)
    prompt = (payload.get("json") or payload["data"])["prompt"]
    assert "«Скидка 50%, 27 ноября»" in prompt
    assert "СЕКРЕТНОЕ НАЗВАНИЕ" not in prompt and "ЛИШНЯЯ ПОДПИСЬ" not in prompt
    assert "Do not add or render the letters" in prompt
    if count == 2 and endpoint == "generations":
        assert "files" not in payload and "bottom 28%" in prompt
        with Image.open(io.BytesIO(result)) as image:
            first, second = image.getpixel((150, 80)), image.getpixel((150, 230))
            assert first[0] > 220 and first[2] < 25
            assert second[2] > 220 and second[0] < 25
            assert image.getpixel((150, 400))[1] > 100
    else:
        assert result == encoded.getvalue()
        assert len(payload.get("files", [])) == count


def test_image_api_failure_never_saves_a_template(monkeypatch):
    item = SimpleNamespace(id="item", title="Акция", no_title_on_image=False)
    monkeypatch.setattr(visual, "read_openai_secret", lambda *args: "fixture")
    def post(url, **kwargs):
        return httpx.Response(503, request=httpx.Request("POST", url))
    monkeypatch.setattr(visual, "openai_ipv4_client", lambda *a: nullcontext(SimpleNamespace(post=post)))
    monkeypatch.setattr(visual, "_save_generated_image", lambda *a: pytest.fail("Unexpected image save"))
    with pytest.raises(agent.ContentAgentError):
        visual.generate_branded_visual(None, Settings(), item, "actor", "Надпись: Запись открыта", [])


def test_native_visual_prompt_does_not_request_unwanted_pm():
    prompt = visual._native_visual_prompt('Брови', 'Сделай светлый фон', has_source=True, force_edit=True, style='light')
    assert 'Do not add or render the letters' in prompt
    requested = visual._native_visual_prompt('Брови', 'Надпись: пм', has_source=True, force_edit=True, style='light')
    assert 'Exact editor request: Надпись: ПМ' in requested
