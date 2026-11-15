from datetime import UTC, datetime

import pytest
from sqlalchemy.orm import Session

from tests.test_media import add_user, sign_in, PASSWORD
from vita29.db.models import MediaFile, MediaType, UserRole
from vita29.db.session import create_database_engine


@pytest.mark.parametrize('mobile', [False, True])
def test_phone_archive_and_picker_use_capture_date_even_for_old_clients(client, tmp_path, mobile):
    owner, workspace = add_user(tmp_path / 'test.db', 'phone-sort', UserRole.OWNER)
    engine = create_database_engine(f"sqlite:///{tmp_path / 'test.db'}")
    with Session(engine) as db:
        for ident, captured, created, key in [
            ('new-photo', datetime(2026, 10, 1, tzinfo=UTC), datetime(2026, 10, 2, tzinfo=UTC), 'a'*64),
            ('old-late-upload', datetime(2018, 1, 1, tzinfo=UTC), datetime(2026, 11, 14, tzinfo=UTC), None),
            ('unknown-late-upload', None, datetime(2026, 11, 15, tzinfo=UTC), None),
        ]:
            db.add(MediaFile(id=ident, owner_id=owner.id, workspace_id=workspace.id, storage_key=ident+'.jpg', original_name=ident+'.jpg', media_type=MediaType.IMAGE, mime_type='image/jpeg', size_bytes=10, checksum_sha256='b'*64, captured_at=captured, created_at=created, ios_import_key=key, publication_allowed=True, content_marked=ident!='new-photo'))
        db.commit()
    if mobile:
        login = client.post('/api/v1/mobile/auth/login', json={'login':'phone-sort','password':PASSWORD})
        headers={'Authorization':'Bearer '+login.json()['access_token']}
    else:
        sign_in(client, 'phone-sort')
        headers={}
    expected=['new-photo','old-late-upload','unknown-late-upload']
    base=f'/api/v1/media?workspace_id={workspace.id}'
    archive=client.get(base, headers=headers)
    assert archive.status_code==200, archive.text
    assert [v['id'] for v in archive.json()]==expected
    assert [v['id'] for v in client.get(base+'&limit=1&offset=1', headers=headers).json()]==expected[1:2]
    for sort in ['archive','uploaded','recent','priority']:
        picker=client.get(f'/api/v1/content/media-library?workspace_id={workspace.id}&sort={sort}', headers=headers)
        assert picker.status_code==200, picker.text
        assert [v['id'] for v in picker.json()['items']]==expected
    filters=client.get(f'/api/v1/media/filter-options?workspace_id={workspace.id}', headers=headers)
    assert filters.status_code==200, filters.text
    assert filters.json()['months']==[{'year':2026,'month':10,'count':1},{'year':2018,'month':1,'count':1}]
