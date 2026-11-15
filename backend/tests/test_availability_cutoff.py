from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from sqlalchemy.orm import Session

from tests.test_media import add_user
from vita29.api.content import collect_availability
from vita29.db.models import UserRole, YclientsIntegration, YclientsStaffMapping
from vita29.db.session import create_database_engine


def test_availability_cutoff_applies_to_both_service_lengths(client, tmp_path):
    owner, _ = add_user(tmp_path / 'test.db', 'cutoff-owner', UserRole.OWNER)
    second, _ = add_user(tmp_path / 'test.db', 'cutoff-second', UserRole.EMPLOYEE)
    engine = create_database_engine(f"sqlite:///{tmp_path / 'test.db'}")
    class Calendar:
        settings = SimpleNamespace(local_utc_offset_hours=3)
        def list_records(self, *args, **kwargs):
            return []
        def list_book_times(self, *args, **kwargs):
            return ['17:00', '17:30', '17:31', '18:00', '20:00']
    start = datetime.now(UTC).date() + timedelta(days=2)
    with Session(engine) as db:
        db.add(YclientsIntegration(salon_id=1, application_id=1, status='active'))
        db.add_all([
            YclientsStaffMapping(user_id=owner.id, salon_id=1, staff_id=3449724, staff_name='A'),
            YclientsStaffMapping(user_id=second.id, salon_id=1, staff_id=99, staff_name='B'),
        ])
        db.commit()
        _, slots = collect_availability(db, Calendar(), start)
    assert len(slots) == 14
    assert {slot['minimum_minutes'] for slot in slots} == {30, 60}
    assert all(slot['times'] == ['17:00', '17:30'] for slot in slots)
