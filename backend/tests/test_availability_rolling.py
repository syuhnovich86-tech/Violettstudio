"""Isolated regression checks: in-memory database, fake booking API, no delivery."""
import ast
import importlib.util
import sys
import unittest
from datetime import UTC, date, datetime, time, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from vita29.db.models import Base, User, UserRole, YclientsIntegration, YclientsStaffMapping, AvailabilityPublicationSchedule
from vita29.yclients.client import YclientsError

root = Path(__file__).resolve().parents[1] / 'src' / 'vita29'
source = (root / 'api' / 'content.py').read_text()
node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == 'collect_availability')
namespace = dict(globals())
exec(compile('from __future__ import annotations\n' + ast.get_source_segment(source, node), str(root / 'api' / 'content.py'), 'exec'), namespace)
collect = namespace['collect_availability']
spec = importlib.util.spec_from_file_location('tested_availability_schedule', root / 'content' / 'availability_schedule.py')
jobs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jobs)

class Clock(datetime):
    value = datetime(2026, 11, 15, 14, 55, tzinfo=UTC)
    @classmethod
    def now(cls, tz=None):
        return cls.value.astimezone(tz) if tz else cls.value.replace(tzinfo=None)

class Booking:
    settings = SimpleNamespace(local_utc_offset_hours=3)
    def __init__(self):
        self.requests = []
        self.records = []
    def list_records(self, *args, **kwargs):
        self.range = kwargs
        return self.records
    def list_book_times(self, salon_id, staff_id, day, *, minimum_minutes):
        self.requests.append((staff_id, day, minimum_minutes))
        return ['09:30', '10:00', '11:00', '17:30', '17:31']

class Regression(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite://')
        Base.metadata.create_all(self.engine)
        self.factory = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.db = self.factory()
        for uid, staff_id, name in [('a',3449724,'Anastasia'),('s',2882298,'Svetlana')]:
            self.db.add(User(id=uid,display_name=name,login=uid,password_hash='unused',role=UserRole.OWNER,is_active=True))
            self.db.add(YclientsStaffMapping(user_id=uid,salon_id=1,staff_id=staff_id,staff_name=name))
        self.db.add(YclientsIntegration(salon_id=1,application_id=1,status='active'))
        self.db.commit()
        self.api = Booking()
        Clock.value = datetime(2026,11,15,14,55,tzinfo=UTC)
        namespace['datetime'] = Clock
    def tearDown(self):
        self.db.close()
        self.engine.dispose()
    def test_sunday_evening_includes_full_next_week_and_cutoff(self):
        _, slots = collect(self.db,self.api,date(2026,11,9),3449724)
        self.assertEqual([s['date'] for s in slots],[str(date(2026,11,16)+timedelta(days=i)) for i in range(7)])
        self.assertEqual(self.api.range['start_date'],'2026-11-16')
        self.assertEqual(self.api.range['end_date'],'2026-11-22')
        self.assertTrue(all(s['minimum_minutes']==30 and '17:31' not in s['times'] for s in slots))
    def test_sunday_before_cutoff_keeps_today_and_crosses_monday(self):
        Clock.value = datetime(2026,11,15,14,0,tzinfo=UTC)
        _, slots = collect(self.db,self.api,date(2026,11,9),3449724)
        self.assertEqual(slots[0]['date'],'2026-11-15')
        self.assertEqual(slots[0]['times'],['17:30'])
        self.assertEqual(slots[-1]['date'],'2026-11-21')
    def test_future_anchor_has_one_date_per_weekday(self):
        _, slots = collect(self.db,self.api,date(2026,11,17),3449724)
        self.assertEqual(slots[-1]['date'],'2026-11-23')
        self.assertEqual(len({date.fromisoformat(s['date']).weekday() for s in slots}),7)
    def test_only_anastasia_uses_30_minutes_and_busy_overlap_is_respected(self):
        self.api.records=[{'staff_id':sid,'datetime':'2026-11-16T10:00:00+03:00','seance_length':3600} for sid in (3449724,2882298)]
        _, slots = collect(self.db,self.api,date(2026,11,16))
        anastasia=next(s for s in slots if s['staff_id']==3449724 and s['date']=='2026-11-16')
        svetlana=next(s for s in slots if s['staff_id']==2882298 and s['date']=='2026-11-16')
        self.assertEqual(svetlana['minimum_minutes'],60)
        self.assertIn('09:30',anastasia['times'])
        self.assertNotIn('09:30',svetlana['times'])
        self.assertNotIn('10:00',anastasia['times'])
        self.assertNotIn('10:00',svetlana['times'])
    def test_1800_schedule_prepares_once_at_1755_without_delivery(self):
        self.db.add(AvailabilityPublicationSchedule(staff_id=3449724,owner_id='a',enabled=True,frequency='daily',weekdays_json='[0,1,2,3,4,5,6]',time_local='18:00',publish_new=False,targets_json='{"telegram":"story","instagram":"story","max":"story"}'))
        self.db.commit()
        calls=[]
        def prepare(*args):
            calls.append({'slots':args[5],'target':args[7]})
        with patch('vita29.api.content.collect_availability',collect), patch('vita29.yclients.client.YclientsClient',return_value=self.api), patch.object(jobs,'_create_publication',side_effect=prepare):
            jobs.run_due(self.factory,self.api.settings,Clock.value-timedelta(minutes=1))
            self.assertEqual(calls,[])
            jobs.run_due(self.factory,self.api.settings,Clock.value)
            jobs.run_due(self.factory,self.api.settings,Clock.value+timedelta(minutes=1))
        self.assertEqual(len(calls),1)
        self.assertEqual(calls[0]['target'],datetime(2026,11,15,15,0,tzinfo=UTC))
        self.assertEqual(calls[0]['slots'][0]['date'],'2026-11-16')

if __name__ == '__main__':
    unittest.main(verbosity=2)
