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


def _line_for(times: object, width: int, font: ImageFont.FreeTypeFont) -> str:
    values = [str(value) for value in times] if isinstance(times, list) else []
    chosen: list[str] = []
    for value in values:
        attempt = " · ".join([*chosen, value])
        if chosen and font.getlength(attempt) > width:
            break
        chosen.append(value)
    if not chosen:
        return "—"
    return " · ".join(chosen)


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

    by_date: dict[str, list[str]] = {}
    for slot in slots:
        day = str(slot.get("date") or "")
        times = slot.get("times")
        if day and isinstance(times, list):
            by_date[day] = [str(value) for value in times]

    target = original_path(settings, generated.storage_key)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".tmp")
    with Image.open(source) as raw:
        image = ImageOps.exif_transpose(raw).convert("RGB")
        draw = ImageDraw.Draw(image)
        width, height = image.size
        # Template fields occupy the left half. Coordinates scale with the source,
        # so the same branded layout works for 1080×1920 and larger exports.
        # Keep inserted times inside the gold outlines and clear of the star.
        x = int(width * 0.082)
        field_width = int(width * 0.295)
        # The text belongs in the centre of the outlined row, not next to the
        # weekday label above it.  The earlier values anchored it roughly one
        # label-height too high on the actual studio templates.
        start_y = int(height * 0.375)
        step = int(height * 0.0658)
        # A phone is the primary viewing surface for these cards.  Keep the
        # values noticeably larger than the template labels, while _line_for
        # still trims the list before a value can collide with the star.
        font = _font(max(20, int(width * 0.024)), bold=False)
        # The template has permanent Monday–Sunday rows.  A sparse list of
        # availability must therefore be mapped by the real calendar weekday,
        # never by its position in the response (otherwise Thursday becomes
        # the first row, i.e. Monday).  Including the date also makes a
        # published card unambiguous when a week crosses a month boundary.
        for day, times in sorted(by_date.items()):
            try:
                index = date.fromisoformat(day).weekday()
            except ValueError:
                continue
            date_label = f"{day[8:10]}.{day[5:7]}"
            prefix = f"{date_label} · "
            text = prefix + _line_for(
                times,
                max(1, field_width - int(font.getlength(prefix))),
                font,
            )
            box = draw.textbbox((0, 0), text, font=font)
            text_width = box[2] - box[0]
            # Centre the actual glyph box, rather than its baseline, inside
            # the template field. This keeps every date/time line visually
            # centred even when a font has a non-zero top bearing.
            text_x = x + (field_width - text_width) // 2
            text_y = start_y + index * step - (box[1] + box[3]) // 2
            draw.text((text_x, text_y), text, font=font, fill=(255, 244, 215))
        image.save(temporary, format="JPEG", quality=94, optimize=True)
    temporary.replace(target)
    thumbnail_path(settings, generated.id).unlink(missing_ok=True)
    generated.size_bytes = target.stat().st_size
    generated.checksum_sha256 = hashlib.sha256(target.read_bytes()).hexdigest()
    generated.mime_type = "image/jpeg"
    generated.publication_allowed = True
    return generated
