"""Administrator-authorized MAX account connection; credentials never leave the server."""
import asyncio
import base64
import json
import logging
import re
import secrets
import tempfile
from io import BytesIO
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from vita29.auth.dependencies import require_csrf, require_owner_or_administrator
from vita29.db.models import AuthSession, User
from vita29.integrations.store import write_secret
from vita29.settings import Settings, get_settings

router = APIRouter(prefix='/integrations/max-story', tags=['integrations'])
_attempts: dict[str, dict] = {}
log = logging.getLogger(__name__)


class StartRequest(BaseModel):
    phone: str = Field(min_length=8, max_length=20, repr=False)


class AnswerRequest(BaseModel):
    value: str = Field(min_length=1, max_length=256, repr=False)


class Provider:
    def __init__(self, attempt, phase):
        self.attempt, self.phase = attempt, phase

    async def get_code(self, _phone):
        self.attempt.update(status='code', message='Введите код подтверждения из MAX.')
        return await asyncio.wait_for(self.attempt['answers'].get(), 180)

    async def get_password(self, hint=None):
        self.attempt.update(status='password', message='Введите пароль входа MAX.')
        return await asyncio.wait_for(self.attempt['answers'].get(), 180)


class DiagnosticAuthFlow:
    """Inspect only response field names; never retain authentication values."""
    def __init__(self, attempt):
        self.attempt = attempt

    async def authenticate(self, app):
        from pymax.auth.sms import SmsAuthFlow
        from pymax.protocol import Opcode

        invoke = app.invoke

        async def observe(opcode, payload):
            response = await invoke(opcode, payload)
            if opcode == Opcode.AUTH_REQUEST and isinstance(response.payload, dict):
                allowed = {'token', 'codeLength', 'requestMaxDuration', 'requestCountLeft',
                           'altActionDuration', 'call', 'callNumber', 'phoneNumber',
                           'verificationMethod', 'method', 'type', 'callInfo', 'callData'}
                fields = sorted(key for key in response.payload if isinstance(key, str) and key in allowed)
                self.attempt['auth_response_fields'] = fields
                log.info('MAX auth response fields: %s', ','.join(fields))
            return response

        app.invoke = observe
        try:
            return await SmsAuthFlow(Provider(self.attempt, 'code'), Provider(self.attempt, 'password')).authenticate(app)
        finally:
            app.invoke = invoke


class QrProvider:
    def __init__(self, attempt):
        self.attempt = attempt

    async def show_qr(self, qr_url):
        import qrcode
        output = BytesIO()
        qrcode.make(qr_url).save(output, format='PNG')
        self.attempt.update(status='qr', qr_image='data:image/png;base64,' + base64.b64encode(output.getvalue()).decode('ascii'),
                            message='В MAX на телефоне студии откройте «Настройки → Устройства» и отсканируйте код.')


async def _login(attempt, phone, settings, method='code'):
    from pymax import Client, ExtraConfig, WebClient
    client = None
    try:
        with tempfile.TemporaryDirectory(prefix='vita29-max-login-') as directory:
            config = ExtraConfig(persist_session=True, telemetry=False, reconnect=False, relogin=False, password_max_attempts=1, log_level='CRITICAL')
            if method == 'qr':
                from pymax.auth.qr import QrAuthFlow
                client = WebClient(work_dir=directory, extra_config=config,
                                   auth_flow=QrAuthFlow(QrProvider(attempt), Provider(attempt, 'password')))
            else:
                client = Client(phone=phone, work_dir=directory, extra_config=config,
                                auth_flow=DiagnosticAuthFlow(attempt))
            await asyncio.wait_for(client.connect(), 300)
            if not client.me or not client.me.contact:
                raise ValueError('Профиль MAX недоступен')
            identity = str(client.me.contact.id)
            await client.close()
            client = None
            session = Path(directory, 'session.db').read_bytes()
            if not session:
                raise ValueError('Сессия MAX пуста')
            secret = json.dumps({'phone': phone, 'session': base64.b64encode(session).decode('ascii'), 'account_id': identity, 'transport': 'web' if method == 'qr' else 'tcp'})
            await asyncio.to_thread(write_secret, settings, 'max_story_session', secret)
            attempt.update(status='connected', message='Аккаунт MAX подключён. Истории будут выходить от него.')
    except asyncio.CancelledError:
        raise
    except Exception as error:
        code = getattr(error, 'error', '')
        if not isinstance(code, str) or not re.fullmatch(r'[a-zA-Z0-9_.-]{1,80}', code):
            code = 'unknown'
        log.warning('MAX story login failed: type=%s code=%s', type(error).__name__, code)
        attempt.update(status='error', message='Не удалось подключить аккаунт MAX. Проверьте код, пароль и попробуйте снова.')
    finally:
        attempt.pop('qr_image', None)
        if client is not None:
            await client.close()


