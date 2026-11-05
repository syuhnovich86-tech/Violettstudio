"""Idempotent seed for the isolated mobile test environment only."""

import os

from sqlalchemy import select

from vita29.auth.security import hash_password
from vita29.db.models import User, UserRole, Workspace, WorkspaceKind, WorkspaceMember
from vita29.db.session import SessionLocal
from vita29.settings import get_settings
from vita29.workspaces.access import create_studio_workspace


def seed() -> None:
    settings = get_settings()
    if settings.environment != "test":
        raise SystemExit("Test seed is disabled outside VITA29_ENVIRONMENT=test")
    password = os.environ.get("VITA29_TEST_PASSWORD", "violetta-test-2026")
    if len(password) < 10:
        raise SystemExit("VITA29_TEST_PASSWORD must contain at least 10 characters")

    with SessionLocal() as db:
        owner = db.scalar(select(User).where(User.login == "test-owner"))
        if owner is None:
            owner = User(
                display_name="Тестовый владелец",
                login="test-owner",
                password_hash=hash_password(password),
                role=UserRole.OWNER,
                can_create_shared_workspaces=True,
                can_create_private_workspaces=True,
                can_add_comments=True,
                can_upload_media=True,
                can_view_all_calendars=True,
                can_access_admin=True,
                can_access_chats=True,
                can_access_content=True,
                can_import_ios_photo_library=True,
            )
            db.add(owner)
            db.flush()
            create_studio_workspace(db, owner)

        violetta = db.scalar(select(User).where(User.login == "violetta"))
        if violetta is None:
            violetta = User(
                display_name="Виолетта",
                login="violetta",
                password_hash=hash_password(password),
                role=UserRole.ADMIN,
                can_upload_media=True,
                can_view_all_calendars=True,
                can_access_admin=True,
                can_access_chats=True,
                can_access_content=True,
                can_import_ios_photo_library=True,
            )
            db.add(violetta)
            db.flush()
            create_studio_workspace(db, violetta)

        workspace = db.scalar(
            select(Workspace).where(
                Workspace.owner_id == owner.id,
                Workspace.kind == WorkspaceKind.PRIVATE,
                Workspace.display_name == settings.import_workspace_name,
            )
        )
        if workspace is None:
            workspace = Workspace(
                display_name=settings.import_workspace_name,
                kind=WorkspaceKind.PRIVATE,
                owner_id=owner.id,
            )
            db.add(workspace)
            db.flush()
        for user in (owner, violetta):
            if db.get(WorkspaceMember, (workspace.id, user.id)) is None:
                db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id))
        db.commit()
    print("Mobile test environment seeded: test-owner, violetta, Фото с iPhone")


if __name__ == "__main__":
    seed()
