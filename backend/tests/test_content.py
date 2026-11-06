import io
from datetime import UTC, datetime
from types import SimpleNamespace

from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy.orm import Session

from tests.test_auth import login, seed_user
from vita29.content.public_links import create_temporary_public_link, revoke_public_links
from vita29.content.visual import (
    _before_after_collage,
    _campaign_copy,
    _overlay_brand_caption,
    _visual_style,
    _wants_collage,
    append_editor_instruction,
)
from vita29.db.models import (
    ContentItem,
    ContentPublication,
    MediaFile,
    MediaType,
    PublicationPlatform,
    UserRole,
    Workspace,
    WorkspaceKind,
)
from vita29.db.session import create_database_engine
from vita29.settings import Settings


def test_weekly_content_plan_approval_and_platform_jobs(client: TestClient, tmp_path) -> None:
    seed_user(tmp_path / "test.db", role=UserRole.OWNER)
    csrf = login(client)
    created = client.post(
        "/api/v1/content/items",
        headers={"X-CSRF-Token": csrf},
        json={
            "title": "Результат до и после",
            "scheduled_at": "2026-11-03T10:00:00+03:00",
            "platforms": ["telegram", "max", "instagram"],
            "media_ids": [],
        },
    )
    assert created.status_code == 201
    item = created.json()
    assert item["status"] == "draft"
    assert all(publication["caption"] is None for publication in item["publications"])
    assert {publication["platform"] for publication in item["publications"]} == {
        "telegram",
        "max",
        "instagram",
    }

    listed = client.get("/api/v1/content/items?week_start=2026-11-02")
    assert listed.status_code == 200
    assert [entry["id"] for entry in listed.json()] == [item["id"]]

    review = client.patch(
        f"/api/v1/content/items/{item['id']}",
        headers={"X-CSRF-Token": csrf},
        json={"status": "review"},
    )
    assert review.status_code == 200
    assert review.json()["status"] == "review"

    approved = client.patch(
        f"/api/v1/content/items/{item['id']}",
        headers={"X-CSRF-Token": csrf},
        json={"status": "approved"},
    )
    assert approved.status_code == 200
    assert approved.json()["approved_by_id"] is not None

    deleted = client.delete(
        f"/api/v1/content/items/{item['id']}",
        headers={"X-CSRF-Token": csrf},
    )
    assert deleted.status_code == 204


def test_weekly_topics_can_be_created_in_one_request(client: TestClient, tmp_path) -> None:
    seed_user(tmp_path / "test.db", role=UserRole.OWNER)
    csrf = login(client)
    response = client.post(
        "/api/v1/content/items/bulk",
        headers={"X-CSRF-Token": csrf},
        json={
            "items": [
                {
                    "title": "Тема понедельника",
                    "scheduled_at": "2026-11-02T10:00:00+03:00",
                    "platforms": ["telegram", "max", "instagram"],
                },
                {
                    "title": "Тема вторника",
                    "scheduled_at": "2026-11-03T10:00:00+03:00",
                    "platforms": ["telegram", "max", "instagram"],
                },
            ]
        },
    )
    assert response.status_code == 201
    assert [item["title"] for item in response.json()] == ["Тема понедельника", "Тема вторника"]


def test_weekly_platform_formats_are_saved_and_max_rejects_reels(client: TestClient, tmp_path) -> None:
    seed_user(tmp_path / "test.db", role=UserRole.OWNER)
    csrf = login(client)
    entry = {"title": "Проверка форматов", "scheduled_at": "2030-11-03T10:00:00+03:00", "platforms": ["telegram", "max", "instagram"], "platform_formats": {"telegram": "post", "max": "post", "instagram": "reel"}}
    response = client.post("/api/v1/content/items/bulk", headers={"X-CSRF-Token": csrf}, json={"items": [entry]})
    assert response.status_code == 201
    item = response.json()[0]
    assert {p["platform"]: p["publication_format"] for p in item["publications"]} == {"telegram": "post", "max": "post", "instagram": "reel"}
    listed = client.get("/api/v1/content/items?week_start=2030-11-03").json()
    assert any(p["platform"] == "instagram" and p["publication_format"] == "reel" for saved in listed for p in saved["publications"])
    entry["platform_formats"]["max"] = "reel"
    assert client.post("/api/v1/content/items/bulk", headers={"X-CSRF-Token": csrf}, json={"items": [entry]}).status_code == 422


