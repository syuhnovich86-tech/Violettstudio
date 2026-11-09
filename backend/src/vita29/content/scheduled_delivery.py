"""Durable opt-in scheduling for publications approved in the mobile app."""
import hashlib
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from vita29.api.integrations import _status
from vita29.content.instagram import InstagramNotPublishedError, publish_to_instagram
from vita29.content.threads import ThreadsNotPublishedError, publish_to_threads
from vita29.content.archive import snapshot_publication
from vita29.content.max_publisher import publish_to_max
from vita29.content.max_stories import MaxStoryNotPublishedError, publish_max_stories
from vita29.content.telegram import publish_to_channel
from vita29.content.telegram_stories import TelegramStoryNotPublishedError, publish_telegram_stories
from vita29.integrations.store import secret_is_configured
from vita29.content.vk_publisher import VKNotPublishedError, publish_to_vk
from vita29.db.models import (
    AuditLog, ContentFormat, ContentItem, ContentPublication, ContentStatus, MediaFile,
    MediaType, PublicationPlatform, PublicationStatus, ScheduledPublicationJob, User, WorkspaceKind, utc_now,
)
from vita29.settings import get_settings
from vita29.workspaces.access import can_access_workspace

log = logging.getLogger(__name__)


def content_hash(item, publication):
    payload = [item.title, item.caption, item.editor_instruction, item.visual_edit_requested,
               item.content_format.value, publication.platform.value, publication.publication_format,
               publication.caption, publication.media_ids_json]
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def validate_media(db, item, publication, user):
    try:
        ids = json.loads(publication.media_ids_json)
    except (TypeError, ValueError):
        raise ValueError("Некорректные материалы публикации")
    if not isinstance(ids, list) or any(not isinstance(value, str) for value in ids) or len(ids) > 10:
        raise ValueError("Некорректные материалы публикации")
    by_id = {media.id: media for media in db.scalars(select(MediaFile).where(MediaFile.id.in_(ids))).all()}
    files = []
    for media_id in ids:
        media = by_id.get(media_id)
        if media is None or media.deleted_at is not None or not media.publication_allowed or not can_access_workspace(db, media.workspace, user):
            raise ValueError("Один из материалов недоступен для публикации")
        if publication.platform in {PublicationPlatform.INSTAGRAM, PublicationPlatform.THREADS} and media.workspace.kind != WorkspaceKind.STUDIO:
            raise ValueError("Для Instagram нужны материалы из общей папки")
        files.append(media)
    if publication.platform == PublicationPlatform.INSTAGRAM and not files:
        raise ValueError("Для Instagram нужно фото или видео")
    if publication.platform == PublicationPlatform.TELEGRAM and publication.publication_format == "reel":
        raise ValueError("В Telegram видео размещается как пост")
    if publication.platform == PublicationPlatform.TELEGRAM and publication.publication_format == "story":
        if not files:
            raise ValueError("Для истории Telegram нужно фото или видео")
        settings = get_settings()
        if not secret_is_configured(settings, 'telegram_story_session', settings.integration_secrets_path / 'unused'):
            raise ValueError("Подключите аккаунт администратора Telegram для историй в настройках")
    if publication.platform == PublicationPlatform.MAX and publication.publication_format not in {"post", "story"}:
        raise ValueError("В MAX доступны посты и истории")
    if publication.platform == PublicationPlatform.MAX and publication.publication_format == "story":
        if not files:
            raise ValueError("Для истории MAX нужно фото или видео")
        settings = get_settings()
        if not secret_is_configured(settings, "max_story_session", settings.integration_secrets_path / "unused"):
            raise ValueError("Подключите аккаунт студии MAX для историй")
    if publication.platform == PublicationPlatform.THREADS and (publication.publication_format != "post" or len(files) > 1):
        raise ValueError("Для Threads доступен пост с одним фото или видео либо без медиа")
    if publication.platform == PublicationPlatform.VK and publication.publication_format != "post":
        raise ValueError("Во ВКонтакте доступна публикация постов на стену сообщества")
    if publication.platform == PublicationPlatform.INSTAGRAM and publication.publication_format == "reel" and (len(files) != 1 or files[0].media_type != MediaType.VIDEO):
        raise ValueError("Для Reels в Instagram нужно одно видео")
    if (publication.platform == PublicationPlatform.INSTAGRAM and publication.publication_format in {"post", "reel"}
            and len(files) == 1 and files[0].media_type == MediaType.VIDEO):
        other_format = "reel" if publication.publication_format == "post" else "post"
        others = db.scalars(select(ContentPublication).where(
            ContentPublication.content_item_id == item.id,
            ContentPublication.platform == PublicationPlatform.INSTAGRAM,
            ContentPublication.publication_format == other_format,
        )).all()
        def same_media(other):
            try:
                return json.loads(other.media_ids_json) == ids
            except (TypeError, ValueError):
                return False
        if any(same_media(other) for other in others):
            raise ValueError("Instagram публикует одиночное видео как Reels. Чтобы ролик не вышел дважды, создайте отдельные публикации: пост с фото и Reels с видео.")
    if not (publication.caption or "").strip():
        raise ValueError("Сначала подготовьте текст публикации")
    return files


