"""Instagram receipts: isolated SQLite databases and mocked Meta; no publication."""
import importlib.util
import json
import sqlite3
import tempfile
import threading
import time
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from sqlalchemy import create_engine, select, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session
from vita29.db.models import Base, ContentPublication, MediaType, PublicationPlatform, TemporaryPublicMediaLink

source=Path(__file__).resolve().parents[1] / 'src' / 'vita29' / 'content' / 'instagram.py'
spec=importlib.util.spec_from_file_location('tested_instagram',source)
instagram=importlib.util.module_from_spec(spec); spec.loader.exec_module(instagram)

class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.path=Path(self.directory.name)/'test.db'
        self.engine=create_engine('sqlite:///'+str(self.path),connect_args={'timeout':.02})
        Base.metadata.create_all(self.engine)
        with self.engine.connect() as connection:
            connection.exec_driver_sql('PRAGMA journal_mode=WAL')
        self.db=Session(self.engine,expire_on_commit=False)
        self.publication=ContentPublication(id='publication',content_item_id='item',platform=PublicationPlatform.INSTAGRAM,publication_format='story')
        self.db.add(self.publication); self.db.commit()
    def tearDown(self):
        self.db.close(); self.engine.dispose(); self.directory.cleanup()
    def test_recovers_stale_wal_read_transaction(self):
        self.db.execute(text('BEGIN'))
        self.db.execute(select(ContentPublication)).all()
        with closing(sqlite3.connect(self.path)) as writer:
            with writer:
                writer.execute("UPDATE content_publication SET error='other writer' WHERE id='publication'")
        with self.assertRaises(OperationalError):
            self.db.execute(text("UPDATE content_publication SET external_id='old path fails' WHERE id='publication'"))
        instagram._persist_confirmation(self.db,self.publication,'confirmed-story')
        self.assertEqual(self.db.get(ContentPublication,'publication').external_id,'confirmed-story')
    def test_busy_database_retries_receipt_without_republishing(self):
        calls=[]; threads=[]
        def fake_call(method,path,**kwargs):
            calls.append((method,path))
            if method=='GET': return {'status_code':'FINISHED'}
            if path.endswith('/media_publish'):
                locked=threading.Event()
                def hold_lock():
                    with closing(sqlite3.connect(self.path)) as writer:
                        with writer:
                            writer.execute('BEGIN IMMEDIATE'); locked.set(); time.sleep(.15)
                thread=threading.Thread(target=hold_lock); thread.start(); threads.append(thread)
                self.assertTrue(locked.wait(3))
                return {'id':'confirmed-story'}
            return {'id':'container'}
        settings=SimpleNamespace(integration_secrets_path=Path('/unused'),public_base_url='https://example.invalid',openai_http_timeout_seconds=1)
        with patch.object(instagram,'read_secret',return_value='test'),patch.object(instagram,'config_value',return_value='account'),patch.object(instagram,'_call',side_effect=fake_call):
            result=instagram.publish_to_instagram(self.db,settings,self.publication,'text',[SimpleNamespace(id='image',media_type=MediaType.IMAGE)])
        for thread in threads: thread.join()
        self.assertEqual(result,'confirmed-story')
        self.assertEqual(sum(path.endswith('/media_publish') for method,path in calls),1)
        self.assertEqual(self.db.get(ContentPublication,'publication').external_id,'confirmed-story')
        self.assertTrue(all(link.revoked_at for link in self.db.scalars(select(TemporaryPublicMediaLink))))
    def test_multiple_stories_keep_all_receipts(self):
        published=[]
        def fake_call(method,path,**kwargs):
            if method=='GET': return {'status_code':'FINISHED'}
            if path.endswith('/media_publish'):
                published.append('story-'+str(len(published)+1)); return {'id':published[-1]}
            return {'id':'container'}
        settings=SimpleNamespace(integration_secrets_path=Path('/unused'),public_base_url='https://example.invalid',openai_http_timeout_seconds=1)
        with patch.object(instagram,'read_secret',return_value='test'),patch.object(instagram,'config_value',return_value='account'),patch.object(instagram,'_call',side_effect=fake_call):
            result=instagram.publish_to_instagram(self.db,settings,self.publication,'text',[SimpleNamespace(id=str(i),media_type=MediaType.IMAGE) for i in range(2)])
        self.assertEqual(json.loads(result),['story-1','story-2'])
        self.assertEqual(json.loads(self.db.get(ContentPublication,'publication').external_id),['story-1','story-2'])
        with Session(self.engine) as independent:
            self.assertEqual(json.loads(independent.get(ContentPublication,'publication').external_id),['story-1','story-2'])
        self.assertTrue(all(link.revoked_at for link in self.db.scalars(select(TemporaryPublicMediaLink))))

    def test_non_lock_database_error_is_not_retried(self):
        error=OperationalError('UPDATE',{},sqlite3.OperationalError('no such table'))
        with patch.object(self.db,'execute',side_effect=error) as execute,patch.object(instagram.time,'sleep') as sleep:
            with self.assertRaises(OperationalError):
                instagram._persist_confirmation(self.db,self.publication,'confirmed-story')
        self.assertEqual(execute.call_count,1)
        sleep.assert_not_called()

if __name__ == '__main__':
    unittest.main(verbosity=2)
