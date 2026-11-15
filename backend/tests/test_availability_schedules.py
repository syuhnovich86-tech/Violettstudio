import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from vita29.api.availability_schedules import ScheduleInput
from vita29.content import availability_schedule as jobs
from vita29.db.models import Base, User, UserRole, YclientsIntegration, YclientsStaffMapping, AvailabilityPublicationSchedule


def test_weekly_requires_one_day_and_supported_format():
    base = dict(enabled=True, frequency='weekly', weekdays=[0], time_local='10:00', publish_new=True, targets={'instagram': 'story'})
    assert ScheduleInput(**base).weekdays == [0]
    with pytest.raises(ValidationError):
        ScheduleInput(**(base | {'weekdays': [0, 1]}))
    with pytest.raises(ValidationError):
        ScheduleInput(**(base | {'targets': {'vk': 'story'}}))


def test_daily_and_new_slots_are_not_duplicated(monkeypatch):
    from vita29.api import content
    from vita29.yclients import client
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    now = datetime(2026, 11, 9, 7, 0, tzinfo=UTC)  # Monday, 10:00 Moscow
    settings = SimpleNamespace(local_utc_offset_hours=3)
    with factory() as db:
        db.add(User(id='admin', display_name='Admin', login='admin', password_hash='x', role=UserRole.OWNER))
        db.add(YclientsIntegration(salon_id=1, application_id=1, status='active'))
        db.add(YclientsStaffMapping(user_id='admin', salon_id=1, staff_id=42, staff_name='Master'))
        db.add(AvailabilityPublicationSchedule(staff_id=42, owner_id='admin', enabled=True, frequency='daily', weekdays_json='[0]', time_local='10:00', publish_new=True, targets_json='{"telegram":"post"}'))
        db.commit()
    slots = [{'date': '2026-11-09', 'times': ['12:00']}]
    monkeypatch.setattr(client, 'YclientsClient', lambda _: object())
    monkeypatch.setattr(content, 'collect_availability', lambda db, *_: ([db.query(YclientsStaffMapping).first()], slots))
    sent = []
    monkeypatch.setattr(jobs, '_create_publication', lambda *args: sent.append(list(slots)))
    jobs.run_due(factory, settings, now)
    jobs.run_due(factory, settings, now + timedelta(minutes=1))
    assert len(sent) == 1
    slots[0]['times'].append('13:00')
    jobs.run_due(factory, settings, now + timedelta(minutes=16))
    jobs.run_due(factory, settings, now + timedelta(minutes=32))
    assert len(sent) == 2


def test_interrupted_job_does_not_repeat():
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    now = datetime(2026, 11, 9, 7, 0, tzinfo=UTC)
    with factory() as db:
        db.add(User(id='admin', display_name='Admin', login='admin', password_hash='x', role=UserRole.OWNER))
        db.add(AvailabilityPublicationSchedule(staff_id=42, owner_id='admin', enabled=True, frequency='daily', weekdays_json='[0]', time_local='10:00', publish_new=True, targets_json='{"telegram":"post"}', busy=True, updated_at=now-timedelta(hours=2)))
        db.commit()
    jobs.run_due(factory, SimpleNamespace(local_utc_offset_hours=3), now)
    with factory() as db:
        schedule = db.get(AvailabilityPublicationSchedule, 42)
        assert not schedule.busy
        assert schedule.last_regular_date == '2026-11-09'
        assert schedule.last_error


def test_publication_preserves_platform_formats_and_schedule(monkeypatch):
    from vita29.content import agent, availability_image, scheduled_delivery
    from vita29.db.models import ContentItem, ContentPublication
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(agent, 'template_for_staff', lambda *args: object())
    monkeypatch.setattr(availability_image, 'render_availability_image', lambda *args: SimpleNamespace(id='synthetic-image'))
    approvals = []
    monkeypatch.setattr(scheduled_delivery, 'approve', lambda db, item, user: approvals.append(item.id))
    with factory() as db:
        user = User(id='admin', display_name='Admin', login='admin', password_hash='x', role=UserRole.OWNER)
        row = AvailabilityPublicationSchedule(staff_id=42, owner_id='admin', enabled=True, frequency='daily', weekdays_json='[0]', time_local='10:00', publish_new=False, targets_json='{"instagram":"story","telegram":"post"}')
        db.add_all([user, row]); db.commit()
        target = datetime.now(UTC) + timedelta(minutes=5)
        jobs._create_publication(db, row, user, SimpleNamespace(staff_id=42, staff_name='Master'), [], [{'date':'2026-11-09','times':['12:00']}], SimpleNamespace(), target)
        item = db.get(ContentItem, row.last_item_id)
        entries = db.query(ContentPublication).filter_by(content_item_id=item.id).all()
        assert {(p.platform.value, p.publication_format) for p in entries} == {('instagram','story'),('telegram','post')}
        assert all(json.loads(p.media_ids_json) == ['synthetic-image'] for p in entries)
        assert jobs._utc(item.scheduled_at) == target
        assert approvals == [item.id]
