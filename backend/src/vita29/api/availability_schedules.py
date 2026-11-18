"""Per-master automated availability publication schedules."""
import json
from datetime import datetime, time, timedelta, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from vita29.auth.dependencies import require_content_access, require_csrf
from vita29.db.models import AvailabilityPublicationSchedule, AuthSession, User, utc_now
from vita29.db.session import get_db
from vita29.settings import get_settings

router = APIRouter(prefix='/content/availability/schedules', tags=['content'])


class ScheduleInput(BaseModel):
    enabled: bool = False
    frequency: Literal['daily', 'weekly'] = 'daily'
    weekdays: list[int] = Field(min_length=1, max_length=7)
    time_local: str = Field(pattern=r'^([01]\d|2[0-3]):[0-5]\d$')
    publish_new: bool = False
    targets: dict[str, Literal['post', 'story']]

    @field_validator('weekdays')
    @classmethod
    def valid_weekdays(cls, days):
        if any(day < 0 or day > 6 for day in days) or len(set(days)) != len(days):
            raise ValueError('Выберите корректные дни недели')
        return sorted(days)

    @field_validator('targets')
    @classmethod
    def valid_targets(cls, targets):
        if not targets or not set(targets).issubset({'telegram', 'instagram', 'max', 'threads'}):
            raise ValueError('Выберите площадку')
        if any(targets.get(name) == 'story' for name in ('vk', 'threads')):
            raise ValueError('Для этой площадки поддерживается только пост')
        return targets

    @model_validator(mode='after')
    def check_weekly(self):
        if self.frequency == 'weekly' and len(self.weekdays) != 1:
            raise ValueError('Для еженедельной публикации выберите один день')
        return self


def schedule_response(row, settings):
    from vita29.content.availability_schedule import next_regular
    return {'staff_id': row.staff_id, 'enabled': row.enabled, 'frequency': row.frequency,
            'weekdays': json.loads(row.weekdays_json), 'time_local': row.time_local,
            'publish_new': row.publish_new, 'targets': json.loads(row.targets_json),
            'next_publication_at': next_regular(row, utc_now(), settings),
            'last_error': row.last_error, 'last_item_id': row.last_item_id, 'busy': row.busy}


@router.get('')
def list_schedules(_: Annotated[User, Depends(require_content_access)], db: Annotated[Session, Depends(get_db)]):
    settings = get_settings()
    return [schedule_response(row, settings) for row in db.scalars(select(AvailabilityPublicationSchedule)).all()]


@router.put('/{staff_id}')
def save_schedule(staff_id: int, payload: ScheduleInput,
    _: Annotated[AuthSession, Depends(require_csrf)], user: Annotated[User, Depends(require_content_access)],
    db: Annotated[Session, Depends(get_db)]):
    from vita29.api.content import list_availability_staff
    if not any(person.staff_id == staff_id for person in list_availability_staff(user, db)):
        raise HTTPException(404, 'Мастер недоступен или для него не настроен шаблон')
    row = db.get(AvailabilityPublicationSchedule, staff_id)
    if row is not None and row.busy:
        raise HTTPException(409, 'Идёт подготовка публикации. Повторите чуть позже.')
    if row is None:
        row = AvailabilityPublicationSchedule(staff_id=staff_id, owner_id=user.id)
        db.add(row)
    previous_enabled, previous_new = row.enabled, row.publish_new
    row.owner_id = user.id
    row.enabled = payload.enabled
    row.frequency = payload.frequency
    row.weekdays_json = json.dumps(payload.weekdays)
    row.time_local = payload.time_local
    row.targets_json = json.dumps(payload.targets)
    row.publish_new = payload.publish_new
    if payload.publish_new and (not previous_new or not previous_enabled):
        row.seen_slots_json = None
        row.checked_at = None
    settings = get_settings()
    local = datetime.now(timezone(timedelta(hours=settings.local_utc_offset_hours)))
    row.last_regular_date = local.date().isoformat() if local.time().replace(tzinfo=None) >= time.fromisoformat(payload.time_local) else None
    row.last_error = None
    db.commit()
    db.refresh(row)
    return schedule_response(row, settings)