@router.post('/start')
async def start(payload: StartRequest, response: Response, auth: Annotated[AuthSession, Depends(require_csrf)], user: Annotated[User, Depends(require_owner_or_administrator)], settings: Annotated[Settings, Depends(get_settings)]):
    response.headers['Cache-Control'] = 'no-store'
    phone = re.sub(r'[\s()\-]', '', payload.phone)
    if not re.fullmatch(r'\+[1-9][0-9]{7,14}', phone):
        raise HTTPException(400, detail='Укажите номер с кодом страны, например +79990000000')
    old = _attempts.pop(user.id, None)
    if old and not old['task'].done(): old['task'].cancel()
    attempt = {'id': secrets.token_urlsafe(24), 'status': 'connecting', 'message': 'Подключаемся к MAX…', 'answers': asyncio.Queue(maxsize=1)}
    _attempts[user.id] = attempt
    attempt['task'] = asyncio.create_task(_login(attempt, phone, settings))
    return {'attempt_id': attempt['id'], 'status': attempt['status'], 'message': attempt['message']}


@router.post('/start-qr')
async def start_qr(response: Response, auth: Annotated[AuthSession, Depends(require_csrf)], user: Annotated[User, Depends(require_owner_or_administrator)], settings: Annotated[Settings, Depends(get_settings)]):
    response.headers['Cache-Control'] = 'no-store'
    old = _attempts.pop(user.id, None)
    if old and not old['task'].done(): old['task'].cancel()
    attempt = {'id': secrets.token_urlsafe(24), 'status': 'connecting', 'message': 'Создаём код для подключения MAX…', 'answers': asyncio.Queue(maxsize=1)}
    _attempts[user.id] = attempt
    attempt['task'] = asyncio.create_task(_login(attempt, '', settings, 'qr'))
    return {'attempt_id': attempt['id'], 'status': attempt['status'], 'message': attempt['message']}


def _find(user, attempt_id):
    attempt = _attempts.get(user.id)
    if not attempt or not secrets.compare_digest(attempt['id'], attempt_id):
        raise HTTPException(404, detail='Подключение не найдено')
    return attempt


@router.get('/status/{attempt_id}')
async def status(attempt_id: str, response: Response, user: Annotated[User, Depends(require_owner_or_administrator)]):
    response.headers['Cache-Control'] = 'no-store'
    attempt = _find(user, attempt_id)
    return {'status': attempt['status'], 'message': attempt['message'], 'qr_image': attempt.get('qr_image') if attempt['status'] == 'qr' else None}


@router.post('/answer/{attempt_id}')
async def answer(attempt_id: str, payload: AnswerRequest, auth: Annotated[AuthSession, Depends(require_csrf)], user: Annotated[User, Depends(require_owner_or_administrator)]):
    attempt = _find(user, attempt_id)
    if attempt['status'] not in {'code', 'password'}:
        raise HTTPException(409, detail='Сейчас ввод не требуется')
    attempt['status'] = 'checking'
    attempt['answers'].put_nowait(payload.value)
    return {'status': 'checking'}


@router.post('/disconnect')
async def disconnect(auth: Annotated[AuthSession, Depends(require_csrf)], user: Annotated[User, Depends(require_owner_or_administrator)], settings: Annotated[Settings, Depends(get_settings)]):
    attempt = _attempts.pop(user.id, None)
    if attempt and not attempt['task'].done(): attempt['task'].cancel()
    write_secret(settings, 'max_story_session', '')
    return {'status': 'disconnected'}
