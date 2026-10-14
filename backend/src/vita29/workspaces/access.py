from sqlalchemy.orm import Session

from vita29.db.models import User, Workspace, WorkspaceKind, WorkspaceMember


def create_studio_workspace(db: Session, user: User) -> Workspace:
    workspace = Workspace(
        display_name=user.display_name,
        kind=WorkspaceKind.STUDIO,
        owner_id=user.id,
    )
    db.add(workspace)
    return workspace


def can_access_workspace(db: Session, workspace: Workspace, user: User) -> bool:
    if not workspace.owner.is_active:
        return False
    if workspace.kind == WorkspaceKind.STUDIO or workspace.owner_id == user.id:
        return True
    return db.get(WorkspaceMember, (workspace.id, user.id)) is not None
