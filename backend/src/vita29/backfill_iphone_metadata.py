from sqlalchemy import select

from vita29.db.models import MediaFile, User, Workspace, WorkspaceKind
from vita29.db.session import SessionLocal
from vita29.media.places import OfflinePlaceResolver
from vita29.media.storage import extract_media_metadata, original_path
from vita29.settings import get_settings


def main() -> None:
    settings = get_settings()
    places = OfflinePlaceResolver(settings.geonames_cities_path)
    updated = 0
    inspected = 0
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.login == settings.import_owner_login))
        if user is None:
            raise RuntimeError("Import owner is not configured")
        workspace = db.scalar(
            select(Workspace).where(
                Workspace.owner_id == user.id,
                Workspace.kind == WorkspaceKind.PRIVATE,
                Workspace.display_name == settings.import_workspace_name,
            )
        )
        if workspace is None:
            raise RuntimeError("Import workspace is not configured")
        files = db.scalars(
            select(MediaFile).where(
                MediaFile.workspace_id == workspace.id,
                MediaFile.deleted_at.is_(None),
            )
        ).all()
        for media in files:
            source = original_path(settings, media.storage_key)
            if not source.is_file():
                continue
            inspected += 1
            captured_at, latitude, longitude = extract_media_metadata(
                source,
                media.media_type,
                settings.local_utc_offset_hours,
            )
            country, city, location_key = places.resolve(latitude, longitude)
            changed = False
            for attribute, value in (
                ("captured_at", captured_at),
                ("gps_latitude", latitude),
                ("gps_longitude", longitude),
                ("location_country", country),
                ("location_city", city),
                ("location_key", location_key),
            ):
                if value is not None and getattr(media, attribute) != value:
                    setattr(media, attribute, value)
                    changed = True
            if changed:
                updated += 1
        db.commit()
    print(f"inspected={inspected} updated={updated}")


if __name__ == "__main__":
    main()
