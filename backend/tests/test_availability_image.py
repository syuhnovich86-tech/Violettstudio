from __future__ import annotations

from PIL import Image

from vita29.content.availability_image import draw_availability_overlay


def test_availability_overlay_uses_weekday_row_and_separate_date() -> None:
    image = Image.new("RGB", (1080, 1920), (0, 0, 0))
    rendered = draw_availability_overlay(
        image,
        [
            {"date": "2026-11-06", "times": ["13:30", "15:30", "17:30"]},
            {"date": "2026-11-08", "times": ["14:00"]},
        ],
    )

    # Friday (weekday 4) and Sunday (weekday 6) change only their own rows.
    # The date is deliberately outside the outlined time field (around x=545),
    # matching the approved branded templates.
    assert rendered.getbbox() is not None
    assert rendered.crop((40, 1170, 430, 1255)).getbbox() is not None
    assert rendered.crop((475, 1170, 650, 1255)).getbbox() is not None
    assert rendered.crop((40, 1425, 430, 1510)).getbbox() is not None
    assert rendered.crop((475, 1425, 650, 1510)).getbbox() is not None