def test_prepare_returns_generated_text_and_image(client: TestClient, tmp_path, monkeypatch) -> None:
    seed_user(tmp_path / "test.db", role=UserRole.OWNER)
    csrf = login(client)
    created = client.post("/api/v1/content/items", headers={"X-CSRF-Token": csrf}, json={"title": "Тестовая публикация", "editor_instruction": "Создать фирменное изображение для публикации.", "scheduled_at": "2030-11-03T10:00:00+03:00", "platforms": ["telegram"], "media_ids": []}).json()
    calls = []
    monkeypatch.setattr("vita29.api.content.prepare_telegram_draft", lambda *args: SimpleNamespace(caption="Готовый текст", media_ids=[]))
    def fake_visual(*args, **kwargs):
        calls.append(kwargs.get("copy_hint"))
        return SimpleNamespace(id="generated-image-id")
    monkeypatch.setattr("vita29.api.content.generate_branded_visual", fake_visual)
    result = client.post(f"/api/v1/content/items/{created['id']}/prepare", headers={"X-CSRF-Token": csrf})
    assert result.status_code == 200
    assert result.json()["status"] == "ready"
    assert result.json()["publications"][0]["caption"] == "Готовый текст"
    assert result.json()["publications"][0]["media_ids"] == ["generated-image-id"]
    assert calls == ["Готовый текст"]


def test_selected_source_can_explicitly_request_ai_image_edit(client: TestClient, tmp_path, monkeypatch) -> None:
    """A retouch request is explicit, even without the word "generate"."""
    seed_user(tmp_path / "test.db", role=UserRole.OWNER)
    csrf = login(client)
    created = client.post(
        "/api/v1/content/items",
        headers={"X-CSRF-Token": csrf},
        json={
            "title": "Ретушь результата",
            "editor_instruction": "Убери маску и добавь чёрные перчатки.",
            "visual_edit_requested": True,
            "scheduled_at": "2030-11-03T10:00:00+03:00",
            "platforms": ["telegram"],
            "media_ids": [],
        },
    )
    assert created.status_code == 201
    assert created.json()["visual_edit_requested"] is True

    monkeypatch.setattr("vita29.api.content.prepare_telegram_draft", lambda *args: SimpleNamespace(caption="Текст", media_ids=[]))
    result = client.post(
        f"/api/v1/content/items/{created.json()['id']}/prepare",
        headers={"X-CSRF-Token": csrf},
    )
    assert result.status_code == 422
    assert "выберите хотя бы одно фото" in result.json()["detail"]


def test_instagram_delivery_link_is_public_only_while_it_is_not_revoked(client: TestClient, tmp_path) -> None:
    """Meta gets a bearer URL, but it never exposes the normal media routes."""
    user = seed_user(tmp_path / "test.db", role=UserRole.OWNER)
    engine = create_database_engine(f"sqlite:///{tmp_path / 'test.db'}")
    media_root = tmp_path / "media"
    source = media_root / "originals" / "generated" / "instagram-test.jpg"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"test-public-image")
    with Session(engine, expire_on_commit=False) as db:
        workspace = Workspace(display_name="Контент", kind=WorkspaceKind.STUDIO, owner_id=user.id)
        db.add(workspace)
        db.flush()
        media = MediaFile(
            owner_id=user.id, workspace_id=workspace.id, storage_key="generated/instagram-test.jpg",
            original_name="instagram-test.jpg", media_type=MediaType.IMAGE, mime_type="image/jpeg",
            size_bytes=source.stat().st_size, checksum_sha256="0" * 64, publication_allowed=True,
        )
        db.add(media)
        db.flush()
        item = ContentItem(
            title="Instagram test", scheduled_at=datetime(2030, 1, 1, tzinfo=UTC), created_by_id=user.id,
        )
        db.add(item)
        db.flush()
        publication = ContentPublication(content_item_id=item.id, platform=PublicationPlatform.INSTAGRAM)
        db.add(publication)
        db.flush()
        url = create_temporary_public_link(
            db, Settings(media_root=media_root), media, publication
        )
        db.commit()
        token_path = url.split("https://31-10-64-46.sslip.io", 1)[1]
        assert client.get(token_path).status_code == 200
        revoke_public_links(db, publication)
        db.commit()
        assert client.get(token_path).status_code == 404


def test_visual_uses_explicit_editor_labels_verbatim_without_inventing_copy() -> None:
    copy, is_explicit = _campaign_copy(
        "Тестовая публикация",
        "Добавить золотую надпись и подписи: Работа мастера Вероники, ваша студия Виолетта.",
    )
    assert is_explicit is True
    assert copy == "Работа мастера Вероники, ваша студия Виолетта."


def test_explicit_style_choice_never_depends_on_refinement_order() -> None:
    instruction = append_editor_instruction(
        "Тёмный баннер с золотыми акцентами.",
        "Сделай в белом стиле, коллаж из нескольких фото губ.",
    )
    assert _visual_style("Рекламный пост", instruction, requested_style="light") == "light"
    assert _visual_style("Рекламный пост", instruction, requested_style="dark") == "dark"
    assert _wants_collage("Рекламный пост", instruction) is True


