import os
from datetime import UTC, datetime, timedelta
from io import BytesIO
from pathlib import Path

from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from vita29.auth.security import hash_password
from vita29.db.models import Base, MediaFile, User, UserRole, Workspace, WorkspaceKind
from vita29.db.session import create_database_engine
from vita29.importer import IphoneImporter
from vita29.settings import Settings


def _jpeg() -> bytes:
    output = BytesIO()
    Image.new("RGB", (32, 24), color=(210, 160, 90)).save(output, format="JPEG")
    return output.getvalue()


def test_iphone_importer_registers_original_and_quarantines_duplicate(tmp_path: Path) -> None:
    database = tmp_path / "vita29.db"
    engine = create_database_engine(f"sqlite:///{database}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with Session(engine, expire_on_commit=False) as db:
        user = User(
            display_name="Виолетта ПМ",
            login="violet29",
            password_hash=hash_password("test-password"),
            role=UserRole.EMPLOYEE,
        )
        db.add(user)
        db.flush()
        workspace = Workspace(
            display_name="Фото с iPhone",
            kind=WorkspaceKind.PRIVATE,
            owner_id=user.id,
        )
        db.add(workspace)
        db.commit()

    import_root = tmp_path / "import"
    first = import_root / "IMG_0001.JPG"
    first.parent.mkdir(parents=True)
    first.write_bytes(_jpeg())
    old_time = (datetime.now(UTC) - timedelta(minutes=5)).timestamp()
    os.utime(first, (old_time, old_time))
    settings = Settings(
        database_url=f"sqlite:///{database}",
        media_root=tmp_path / "media",
        import_root=import_root,
        geonames_cities_path=tmp_path / "missing-cities.txt",
        minimum_free_bytes=0,
        import_stability_seconds=10,
    )
    importer = IphoneImporter(settings, factory)

    result = importer.scan_once()
    assert result["imported"] == 1
    assert not first.exists()
    with Session(engine) as db:
        media = db.scalar(select(MediaFile))
        assert media is not None
        assert media.original_name == "IMG_0001.JPG"
        assert media.captured_at is not None
        assert (settings.originals_path / media.storage_key).is_file()

    duplicate = import_root / "IMG_0001-copy.JPG"
    duplicate.write_bytes(_jpeg())
    os.utime(duplicate, (old_time, old_time))
    result = importer.scan_once()
    assert result["duplicate"] == 1
    assert not duplicate.exists()
    assert any((import_root / ".duplicates").rglob("IMG_0001-copy.JPG"))
    with Session(engine) as db:
        assert len(db.scalars(select(MediaFile)).all()) == 1
