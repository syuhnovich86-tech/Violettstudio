from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from vita29.db.models import Base
from vita29.db.session import create_database_engine, get_db
from vita29.main import app
from vita29.settings import Settings, get_settings


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    engine = create_database_engine(f"sqlite:///{tmp_path / 'test.db'}")
    Base.metadata.create_all(engine)
    yclients_user_token = tmp_path / "yclients_user_token"
    yclients_partner_token = tmp_path / "yclients_partner_token"
    yclients_user_token.write_text("test-user-token", encoding="utf-8")
    yclients_partner_token.write_text("test-partner-token", encoding="utf-8")
    settings = Settings(
        database_url=f"sqlite:///{tmp_path / 'test.db'}",
        media_root=tmp_path / "media",
        minimum_free_bytes=0,
        yclients_user_token_file=yclients_user_token,
        yclients_partner_token_file=yclients_partner_token,
    )

    def override_db():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_settings] = lambda: settings
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
