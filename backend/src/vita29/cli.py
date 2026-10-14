import argparse
import getpass

from sqlalchemy import select

from vita29.auth.security import hash_password, normalize_login, revoke_user_sessions
from vita29.db.models import (
    MediaFile,
    MediaType,
    User,
    UserRole,
    Workspace,
    WorkspaceKind,
    WorkspaceMember,
)
from vita29.db.session import SessionLocal
from vita29.media.storage import extract_capture_datetime, original_path
from vita29.settings import get_settings
from vita29.workspaces.access import create_studio_workspace


def create_owner(display_name: str, login: str) -> None:
    password = getpass.getpass("New administrator password: ")
    confirmation = getpass.getpass("Repeat password: ")
    if password != confirmation:
        raise SystemExit("Passwords do not match")
    if len(password) < 10:
        raise SystemExit("Password must contain at least 10 characters")

    normalized_login = normalize_login(login)
    with SessionLocal() as db:
        if db.scalar(select(User).where(User.role == UserRole.OWNER)):
            raise SystemExit("The system owner already exists")
        if db.scalar(select(User).where(User.login == normalized_login)):
            raise SystemExit("This login already exists")
        user = User(
            display_name=display_name.strip(),
            login=normalized_login,
            password_hash=hash_password(password),
            role=UserRole.OWNER,
            can_create_shared_workspaces=True,
            can_create_private_workspaces=True,
            can_add_comments=True,
            can_upload_media=True,
            can_view_all_calendars=True,
            can_access_admin=True,
            can_access_chats=True,
        )
        db.add(user)
        db.flush()
        create_studio_workspace(db, user)
        db.commit()
    print(f"System owner '{display_name}' created")


def reset_password(login: str) -> None:
    normalized_login = normalize_login(login)
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.login == normalized_login))
        if user is None:
            raise SystemExit("This login does not exist")

        password = getpass.getpass("New password: ")
        confirmation = getpass.getpass("Repeat password: ")
        if password != confirmation:
            raise SystemExit("Passwords do not match")
        if len(password) < 10:
            raise SystemExit("Password must contain at least 10 characters")

        user.password_hash = hash_password(password)
        db.commit()
        revoke_user_sessions(db, user.id)
    print(f"Password for '{normalized_login}' reset")


def create_private_workspace(name: str, owner_login: str, member_logins: list[str]) -> None:
    normalized_owner_login = normalize_login(owner_login)
    normalized_member_logins = {normalize_login(login) for login in member_logins}
    normalized_member_logins.add(normalized_owner_login)
    with SessionLocal() as db:
        owner = db.scalar(select(User).where(User.login == normalized_owner_login))
        if owner is None or not owner.is_active:
            raise SystemExit("The workspace owner does not exist or is inactive")
        duplicate = db.scalar(
            select(Workspace).where(
                Workspace.owner_id == owner.id,
                Workspace.kind == WorkspaceKind.PRIVATE,
                Workspace.display_name == name.strip(),
            )
        )
        if duplicate is not None:
            raise SystemExit("This private workspace already exists")
        members = db.scalars(
            select(User).where(User.login.in_(normalized_member_logins), User.is_active.is_(True))
        ).all()
        if {member.login for member in members} != normalized_member_logins:
            raise SystemExit("One or more workspace members do not exist or are inactive")
        workspace = Workspace(
            display_name=name.strip(),
            kind=WorkspaceKind.PRIVATE,
            owner_id=owner.id,
        )
        db.add(workspace)
        db.flush()
        db.add_all(
            WorkspaceMember(workspace_id=workspace.id, user_id=member.id) for member in members
        )
        db.commit()
    print(f"Private workspace '{name}' created for '{normalized_owner_login}'")


def backfill_capture_dates() -> None:
    settings = get_settings()
    updated = 0
    unavailable = 0
    with SessionLocal() as db:
        files = db.scalars(
            select(MediaFile).where(
                MediaFile.media_type == MediaType.IMAGE,
                MediaFile.captured_at.is_(None),
                MediaFile.deleted_at.is_(None),
            )
        ).all()
        for media in files:
            captured_at = extract_capture_datetime(
                original_path(settings, media.storage_key), settings.local_utc_offset_hours
            )
            if captured_at is None:
                unavailable += 1
                continue
            media.captured_at = captured_at
            updated += 1
        db.commit()
    print(f"Capture dates updated: {updated}; metadata unavailable: {unavailable}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="vita29")
    commands = parser.add_subparsers(dest="command", required=True)
    owner = commands.add_parser("create-owner")
    owner.add_argument("--name", required=True)
    owner.add_argument("--login", required=True)
    password = commands.add_parser("reset-password")
    password.add_argument("--login", required=True)
    private_workspace = commands.add_parser("create-private-workspace")
    private_workspace.add_argument("--name", required=True)
    private_workspace.add_argument("--owner-login", required=True)
    private_workspace.add_argument("--member-login", action="append", default=[])
    commands.add_parser("backfill-capture-dates")
    args = parser.parse_args()
    if args.command == "create-owner":
        create_owner(args.name, args.login)
    elif args.command == "reset-password":
        reset_password(args.login)
    elif args.command == "create-private-workspace":
        create_private_workspace(args.name, args.owner_login, args.member_login)
    elif args.command == "backfill-capture-dates":
        backfill_capture_dates()


if __name__ == "__main__":
    main()
