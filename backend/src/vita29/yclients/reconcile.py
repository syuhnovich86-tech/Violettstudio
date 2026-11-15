"""Refresh a wider window of calendar records without changing media."""
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from vita29.db.models import YclientsIntegration
from vita29.db.session import SessionLocal
from vita29.settings import get_settings
from vita29.yclients.client import YclientsClient
from vita29.yclients.sync import sync_yclients_visits


def run() -> None:
    settings = get_settings()
    today = datetime.now(timezone(timedelta(hours=settings.local_utc_offset_hours))).date()
    with SessionLocal() as db:
        integration = db.scalar(select(YclientsIntegration).where(YclientsIntegration.status == 'active'))
        if integration is None:
            print('YCLIENTS integration is not active; skipping')
            return
        result = sync_yclients_visits(
            db=db,
            client=YclientsClient(settings),
            salon_id=integration.salon_id,
            start_date=today - timedelta(days=90),
            end_date=today + timedelta(days=90),
        )
        print(f"YCLIENTS calendar: {result['processed']} records refreshed")


if __name__ == '__main__':
    run()
