import json
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from vita29.auth.security import hash_password
from vita29.db.models import (
    Base,
    User,
    YclientsStaffMapping,
    YclientsVisit,
)
from vita29.db.session import create_database_engine
from vita29.yclients.sync import sync_yclients_visits


class RecordsClient:
    def list_records(self, salon_id, *, start_date, end_date, page, count):
        assert salon_id == 956792
        assert start_date == "2026-08-01"
        assert end_date == "2026-08-31"
        assert page == 1
        assert count == 100
        return [
            {
                "id": 7001,
                "staff_id": 2882305,
                "datetime": "2026-08-31T14:15:00+03:00",
                "attendance": 1,
                "deleted": False,
                "comment": "Клиент просил натуральный результат",
                "client": {"id": 8001, "display_name": "Тестовый клиент"},
                "services": [{"id": 9001, "title": "Перманентный макияж"}],
            }
        ]


def test_sync_links_visit_to_confirmed_staff_mapping(tmp_path) -> None:
    engine = create_database_engine(f"sqlite:///{tmp_path / 'sync.db'}")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        user = User(
            display_name="Соня ПМ",
            login="sonyapm",
            password_hash=hash_password("test-password"),
        )
        db.add(user)
        db.flush()
        db.add(
            YclientsStaffMapping(
                user_id=user.id,
                salon_id=956792,
                staff_id=2882305,
                staff_name="Софья",
                specialization="Мастер тату и перманентного макияжа",
            )
        )
        db.commit()

        result = sync_yclients_visits(
            db=db,
            client=RecordsClient(),
            salon_id=956792,
            start_date=date(2026, 8, 1),
            end_date=date(2026, 8, 31),
        )

        visit = db.scalar(select(YclientsVisit).where(YclientsVisit.record_id == 7001))
        assert result == {"processed": 1, "linked": 1, "unlinked": 0}
        assert visit is not None
        assert visit.user_id == user.id
        assert visit.client_display_name == "Тестовый клиент"
        assert json.loads(visit.service_titles) == ["Перманентный макияж"]
        assert visit.comment == "Клиент просил натуральный результат"
