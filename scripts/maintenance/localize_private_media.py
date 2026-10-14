from sqlalchemy import select

from vita29.db.models import MediaFile, Workspace, WorkspaceKind
from vita29.db.session import SessionLocal
from vita29.media.places import OfflinePlaceResolver
from vita29.settings import get_settings


def main() -> None:
    settings = get_settings()
    resolver = OfflinePlaceResolver(settings.geonames_cities_path)
    changed_publication = 0
    changed_location = 0

    with SessionLocal() as database:
        private_workspace_ids = select(Workspace.id).where(
            Workspace.kind == WorkspaceKind.PRIVATE
        )
        files = database.scalars(
            select(MediaFile).where(
                MediaFile.workspace_id.in_(private_workspace_ids),
                MediaFile.deleted_at.is_(None),
            )
        ).all()
        for media in files:
            if not media.publication_allowed:
                media.publication_allowed = True
                changed_publication += 1
            if media.gps_latitude is None or media.gps_longitude is None:
                continue
            country, city, location_key = resolver.resolve(
                media.gps_latitude, media.gps_longitude
            )
            if (
                media.location_country,
                media.location_city,
                media.location_key,
            ) != (country, city, location_key):
                media.location_country = country
                media.location_city = city
                media.location_key = location_key
                changed_location += 1
        database.commit()

    print(
        f"private_files={len(files)} "
        f"publication_enabled={changed_publication} "
        f"locations_localized={changed_location}"
    )


if __name__ == "__main__":
    main()