def approve(db: Session, item: ContentItem, user: User):
    # Serialize approval against a worker claiming a due publication.
    db.execute(update(ContentItem).where(ContentItem.id == item.id).values(updated_at=utc_now()))
    db.refresh(item)
    if not item.publication_date_assigned:
        raise ValueError("Назначьте дату и время публикации")
    scheduled = item.scheduled_at.replace(tzinfo=UTC) if item.scheduled_at.tzinfo is None else item.scheduled_at.astimezone(UTC)
    if scheduled <= datetime.now(UTC):
        raise ValueError("Выберите будущее время публикации")
    if item.status not in {ContentStatus.READY, ContentStatus.SCHEDULED, ContentStatus.FAILED}:
        raise ValueError("Сначала сгенерируйте материал и проверьте его")
    publications = db.scalars(select(ContentPublication).where(ContentPublication.content_item_id == item.id)).all()
    pending = [p for p in publications if p.status != PublicationStatus.PUBLISHED]
    if not pending:
        raise ValueError("Нет площадок, ожидающих публикации")
    configured = _status(get_settings())
    for publication in pending:
        if publication.status == PublicationStatus.PUBLISHING:
            raise ValueError("Публикация уже отправляется")
        if not (publication.platform == PublicationPlatform.MAX and publication.publication_format == "story") and not getattr(configured, publication.platform.value).configured:
            raise ValueError(f"Площадка {publication.platform.value.upper()} не настроена")
        validate_media(db, item, publication, user)
        job = db.get(ScheduledPublicationJob, publication.id)
        if job and job.state in {"sending", "unknown"}:
            raise ValueError("Результат предыдущей отправки неизвестен. Проверьте площадку перед повтором")
    for publication in pending:
        job = db.get(ScheduledPublicationJob, publication.id)
        approved_by_id = user.id
        current_hash = content_hash(item, publication)
        if job is None:
            job = ScheduledPublicationJob(publication_id=publication.id, approved_by_id=approved_by_id, content_hash=current_hash, state="queued", updated_at=utc_now())
            db.add(job)
        else:
            job.approved_by_id = approved_by_id
            job.content_hash = current_hash
            job.state = "queued"
            job.updated_at = utc_now()
        publication.status = PublicationStatus.SCHEDULED
        publication.error = None
    item.status = ContentStatus.SCHEDULED
    item.approved_by_id = user.id
    item.approved_at = utc_now()
    db.add(AuditLog(actor_id=user.id, action="content.schedule.approve", target_type="content_item", target_id=item.id))
    db.commit()


