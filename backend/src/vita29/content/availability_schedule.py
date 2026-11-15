"""Recurring availability jobs; delivery reuses the existing publication queue."""
import json
import logging
from datetime import UTC, datetime, time, timedelta, timezone

from sqlalchemy import select, update
from vita29.db.models import (
    AvailabilityPublicationSchedule, ContentFormat, ContentItem, ContentPublication,
    ContentStatus, PublicationPlatform, User, UserRole, utc_now,
)

log = logging.getLogger(__name__)


def local_datetime(value, settings):
    return value.astimezone(timezone(timedelta(hours=settings.local_utc_offset_hours)))


def next_regular(schedule, now, settings):
    if not schedule.enabled:
        return None
    local = local_datetime(now, settings)
    weekdays = set(json.loads(schedule.weekdays_json))
    hour, minute = map(int, schedule.time_local.split(':'))
    for offset in range(8):
        day = local.date() + timedelta(days=offset)
        target = datetime.combine(day, time(hour, minute), tzinfo=local.tzinfo)
        if day.weekday() in weekdays and target > local:
            return target.astimezone(UTC)
    return None


def canonical_slots(slots):
    return sorted({f"{row['date']}|{value[:5]}" for row in slots for value in row.get('times', [])})


def _utc(value):
    if value is None:
        return None
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _create_publication(db, schedule, user, mapping, mappings, slots, settings, desired_time=None):
    from vita29.content.agent import template_for_staff
    from vita29.content.availability_image import render_availability_image
    from vita29.content.scheduled_delivery import approve

    item = ContentItem(title=f'{mapping.staff_name} — свободные окна', content_format=ContentFormat.AVAILABILITY,
        media_limit=1, availability_staff_id=mapping.staff_id, availability_slots_json=json.dumps(slots, ensure_ascii=False),
        scheduled_at=utc_now() + timedelta(minutes=5), publication_date_assigned=True,
        media_ids_json='[]', created_by_id=user.id, status=ContentStatus.DRAFT)
    db.add(item)
    db.flush()
    # Persist the item ID before any expensive or external step so a restart cannot duplicate a job.
    schedule.last_item_id = item.id
    db.commit()
    template = template_for_staff(db, mapping.staff_id, mappings)
    rendered = render_availability_image(db, settings, item, template, slots, user.id)
    for platform, kind in json.loads(schedule.targets_json).items():
        db.add(ContentPublication(content_item_id=item.id, platform=PublicationPlatform(platform),
            publication_format=kind, caption='Ближайшие свободные окна — актуально на момент публикации. Напишите нам, чтобы записаться 💌',
            media_ids_json=json.dumps([rendered.id])))
    item.status = ContentStatus.READY
    # Start rendering ahead of a scheduled slot; if rendering runs long, send
    # as soon as the queue can safely process it instead of scheduling in the past.
    earliest = utc_now() + timedelta(seconds=30)
    item.scheduled_at = max(desired_time, earliest) if desired_time else utc_now() + timedelta(minutes=2)
    db.commit()
    approve(db, item, user)


def run_due(session_factory, settings, now=None):
    from vita29.api.content import collect_availability
    from vita29.yclients.client import YclientsClient
    from vita29.db.models import YclientsIntegration, YclientsStaffMapping

    now = now or utc_now()
    local = local_datetime(now, settings)
    with session_factory() as db:
        schedules = db.scalars(select(AvailabilityPublicationSchedule).where(AvailabilityPublicationSchedule.enabled.is_(True))).all()
        for row in schedules:
            if row.busy:
                # Do not repeat an interrupted publication: its outcome may be unknown.
                if _utc(row.updated_at) and now - _utc(row.updated_at) > timedelta(hours=1):
                    row.busy = False
                    row.last_regular_date = local.date().isoformat()
                    row.seen_slots_json = None
                    row.checked_at = now
                    row.last_error = 'Подготовка прервалась. Проверьте публикации; следующая попытка будет по расписанию.'
                    db.commit()
                continue
            target_local = datetime.combine(local.date(), time.fromisoformat(row.time_local), tzinfo=local.tzinfo)
            due_regular = local.weekday() in json.loads(row.weekdays_json) and local >= target_local - timedelta(minutes=5) and row.last_regular_date != local.date().isoformat()
            checked = _utc(row.checked_at)
            due_check = row.publish_new and (checked is None or now - checked >= timedelta(minutes=15))
            if not due_regular and not due_check:
                continue
            staff_id = row.staff_id
            if db.execute(update(AvailabilityPublicationSchedule).where(AvailabilityPublicationSchedule.staff_id == staff_id, AvailabilityPublicationSchedule.busy.is_(False)).values(busy=True, updated_at=now)).rowcount != 1:
                db.rollback()
                continue
            db.commit()
            try:
                user = db.get(User, row.owner_id)
                if user is None or not user.is_active or (user.role != UserRole.OWNER and not user.can_access_content):
                    raise ValueError('Нет активного пользователя с доступом к контенту; настройте расписание заново.')
                start = local.date()
                mappings, slots = collect_availability(db, YclientsClient(settings), start, row.staff_id)
                current = canonical_slots(slots)
                prior = json.loads(row.seen_slots_json) if row.seen_slots_json is not None else None
                new_slots = bool(prior is not None and set(current) - set(prior))
                last_event = _utc(row.last_event_at)
                event_allowed = last_event is None or now - last_event >= timedelta(hours=1)
                event_due = due_check and new_slots and event_allowed
                row.checked_at = now
                # Leave the baseline unchanged while rate limited so new slots are not lost.
                if not (due_check and new_slots and not event_allowed):
                    row.seen_slots_json = json.dumps(current)
                if due_regular:
                    row.last_regular_date = local.date().isoformat()
                if (due_regular or event_due) and slots:
                    if event_due:
                        row.last_event_at = now
                    db.commit()
                    integration = db.scalar(select(YclientsIntegration).where(YclientsIntegration.status == 'active'))
                    all_mappings = db.scalars(select(YclientsStaffMapping).where(YclientsStaffMapping.salon_id == integration.salon_id)).all()
                    _create_publication(db, row, user, mappings[0], all_mappings, slots, settings, target_local.astimezone(UTC) if due_regular else None)
                    row.last_error = None
                elif due_regular and not slots:
                    row.last_error = 'Нет свободных окон: публикация пропущена.'
                row.busy = False
                db.commit()
            except Exception as exc:
                db.rollback()
                row = db.get(AvailabilityPublicationSchedule, staff_id)
                row.last_error = str(getattr(exc, 'detail', 'Не удалось подготовить публикацию. Проверьте подключение и шаблон.'))[:500]
                row.busy = False
                # Avoid an unbounded retry loop after a provider or rendering error.
                if due_regular:
                    row.last_regular_date = local.date().isoformat()
                if due_check:
                    row.checked_at = now
                db.commit()
                log.exception('Availability publication scheduling failed for staff %s', row.staff_id)