def test_twenty_light_and_dark_visual_quality_checks_keep_the_requested_family(tmp_path) -> None:
    """Ten light and ten dark local render checks, with three collages each.

    The checks do not call an external image model: they validate the final,
    deterministic stage that protects the selected brand family after every
    model response.  Source photographs use distinct solid colours so a
    collage cannot silently drop the editor's selected media.
    """
    settings = Settings(media_root=tmp_path / "media")
    source_entries = []
    source_colours = [(224, 64, 55), (46, 144, 202), (77, 167, 108), (186, 92, 184)]
    for index, colour in enumerate(source_colours):
        key = f"qa/source-{index}.jpg"
        path = settings.originals_path / key
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (700, 900), colour).save(path, format="JPEG")
        source_entries.append(SimpleNamespace(storage_key=key))

    for style in ("light", "dark"):
        for number in range(10):
            if number in {2, 5, 8}:
                rendered = _before_after_collage(
                    source_entries[: 2 + (number % 2)],
                    settings,
                    "Коллаж результата процедуры",
                    "Коллаж из выбранных фото без замены результата.",
                    requested_style=style,
                )
            else:
                base = io.BytesIO()
                Image.new("RGB", (920, 1240), source_colours[number % len(source_colours)]).save(
                    base, format="JPEG"
                )
                rendered = _overlay_brand_caption(
                    base.getvalue(),
                    "Рекламный пост студии",
                    "Сохрани выбранный фирменный стиль.",
                    requested_style=style,
                )
            with Image.open(io.BytesIO(rendered)) as result:
                image = result.convert("RGB")
                assert image.size == (1080, 1350)
                corner = image.getpixel((1045, 1328))
                if style == "light":
                    assert sum(corner) / 3 > 175
                else:
                    assert sum(corner) / 3 < 75


def test_helper_phrase_does_not_leak_into_editor_brief() -> None:
    instruction = append_editor_instruction(
        "Скидка 30% на перманент губ. Создать фирменное изображение для публикации.",
        "Сделать в белом стиле.",
    )
    assert "Создать фирменное изображение" not in instruction
    assert "Скидка 30%" in instruction
    assert "белом стиле" in instruction


def test_content_refinements_keep_the_original_brief(client: TestClient, tmp_path) -> None:
    seed_user(tmp_path / "test.db", role=UserRole.OWNER)
    csrf = login(client)
    created = client.post(
        "/api/v1/content/items",
        headers={"X-CSRF-Token": csrf},
        json={
            "title": "Рекламный баннер",
            "editor_instruction": "Написать: акция на ламинирование ресниц — 4 000 рублей.",
            "scheduled_at": "2026-11-03T10:00:00+03:00",
            "platforms": ["telegram"],
        },
    )
    assert created.status_code == 201
    updated = client.patch(
        f"/api/v1/content/items/{created.json()['id']}",
        headers={"X-CSRF-Token": csrf},
        json={
            "editor_instruction": "цену сделать главным акцентом",
            "append_editor_instruction": True,
        },
    )
    assert updated.status_code == 200
    instruction = updated.json()["editor_instruction"]
    assert "ламинирование ресниц" in instruction
    assert "главным акцентом" in instruction


def test_visual_refinement_sends_full_brief_to_generator(client: TestClient, tmp_path, monkeypatch) -> None:
    """A small visual correction must never erase the original offer text."""
    seed_user(tmp_path / "test.db", role=UserRole.OWNER)
    csrf = login(client)
    created = client.post(
        "/api/v1/content/items",
        headers={"X-CSRF-Token": csrf},
        json={
            "title": "Рекламный баннер",
            "editor_instruction": "Написать: ламинирование ресниц и оформление бровей — 4 000 рублей.",
            "caption": "Акция в VIOLETTA: комплекс — 4 000 ₽.",
            "scheduled_at": "2026-11-03T10:00:00+03:00",
            "platforms": ["telegram"],
        },
    )
    assert created.status_code == 201
    captured: dict[str, str | None] = {}

    def fake_generate(*args, **kwargs):
        captured["instruction"] = args[4]
        captured["copy_hint"] = kwargs.get("copy_hint")
        return SimpleNamespace(id="generated-test-media")

    monkeypatch.setattr("vita29.api.content.generate_branded_visual", fake_generate)
    refined = client.post(
        f"/api/v1/content/items/{created.json()['id']}/visual",
        headers={"X-CSRF-Token": csrf},
        json={
            "instruction": "Цену сделать крупнее и ровно по центру нижнего золотого блока.",
            "source_media_ids": [],
        },
    )

    assert refined.status_code == 200
    assert "ламинирование ресниц" in (captured["instruction"] or "")
    assert "Цену сделать крупнее" in (captured["instruction"] or "")
    assert captured["copy_hint"] == "Акция в VIOLETTA: комплекс — 4 000 ₽."
    assert "ламинирование ресниц" in refined.json()["editor_instruction"]
    assert "Цену сделать крупнее" in refined.json()["editor_instruction"]


def test_content_plan_requires_administrator(client: TestClient, tmp_path) -> None:
    seed_user(tmp_path / "test.db", role=UserRole.EMPLOYEE, login="employee")
    login(client, "employee")
    assert client.get("/api/v1/content/items?week_start=2026-11-02").status_code == 403