def publish_now(db: Session, item: ContentItem, publication: ContentPublication, user: User):
    """Publish one explicitly selected platform, recording uncertain outcomes."""
    if item.publication_date_assigned:
        raise ValueError("Уберите назначенную дату, чтобы разместить сейчас")
    if item.status not in {ContentStatus.READY, ContentStatus.FAILED}:
        raise ValueError("Сначала подготовьте материал")
    if publication.status not in {PublicationStatus.PENDING, PublicationStatus.FAILED}:
        raise ValueError("Публикация уже отправлена, отправляется или запланирована")
    job = db.get(ScheduledPublicationJob, publication.id)
    if job and job.state in {"queued", "sending", "unknown", "done"}:
        raise ValueError("Проверьте статус предыдущей отправки или отмените расписание")
    settings = get_settings()
    if not (publication.platform == PublicationPlatform.MAX and publication.publication_format == "story") and not getattr(_status(settings), publication.platform.value).configured:
        raise ValueError(f"Площадка {publication.platform.value.upper()} не настроена")
    files = validate_media(db, item, publication, user)
    try:
        snapshot_publication(settings, publication.id, files)
    except (OSError, ValueError) as error:
        raise ValueError("Не удалось сохранить материалы в архиве; публикация не отправлена") from error
    claim = db.execute(update(ContentPublication).where(
        ContentPublication.id == publication.id,
        ContentPublication.status.in_([PublicationStatus.PENDING, PublicationStatus.FAILED]),
    ).values(status=PublicationStatus.PUBLISHING, error=None))
    if claim.rowcount != 1:
        db.rollback()
        raise ValueError("Публикация уже отправляется")
    approved_by_id = user.id
    current_hash = content_hash(item, publication)
    if job is None:
        job = ScheduledPublicationJob(publication_id=publication.id, approved_by_id=approved_by_id, content_hash=current_hash, state="sending", updated_at=utc_now())
        db.add(job)
    else:
        job.approved_by_id = approved_by_id
        job.content_hash = current_hash
        job.state = "sending"
        job.updated_at = utc_now()
    db.commit()
    db.refresh(publication)
    try:
        if publication.platform == PublicationPlatform.TELEGRAM:
            external_id = publish_telegram_stories(db, settings, publication, publication.caption, files) if publication.publication_format == 'story' else publish_to_channel(settings, publication.caption, files)
        elif publication.platform == PublicationPlatform.INSTAGRAM:
            external_id = publish_to_instagram(db, settings, publication, publication.caption, files)
        elif publication.platform == PublicationPlatform.THREADS:
            external_id = publish_to_threads(db, settings, publication, publication.caption, files)
        elif publication.platform == PublicationPlatform.VK:
            external_id = publish_to_vk(settings, publication.caption, files, publication.id)
        else:
            external_id = publish_max_stories(db, settings, publication, publication.caption, files) if publication.publication_format == 'story' else publish_to_max(settings, publication.caption, files)
    except Exception as error:
        log.error("Immediate publication failed for %s (%s)", publication.id, type(error).__name__)
        db.rollback()
        job = db.get(ScheduledPublicationJob, publication.id)
        publication = db.get(ContentPublication, publication.id)
        item = db.get(ContentItem, item.id)
        publication.status = PublicationStatus.FAILED
        safely_not_published = isinstance(error, (InstagramNotPublishedError, ThreadsNotPublishedError, VKNotPublishedError, TelegramStoryNotPublishedError, MaxStoryNotPublishedError))
        publication.error = (str(error)[:200] if safely_not_published else "Часть сторис подтверждена. Проверьте площадку перед повтором." if publication.publication_format == "story" and publication.external_id else "Не удалось подтвердить отправку. Проверьте площадку перед повтором.")
        job.state = "failed" if safely_not_published else "unknown"
        job.updated_at = utc_now()
        item.status = ContentStatus.FAILED
        db.commit()
        raise RuntimeError(publication.error) from error
    publication.status = PublicationStatus.PUBLISHED
    publication.published_at = utc_now()
    publication.external_id = external_id
    publication.error = None
    job.state = "done"
    job.updated_at = utc_now()
    db.flush()
    publications = db.scalars(select(ContentPublication).where(ContentPublication.content_item_id == item.id)).all()
    item.status = ContentStatus.PUBLISHED if all(p.status == PublicationStatus.PUBLISHED for p in publications) else ContentStatus.READY
    db.add(AuditLog(actor_id=user.id, action="content.publish.immediate", target_type="content_item", target_id=item.id, details=json.dumps({"platform": publication.platform.value}, ensure_ascii=False)))
    db.commit()


