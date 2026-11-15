"""Owner-only QR pairing for the local WhatsApp companion."""
import base64
import io
from typing import Annotated

import qrcode
from fastapi import APIRouter, Depends, HTTPException, Response

from vita29.auth.dependencies import require_csrf, require_owner_or_administrator
from vita29.content.whatsapp_stories import WhatsAppBridge, WhatsAppNotPublishedError, WhatsAppUncertainError
from vita29.db.models import AuthSession, User
from vita29.settings import Settings, get_settings

router = APIRouter(prefix='/integrations/whatsapp-story', tags=['integrations'])


def bridge(settings: Settings) -> WhatsAppBridge:
    return WhatsAppBridge(settings.integration_secrets_path.parent / 'whatsapp' / 'bridge.sock', timeout=15)


@router.post('/start')
def start(response: Response, _: Annotated[AuthSession, Depends(require_csrf)], __: Annotated[User, Depends(require_owner_or_administrator)], settings: Annotated[Settings, Depends(get_settings)]):
    response.headers['Cache-Control'] = 'no-store'
    try:
        return bridge(settings).request('POST', '/pair')
    except (WhatsAppNotPublishedError, WhatsAppUncertainError) as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.get('/status')
def status(response: Response, _: Annotated[User, Depends(require_owner_or_administrator)], settings: Annotated[Settings, Depends(get_settings)]):
    response.headers['Cache-Control'] = 'no-store'
    try:
        result = bridge(settings).request('GET', '/status')
    except (WhatsAppNotPublishedError, WhatsAppUncertainError) as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    code = result.pop('qr', None)
    if code:
        buffer = io.BytesIO()
        qrcode.make(code).save(buffer, format='PNG')
        result['qr'] = 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()
    return result
