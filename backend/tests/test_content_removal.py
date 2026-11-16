from datetime import timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from tests.test_auth import login, seed_user
from vita29.content import scheduled_delivery
from vita29.db.models import (
    AuditLog, ContentItem, ContentPublication, ContentStatus, PublicationPlatform,
    PublicationStatus, ScheduledPublicationJob, UserRole, utc_now,
)
from vita29.db.session import create_database_engine


def setup_card(client, tmp_path, auth="web"):
    owner = seed_user(tmp_path / "test.db", role=UserRole.OWNER)
    if auth == "mobile":
        response = client.post("/api/v1/mobile/auth/login", json={
            "login": owner.login, "password": "strong-pass-123",
        })
        headers = {"Authorization": "Bearer " + response.json()["access_token"]}
    else:
        headers = {"X-CSRF-Token": login(client)}
    engine = create_database_engine(f"sqlite:///{tmp_path / 'test.db'}")
    with Session(engine) as db:
        item = ContentItem(title="Анастасия — свободные окна", status=ContentStatus.FAILED,
                           scheduled_at=utc_now() - timedelta(days=1), created_by_id=owner.id)
        db.add(item)
        db.flush()
        for platform, state, job_state in [
            (PublicationPlatform.TELEGRAM, PublicationStatus.PUBLISHED, "done"),
            (PublicationPlatform.INSTAGRAM, PublicationStatus.FAILED, "unknown"),
            (PublicationPlatform.MAX, PublicationStatus.SCHEDULED, "queued"),
        ]:
            publication = ContentPublication(content_item_id=item.id, platform=platform,
                status=state, external_id="confirmed-id" if job_state == "done" else None,
                published_at=utc_now() if job_state == "done" else None)
            db.add(publication)
            db.flush()
            db.add(ScheduledPublicationJob(publication_id=publication.id,
                approved_by_id=owner.id, content_hash="a" * 64, state=job_state))
        item_id = item.id
        week_start = (utc_now() - timedelta(days=2)).date().isoformat()
        db.commit()
    return engine, headers, item_id, week_start


@pytest.mark.parametrize("auth", ["web", "mobile"])
def test_archive_copy_uses_requested_platform_formats(client, tmp_path, auth):
    engine, headers, item_id, _ = setup_card(client, tmp_path, auth)
    with Session(engine) as db:
        source = db.scalar(select(ContentPublication).where(
            ContentPublication.content_item_id == item_id,
            ContentPublication.status == PublicationStatus.PUBLISHED))
        source_id = source.id
    path = f"/api/v1/content/archive/{source_id}/reuse"
    payload = {"platforms": ["instagram", "telegram", "telegram_studio", "whatsapp_studio", "max", "vk", "threads"],
               "platform_formats": {"instagram": "story", "telegram": "post", "max": "story"}}
    response = client.post(path, headers=headers, json=payload)
    assert response.status_code == 201, response.text
    assert {(p["platform"], p["publication_format"]) for p in response.json()["publications"]} == {
        ("instagram", "story"), ("telegram", "post"), ("telegram_studio", "story"),
        ("whatsapp_studio", "story"), ("max", "story"), ("vk", "post"), ("threads", "post")}
    assert response.json()["id"] != item_id
    assert client.post(path, headers=headers, json={"platforms": ["vk"],
        "platform_formats": {"vk": "story"}}).status_code == 422
    assert client.post(path, headers=headers, json={"platforms": ["whatsapp_studio"],
        "platform_formats": {"whatsapp_studio": "post"}}).status_code == 422


@pytest.mark.parametrize("auth", ["web", "mobile"])
def test_remove_partial_publication_keeps_history_and_stops_queue(client, tmp_path, monkeypatch, auth):
    engine, headers, item_id, week = setup_card(client, tmp_path, auth)
    path = f"/api/v1/content/items/{item_id}"
    assert client.delete(path, headers=headers).status_code == 204
    assert client.delete(path, headers=headers).status_code == 204
    assert item_id not in {i["id"] for i in client.get(
        f"/api/v1/content/items?week_start={week}", headers=headers).json()}
    for action in ["/schedule", "/publish-selected", "/prepare"]:
        assert client.post(path + action, headers=headers).status_code == 404
    with Session(engine) as db:
        assert db.get(ContentItem, item_id).deleted_at is not None
        records = db.scalars(select(ContentPublication).where(
            ContentPublication.content_item_id == item_id)).all()
        assert len(records) == 3
        by_platform = {r.platform: r for r in records}
        published = by_platform[PublicationPlatform.TELEGRAM]
        assert published.external_id == "confirmed-id"
        assert published.status == PublicationStatus.PUBLISHED
        assert db.get(ScheduledPublicationJob, published.id).state == "done"
        unknown = by_platform[PublicationPlatform.INSTAGRAM]
        assert unknown.status == PublicationStatus.FAILED
        assert db.get(ScheduledPublicationJob, unknown.id).state == "unknown"
        cancelled = by_platform[PublicationPlatform.MAX]
        assert db.get(ScheduledPublicationJob, cancelled.id).state == "cancelled"
        assert len(db.scalars(select(AuditLog).where(
            AuditLog.action == "content.plan.remove", AuditLog.target_id == item_id)).all()) == 1
        published_id, cancelled_id = published.id, cancelled.id
    archive = client.get("/api/v1/content/archive", headers=headers).json()["items"]
    assert item_id in {i["item_id"] for i in archive}
    reused = client.post(f"/api/v1/content/archive/{published_id}/reuse",
                        headers=headers, json={"platforms": ["telegram"]})
    assert reused.status_code == 201
    assert reused.json()["id"] != item_id
    # Even a stale queued entry cannot publish a removed card.
    with Session(engine) as db:
        db.get(ScheduledPublicationJob, cancelled_id).state = "queued"
        db.commit()
    monkeypatch.setattr(scheduled_delivery, "get_settings",
                        lambda: pytest.fail("Removed card reached publisher preparation"))
    factory = sessionmaker(engine)
    assert scheduled_delivery.deliver_one(factory, cancelled_id) is False
    scheduled_delivery.run_due(factory)


@pytest.mark.parametrize("busy", ["publishing", "sending", "generating"])
def test_remove_during_work_is_rejected(client, tmp_path, busy):
    engine, headers, item_id, _ = setup_card(client, tmp_path)
    with Session(engine) as db:
        item = db.get(ContentItem, item_id)
        publication = db.scalar(select(ContentPublication).where(
            ContentPublication.content_item_id == item_id,
            ContentPublication.platform == PublicationPlatform.INSTAGRAM))
        if busy == "publishing":
            publication.status = PublicationStatus.PUBLISHING
        elif busy == "sending":
            db.get(ScheduledPublicationJob, publication.id).state = "sending"
        else:
            item.status = ContentStatus.GENERATING
        db.commit()
    assert client.delete(f"/api/v1/content/items/{item_id}", headers=headers).status_code == 409
    with Session(engine) as db:
        assert db.get(ContentItem, item_id).deleted_at is None


def test_remove_requires_csrf_and_content_permission(client, tmp_path):
    engine, _, item_id, _ = setup_card(client, tmp_path)
    assert client.delete(f"/api/v1/content/items/{item_id}").status_code == 403
    seed_user(tmp_path / "test.db", role=UserRole.EMPLOYEE, login="no-content")
    csrf = login(client, "no-content")
    assert client.delete(f"/api/v1/content/items/{item_id}",
                         headers={"X-CSRF-Token": csrf}).status_code == 403
    with Session(engine) as db:
        assert db.get(ContentItem, item_id).deleted_at is None
