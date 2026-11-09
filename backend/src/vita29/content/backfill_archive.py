"""Create archive copies for already published material; safe to run again."""
import logging

from sqlalchemy import select

from vita29.content.archive import snapshot_file
from vita29.db.models import ContentPublication, MediaFile, PublicationStatus
from vita29.db.session import SessionLocal
from vita29.settings import get_settings
import json


def main() -> None:
    settings = get_settings()
    copied = missing = 0
    with SessionLocal() as db:
        publications = db.scalars(select(ContentPublication).where(ContentPublication.status == PublicationStatus.PUBLISHED))
        for publication in publications:
            try:
                media_ids = json.loads(publication.media_ids_json or '[]')
            except (TypeError, ValueError):
                logging.warning('Invalid archive media list: %s', publication.id)
                missing += 1
                continue
            for media_id in media_ids:
                media = db.get(MediaFile, media_id)
                if media is None:
                    missing += 1
                    continue
                try:
                    snapshot_file(settings, publication.id, media)
                    copied += 1
                except (OSError, ValueError):
                    logging.warning('Archive file unavailable: %s', media.id)
                    missing += 1
    print(f'Archive files available: {copied}; unavailable: {missing}')


if __name__ == '__main__':
    main()
