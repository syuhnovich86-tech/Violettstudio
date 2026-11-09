"""Create a publishable availability-card image from a branded template."""

from __future__ import annotations

import hashlib
from datetime import UTC, date, datetime
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from vita29.db.models import ContentItem, MediaFile, MediaType, Workspace, WorkspaceKind
from vita29.media.storage import original_path, thumbnail_path
from vita29.settings import Settings


def _font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    for base in (Path("/usr/share/fonts/truetype/dejavu"), Path("/usr/share/fonts/dejavu")):
        candidate = base / name
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def _fit_times(times: object, width: int) -> tuple[str, ImageFont.FreeTypeFont] | None:
    """Return one complete fitted line that cannot leave its template row.

    The left field is reserved for time values; the date is rendered in the
    adjacent zone on the same row.
    """
    values = [str(value) for value in times] if isinstance(times, list) else []
    values = [value for value in values if value][:2]
    if not values:
        return None
    text = " / ".join(values)
    for size in range(52, 27, -2):
        font = _font(size, bold=False)
        if font.getlength(text) <= width:
            return text, font
    return text, _font(28, bold=False)


def _draw_centered(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont,
    center_x: int,
    center_y: int,
    *,
    fill: tuple[int, int, int] = (255, 244, 215),
) -> None:
    """Centre glyphs, not their baseline, and keep a subtle dark contour."""
    box = draw.textbbox((0, 0), text, font=font)
    x = center_x - (box[2] - box[0]) // 2 - box[0]
    y = center_y - (box[3] - box[1]) // 2 - box[1]
    # A one-pixel shadow keeps the pale gold values readable over every master
    # portrait without altering the original template artwork.
    draw.text((x + 1, y + 1), text, font=font, fill=(50, 31, 12))
    draw.text((x, y), text, font=font, fill=fill)


# Row centres and spacing were measured independently for each approved template.
# Coordinates are proportions of the template, not screen pixels.
_TEMPLATE_ROWS = {
    "36419.png": (259.5 / 690, 45.0 / 690),
    "36418.png": (249.5 / 690, 46.4 / 690),
    "36417.png": (246.5 / 690, 47.0 / 690),
    "36416.png": (235.5 / 690, 47.0 / 690),
    "36426.png": (242.5 / 690, 46.7 / 690),
    "36427.png": (248.0 / 690, 46.7 / 690),
}


def draw_availability_overlay(image: Image.Image, slots: list[dict[str, object]], template_name: str) -> Image.Image:
    """Place each date and up to two times inside its own weekday frame."""
    geometry = _TEMPLATE_ROWS.get(template_name)
    if geometry is None:
        raise ValueError("Разметка этого шаблона свободных окон ещё не настроена")
    draw = ImageDraw.Draw(image)
    width, height = image.size
    text_left = int(width * .073)
    text_right = int(width * .404)
    for slot in slots:
        try:
            day = date.fromisoformat(str(slot.get("date") or ""))
        except ValueError:
            continue
        raw = slot.get("times")
        times = [str(value).strip() for value in raw if value][:2] if isinstance(raw, list) else []
        if not times:
            continue
        text = f"{day:%d.%m}  {' / '.join(times)}"
        for size in range(max(12, int(width * .041)), 9, -1):
            font = _font(size, bold=False)
            if font.getlength(text) <= text_right - text_left:
                break
        else:
            raise ValueError("Время не помещается в шаблон свободных окон")
        _draw_centered(draw, text, font, (text_left + text_right) // 2,
                       round(height * (geometry[0] + day.weekday() * geometry[1])))
    return image


def render_availability_image(
    db: Session,
    settings: Settings,
    item: ContentItem,
    template: MediaFile,
    slots: list[dict[str, object]],
    actor_id: str,
) -> MediaFile:
    """Paint free times into the blank weekday rows of the selected master template.

    The studio templates have a stable 9:16 layout: seven labelled weekday rows on
    the left.  The image itself—not the caption—contains the times that are sent to
    Telegram.
    """
    source = original_path(settings, template.storage_key)
    if not source.is_file():
        raise OSError("Шаблон свободных окон не найден в хранилище")

    # Generated files are studio assets, never source templates.  Keeping them
    # in a dedicated shared folder makes the finished creative easy to find and
    # prevents future template selection from confusing an output with a blank.
    generated_workspace = db.scalar(
        select(Workspace).where(
            Workspace.kind == WorkspaceKind.STUDIO,
            Workspace.display_name == "Сгенерированный контент",
        )
    )
    if generated_workspace is None:
        generated_workspace = Workspace(
            display_name="Сгенерированный контент",
            kind=WorkspaceKind.STUDIO,
            owner_id=actor_id,
        )
        db.add(generated_workspace)
        db.flush()

    # Move older availability cards as well; their storage keys stay unchanged.
    db.execute(
        update(MediaFile)
        .where(
            MediaFile.workspace_id == template.workspace_id,
            MediaFile.original_name.like("generated-availability-%"),
        )
        .values(workspace_id=generated_workspace.id)
    )

    stem = f"generated-availability-{item.id}.jpg"
    generated = db.scalar(
        select(MediaFile).where(
            MediaFile.workspace_id == generated_workspace.id,
            MediaFile.original_name == stem,
            MediaFile.deleted_at.is_(None),
        )
    )
    if generated is None:
        generated = MediaFile(
            owner_id=actor_id,
            uploaded_by_id=actor_id,
            workspace_id=generated_workspace.id,
            storage_key=f"generated/availability/{item.id}.jpg",
            original_name=stem,
            media_type=MediaType.IMAGE,
            mime_type="image/jpeg",
            size_bytes=0,
            checksum_sha256="0" * 64,
            publication_allowed=True,
            comment="Автоматически собранный макет свободных окон",
            captured_at=datetime.now(UTC),
        )
        db.add(generated)
        db.flush()

    target = original_path(settings, generated.storage_key)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".tmp")
    with Image.open(source) as raw:
        image = ImageOps.exif_transpose(raw).convert("RGB")
        image = draw_availability_overlay(image, slots, template.original_name)
        image.save(temporary, format="JPEG", quality=94, optimize=True)
    temporary.replace(target)
    thumbnail_path(settings, generated.id).unlink(missing_ok=True)
    generated.size_bytes = target.stat().st_size
    generated.checksum_sha256 = hashlib.sha256(target.read_bytes()).hexdigest()
    generated.mime_type = "image/jpeg"
    generated.publication_allowed = True
    return generated
