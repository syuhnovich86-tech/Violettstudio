import pytest

from vita29.db.models import MediaType
from vita29.media.storage import identify_media


@pytest.mark.parametrize(
    ("header", "mime_type"),
    [
        (b"\x1aE\xdf\xa3" + b"\x00" * 28, "video/webm"),
        (b"OggS" + b"\x00" * 28, "video/ogg"),
        (b"RIFF" + b"\x00" * 4 + b"AVI " + b"\x00" * 20, "video/x-msvideo"),
        (b"\x00\x00\x00\x18ftyp3gp5" + b"\x00" * 20, "video/3gpp"),
        (b"\x00\x00\x00\x18ftypisom" + b"\x00" * 20, "video/mp4"),
    ],
)
def test_identify_browser_and_phone_video_formats(header: bytes, mime_type: str) -> None:
    media_type, detected_mime_type = identify_media(header)

    assert media_type is MediaType.VIDEO
    assert detected_mime_type == mime_type