def deliver_one(session_factory, publication_id):
    with session_factory() as db:
        job = db.get(ScheduledPublicationJob, publication_id)
        if job is None:
            return False
        publication = db.get(ContentPublication, publication_id)
        item = db.get(ContentItem, publication.content_item_id) if publication else None
        if item is None or item.status not in {ContentStatus.SCHEDULED, ContentStatus.FAILED} or not item.publication_date_assigned:
            return False
        now = utc_now()
        scheduled = item.scheduled_at.replace(tzinfo=UTC) if item.scheduled_at.tzinfo is None else item.scheduled_at.astimezone(UTC)
        if scheduled > now:
            return False
        still_due = select(ContentItem.id).join(ContentPublication, ContentPublication.content_item_id == ContentItem.id).where(ContentPublication.id == publication_id, ContentItem.status.in_([ContentStatus.SCHEDULED, ContentStatus.FAILED]), ContentItem.publication_date_assigned.is_(True), ContentItem.scheduled_at <= now).exists()
        claim = db.execute(update(ScheduledPublicationJob).where(ScheduledPublicationJob.publication_id == publication_id, ScheduledPublicationJob.state == "queued", still_due).values(state="sending", updated_at=now))
        if claim.rowcount != 1:
            db.rollback()
            return False
        publication_claim = db.execute(update(ContentPublication).where(ContentPublication.id == publication_id, ContentPublication.status == PublicationStatus.SCHEDULED).values(status=PublicationStatus.PUBLISHING))
        if publication_claim.rowcount != 1:
            db.rollback()
            return False
        db.commit()
        db.refresh(job); db.refresh(publication); db.refresh(item)
        attempted = False
        try:
            user = db.get(User, job.approved_by_id)
            if user is None or not user.is_active or not (user.can_access_content or user.role.value == "owner"):
                raise ValueError("Нет доступа автора утверждения к публикации")
            if content_hash(item, publication) != job.content_hash:
                raise ValueError("Публикация изменилась после утверждения. Утвердите её заново")
            files = validate_media(db, item, publication, user)
            settings = get_settings()
            snapshot_publication(settings, publication.id, files)
            attempted = True
            if publication.platform == PublicationPlatform.TELEGRAM:
                external_id = publish_telegram_stories(db, settings, publication, publication.caption, files) if publication.publication_format == 'story' else publish_to_channel(settings, publication.caption, files)
            elif publication.platform == PublicationPlatform.INSTAGRAM:
                external_id = publish_to_instagram(db, settings, publication, publication.caption, files)
            elif publication.platform == PublicationPlatform.THREADS:
                external_id = publish_to_threads(db, settings, publication, publication.caption, files)
            elif publication.platform == PublicationPlatform.VK:
                external_id = publish_to_vk(settings, publication.caption, files, publication.id)
            else:
                external_id = publish_max_stories(db, settings, publication, publication.caption, files) if publication.publication_format == 'story' else publish_to_max(settings, publication.caption, files)
            publication.status = PublicationStatus.PUBLISHED
            publication.published_at = utc_now()
            publication.external_id = external_id
            publication.error = None
            job.state = "done"
        except Exception as error:
            log.error("Scheduled publication failed for %s (%s)", publication_id, type(error).__name__)
            db.rollback()
            job = db.get(ScheduledPublicationJob, publication_id)
            publication = db.get(ContentPublication, publication_id)
            item = db.get(ContentItem, publication.content_item_id)
            publication.status = PublicationStatus.FAILED
            safely_not_published = isinstance(error, (InstagramNotPublishedError, ThreadsNotPublishedError, VKNotPublishedError, TelegramStoryNotPublishedError, MaxStoryNotPublishedError))
            if safely_not_published:
                publication.error = str(error)[:200]
            elif attempted and publication.platform in {PublicationPlatform.INSTAGRAM, PublicationPlatform.TELEGRAM, PublicationPlatform.MAX} and publication.publication_format == "story" and publication.external_id:
                publication.error = "Часть сторис подтверждена. Проверьте площадку перед повтором: последняя отправка могла пройти."
            else:
                publication.error = "Не удалось подтвердить отправку. Проверьте площадку перед повтором." if attempted else str(error)[:200]
            job.state = "unknown" if attempted and not safely_not_published else "failed"
        job.updated_at = utc_now()
        db.flush()
        all_jobs = db.scalars(select(ContentPublication).where(ContentPublication.content_item_id == item.id)).all()
        if all(p.status == PublicationStatus.PUBLISHED for p in all_jobs):
            item.status = ContentStatus.PUBLISHED
        elif any(p.status == PublicationStatus.FAILED for p in all_jobs):
            item.status = ContentStatus.FAILED
        db.add(AuditLog(actor_id=job.approved_by_id, action="content.schedule.delivery", target_type="content_item", target_id=item.id, details=json.dumps({"platform": publication.platform.value, "result": job.state}, ensure_ascii=False)))
        db.commit()
        return True


def run_due(session_factory):
    with session_factory() as db:
        stale = db.scalars(select(ScheduledPublicationJob).where(ScheduledPublicationJob.state == "sending", ScheduledPublicationJob.updated_at < utc_now() - timedelta(hours=1))).all()
        for job in stale:
            publication = db.get(ContentPublication, job.publication_id)
            if publication:
                publication.status = PublicationStatus.FAILED
                publication.error = "Результат отправки неизвестен после перезапуска. Проверьте площадку перед повтором."
                item = db.get(ContentItem, publication.content_item_id)
                if item:
                    item.status = ContentStatus.FAILED
            job.state = "unknown"
            job.updated_at = utc_now()
        if stale:
            db.commit()
        ids = db.scalars(select(ScheduledPublicationJob.publication_id).join(ContentPublication, ContentPublication.id == ScheduledPublicationJob.publication_id).join(ContentItem, ContentItem.id == ContentPublication.content_item_id).where(ScheduledPublicationJob.state == "queued", ContentItem.status.in_([ContentStatus.SCHEDULED, ContentStatus.FAILED]), ContentItem.publication_date_assigned.is_(True), ContentItem.scheduled_at <= utc_now()).limit(20)).all()
    if ids:
        with ThreadPoolExecutor(max_workers=3) as executor:
            list(executor.map(lambda publication_id: deliver_one(session_factory, publication_id), ids))
