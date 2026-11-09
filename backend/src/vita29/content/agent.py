import base64
import json
import re
import socket
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from vita29.db.models import (
    ContentFormat,
    ContentItem,
    MediaFile,
    MediaType,
    Workspace,
    WorkspaceKind,
    YclientsStaffMapping,
)
from vita29.integrations.store import IntegrationConfigurationError, config_value, read_secret
from vita29.media.storage import create_thumbnail, create_video_thumbnail
from vita29.settings import Settings


class ContentAgentError(RuntimeError):
    """A safe, user-visible failure while a draft is being prepared."""


@dataclass(frozen=True)
class PreparedTelegramDraft:
    caption: str
    media_ids: list[str]


@dataclass(frozen=True)
class TemplateRecognition:
    media_id: str
    staff_id: int


MEDIA_CATEGORIES = (
    "lips", "brows", "eyeliner", "piercing", "lashes",
    "rf_lifting", "biorevitalization", "smas", "other", "unknown",
)


def _topic_categories(topic: str) -> set[str]:
    """Return the treatment areas explicitly requested by the editor.

    This is deliberately conservative: it is used as a safety gate after the
    visual model has inspected a thumbnail, never as a substitute for looking
    at the client photo.
    """
    text = topic.casefold()
    categories: set[str] = set()
    if re.search(r"губ|lip", text):
        categories.add("lips")
    if re.search(r"бров|brow", text):
        categories.add("brows")
    if re.search(r"стрелк|межреснич|eyeliner|лайнер", text):
        categories.add("eyeliner")
    if re.search(r"пирсинг|серьг|ухо|pierc", text):
        categories.add("piercing")
    if re.search(r"ресниц|lash", text):
        categories.add("lashes")
    if re.search(r"рф[ -]?лифтинг|rf[ -]?lifting", text):
        categories.add("rf_lifting")
    if re.search(r"биоревитал|\bбио\b|biorev", text):
        categories.add("biorevitalization")
    if re.search(r"смас|smas", text):
        categories.add("smas")
    return categories


def _service_workspaces(topic: str) -> list[str]:
    """Return an explicit service folder when the editor named one.

    Service folders are a stronger signal than a filename or an old visit
    comment.  This keeps an RF/SMAС/biorevitalization brief inside its own
    archive even before the visual model gives the final approval.
    """
    text = topic.casefold()
    folders: list[str] = []
    if re.search(r"рф[ -]?лифтинг|rf[ -]?lifting", text):
        folders.append("РФ лифтинг")
    if re.search(r"биоревитал|\bбио\b|biorev", text):
        folders.append("био")
    if re.search(r"смас|smas", text):
        folders.append("смас")
    return folders


def _video_requested(item: ContentItem) -> bool:
    """Treat an explicit request for a video as a hard media constraint.

    A still from a video is useful for visual inspection, but it must never
    silently turn a request for a video into a photo post.
    """
    text = f"{item.title}\n{item.editor_instruction or ''}".casefold()
    return bool(re.search(r"видео|видеоролик|ролик|reels?|рилс", text))


def _staff_comment_score(mapping: YclientsStaffMapping, comment: str) -> int:
    """Match an administrator-written template comment to one, exact master.

    A partial first-name match is deliberately not enough: «Светлана ПМ» must
    never also select a template labelled «Светлана косметолог».  Sofia is the
    one spelling exception in YCLIENTS: the studio labels that template «Соня».
    """
    text = comment.casefold()
    name_tokens = re.findall(r"[а-яёa-z]{2,}", mapping.staff_name.casefold())
    if not name_tokens:
        return 0

    first_name_variants = {name_tokens[0]}
    if name_tokens[0] == "софья":
        first_name_variants.add("соня")
    if not any(token in text for token in first_name_variants):
        return 0

    # Every role/name qualifier in the display name is mandatory.  This is what
    # separates «Светлана ПМ» from the cosmetologist with the same first name.
    qualifiers = name_tokens[1:]
    specialty = (mapping.specialization or "").casefold()
    if "косметолог" in specialty:
        qualifiers.append("косметолог")
    if "ресниц" in specialty:
        qualifiers.append("ресниц")
    if any(token not in text for token in qualifiers):
        return 0
    return 1 + len(qualifiers)


def staff_from_title(title: str, staff: list[YclientsStaffMapping]) -> YclientsStaffMapping | None:
    """Use the master named by the editor in the content topic, when unambiguous."""
    matches = [(_staff_comment_score(entry, title), entry) for entry in staff]
    matches.sort(key=lambda result: result[0], reverse=True)
    if not matches or matches[0][0] == 0:
        return None
    score, selected = matches[0]
    tied = [entry for candidate_score, entry in matches if candidate_score == score]
    if len(tied) > 1:
        # «Кристина» without a role means the permanent-makeup master, not lashes.
        generic = [entry for entry in tied if not entry.specialization or "ресниц" not in entry.specialization.casefold()]
        if len(generic) != 1:
            return None
        selected = generic[0]
    return selected


def _read_secret(path: Path, name: str) -> str:
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise ContentAgentError(f"{name} is not configured") from error
    if not value:
        raise ContentAgentError(f"{name} is not configured")
    return value


def read_openai_secret(settings: Settings) -> str:
    """Prefer the write-only admin setting while keeping legacy deployment secrets working."""
    try:
        return read_secret(settings, "openai_api_key", settings.openai_api_key_file, "OpenAI access")
    except IntegrationConfigurationError as error:
        raise ContentAgentError(str(error)) from error


def content_model(settings: Settings) -> str:
    return config_value(settings, "openai_model", settings.openai_content_model)


_OPENAI_DNS_LOCK = threading.Lock()


@contextmanager
def openai_ipv4_client(timeout: float):
    """Create a short-lived OpenAI client that resolves only the IPv4 address.

    The Pi's optional VPN currently advertises an IPv6 address but has no IPv6
    route to the public internet. httpx normally tries that unusable IPv6
    address first, so only calls to api.openai.com are serialised and forced to
    IPv4; normal LAN/VPN routing remains untouched.
    """
    original_getaddrinfo = socket.getaddrinfo

    def ipv4_openai(host: str, port: object, family: int = 0, *args: object, **kwargs: object):
        if host == "api.openai.com":
            return original_getaddrinfo(host, port, socket.AF_INET, *args, **kwargs)
        return original_getaddrinfo(host, port, family, *args, **kwargs)

    with _OPENAI_DNS_LOCK:
        socket.getaddrinfo = ipv4_openai  # type: ignore[assignment]
        try:
            with httpx.Client(timeout=timeout) as client:
                yield client
        finally:
            socket.getaddrinfo = original_getaddrinfo  # type: ignore[assignment]


def ensure_openai_response(response: httpx.Response) -> httpx.Response:
    # A generic HTTP error left the editor with the unhelpful message
    # “Не удалось выполнить действие”. Make a regional availability error
    # actionable, without exposing the key or the response internals.
    if response.status_code == 403:
        try:
            code = str(response.json().get("error", {}).get("code", ""))
        except (ValueError, TypeError):
            code = ""
        if code == "unsupported_country_region_territory":
            raise ContentAgentError(
                "OpenAI API недоступен с текущего внешнего IP сервера. "
                "Нужен официальный развёрнутый доступ из поддерживаемого региона."
            )
    return response


def _openai_post(url: str, *, api_key: str, payload: dict[str, object], timeout: float) -> httpx.Response:
    with openai_ipv4_client(timeout) as client:
        response = client.post(url, headers={"Authorization": f"Bearer {api_key}"}, json=payload)
    return ensure_openai_response(response)


def _response_text(payload: dict) -> str:
    text = payload.get("output_text")
    if isinstance(text, str) and text.strip():
        return text
    for item in payload.get("output", []):
        if item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if content.get("type") == "output_text" and isinstance(content.get("text"), str):
                return content["text"]
    raise ContentAgentError("The content agent returned no draft")


def _candidate_context(candidates: list[MediaFile]) -> str:
    entries: list[dict[str, str | None]] = []
    for media in candidates:
        entries.append(
            {
                "id": media.id,
                "type": media.media_type.value,
                "folder": media.workspace.display_name,
                "captured_at": media.captured_at.isoformat() if media.captured_at else None,
                "file_comment": media.comment,
                "series_comment": media.batch.comment if media.batch is not None else None,
                "visit_procedures": media.yclients_visit.service_titles if media.yclients_visit is not None else None,
            }
        )
    return json.dumps(entries, ensure_ascii=False, separators=(",", ":"))


def _shortlist_for_topic(candidates: list[MediaFile], title: str) -> list[MediaFile]:
    """Prioritise a matching staff/procedure folder before asking the model to look."""
    tokens = {token for token in re.findall(r"[а-яёa-z0-9]{3,}", title.lower())}

    wanted_categories = _topic_categories(title)
    category_terms = {
        "lips": ("губ", "lip"),
        "brows": ("бров", "brow"),
        "eyeliner": ("стрелк", "межреснич", "eyeliner", "лайнер"),
        "piercing": ("пирсинг", "серьг", "ухо", "pierc"),
        "lashes": ("ресниц", "lash"),
        "rf_lifting": ("рф", "rf", "лифтинг"),
        "biorevitalization": ("био", "биоревитал", "biorev"),
        "smas": ("смас", "smas"),
    }

    def score(media: MediaFile) -> tuple[int, str]:
        batch_comment = media.batch.comment if media.batch is not None else ""
        haystack = " ".join(
            value for value in (media.workspace.display_name, media.comment, batch_comment, media.original_name)
            if value
        ).lower()
        matched_categories = {
            category for category, terms in category_terms.items()
            if any(term in haystack for term in terms)
        }
        semantic_score = 0
        if wanted_categories and matched_categories:
            if matched_categories & wanted_categories:
                semantic_score += 100
            if matched_categories - wanted_categories:
                semantic_score -= 80
        return (semantic_score + sum(1 for token in tokens if token in haystack), media.created_at.isoformat())

    return sorted(candidates, key=score, reverse=True)[:24]


def _marked_material_matches_topic(media: MediaFile, title: str) -> bool:
    """Decide whether an editorially marked file has evidence for this topic.

    A mark is an editorial preference, not a licence to put a lip, piercing or
    unrelated service into an eyeliner post.  If a concrete procedure is
    requested, the folder/comment/file metadata must name that procedure.
    Broad editorial requests have no procedure to validate and may use any
    marked material.
    """
    wanted_categories = _topic_categories(title)
    if not wanted_categories:
        return True
    batch_comment = media.batch.comment if media.batch is not None else ""
    haystack = " ".join(
        value
        for value in (media.workspace.display_name, media.comment, batch_comment, media.original_name)
        if value
    )
    return bool(_topic_categories(haystack) & wanted_categories)


def _visual_candidates(
    candidates: list[MediaFile], settings: Settings
) -> tuple[list[MediaFile], list[dict[str, object]]]:
    """Return only candidates for which a thumbnail is actually attached.

    The model receives a tiny still frame for videos too.  Keeping both lists
    in the same loop makes an ID in the metadata correspond to the exact image
    the model inspected; failed thumbnails are never silently shifted.
    """
    verified: list[MediaFile] = []
    content: list[dict[str, object]] = []
    for media in candidates:
        try:
            preview = (
                create_video_thumbnail(settings, media.storage_key, media.id)
                if media.media_type == MediaType.VIDEO
                else create_thumbnail(settings, media.storage_key, media.id)
            )
            encoded = base64.b64encode(preview.read_bytes()).decode("ascii")
        except OSError:
            continue
        verified.append(media)
        content.append({
            "type": "input_image",
            "image_url": f"data:image/jpeg;base64,{encoded}",
            "detail": "low",
        })
    return verified, content


def recognize_template_staff(
    db: Session, settings: Settings, staff: list[YclientsStaffMapping], title: str = ""
) -> TemplateRecognition:
    """Read a master name from an image in the shared «Шаблоны» folder.

    Only the low-resolution template previews are sent to the model. Client work,
    visits and private folders are never part of this request.
    """
    named_staff = staff_from_title(title, staff)
    if named_staff is not None:
        template = template_for_staff(db, named_staff.staff_id, staff)
        return TemplateRecognition(media_id=template.id, staff_id=named_staff.staff_id)

    templates = db.scalars(
        select(MediaFile)
        .join(Workspace, MediaFile.workspace_id == Workspace.id)
        .where(
            MediaFile.deleted_at.is_(None),
            MediaFile.media_type == "image",
            Workspace.kind == WorkspaceKind.STUDIO,
            Workspace.display_name.ilike("Шаблоны"),
        )
        .order_by(MediaFile.created_at.desc())
        .limit(12)
    ).all()
    if not templates:
        raise ContentAgentError("В папке «Шаблоны» нет изображения для свободных окон")

    # The administrator explicitly labels every template with its master in the
    # media comment. That is more reliable than visual recognition and prevents a
    # template for one master being used for another one.
    for template in templates:
        matches = sorted(
            ((_staff_comment_score(entry, template.comment or ""), entry) for entry in staff),
            key=lambda result: result[0], reverse=True,
        )
        if matches and matches[0][0] > 0:
            # For two identically named masters, a generic «Кристина» template
            # means the non-specialised/permanent-makeup master; a detailed role
            # in the comment wins via its higher score.
            best_score, best = matches[0]
            tied = [entry for score, entry in matches if score == best_score]
            if len(tied) > 1:
                generic = [entry for entry in tied if not entry.specialization or "ресниц" not in entry.specialization.casefold()]
                if len(generic) == 1:
                    best = generic[0]
                else:
                    continue
            return TemplateRecognition(media_id=template.id, staff_id=best.staff_id)

    api_key = read_openai_secret(settings)
    content: list[dict[str, object]] = [{
        "type": "input_text",
        "text": (
            "На каком из изображений есть имя одного из мастеров? Выбери один шаблон и "
            "точно сопоставь имя со списком. Не угадывай: если имени нет, верни null. "
            f"Мастера: {json.dumps([{'id': entry.staff_id, 'name': entry.staff_name} for entry in staff], ensure_ascii=False)}"
        ),
    }]
    attached_templates: list[MediaFile] = []
    for template in templates:
        try:
            preview = create_thumbnail(settings, template.storage_key, template.id)
            encoded = base64.b64encode(preview.read_bytes()).decode("ascii")
        except OSError:
            continue
        content.append({
            "type": "input_image",
            "image_url": f"data:image/jpeg;base64,{encoded}",
            "detail": "low",
        })
        attached_templates.append(template)
    if len(content) == 1:
        raise ContentAgentError("Не удалось прочитать изображение из папки «Шаблоны»")
    schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "template_index": {"type": ["integer", "null"]},
            "staff_id": {"type": ["integer", "null"]},
        },
        "required": ["template_index", "staff_id"],
    }
    body = {
        "model": content_model(settings),
        "input": [{"role": "user", "content": content}],
        "text": {"format": {"type": "json_schema", "name": "template_master", "strict": True, "schema": schema}},
        "max_output_tokens": 250,
    }
    if str(body['model']).startswith('gpt-6.1-sol'):
        body['reasoning'] = {'effort': 'low'}
        body['max_output_tokens'] = 600
    try:
        response = _openai_post(
            "https://api.openai.com/v1/responses", api_key=api_key, payload=body,
            timeout=settings.openai_http_timeout_seconds,
        )
        response.raise_for_status()
        output = json.loads(_response_text(response.json()))
        index = output.get("template_index")
        staff_id = output.get("staff_id")
    except (httpx.HTTPError, json.JSONDecodeError, TypeError, ValueError) as error:
        raise ContentAgentError("Не удалось определить мастера на шаблоне") from error
    # template_index corresponds to the order of successfully attached images.
    permitted_staff_ids = {entry.staff_id for entry in staff}
    if not isinstance(index, int) or not isinstance(staff_id, int) or staff_id not in permitted_staff_ids:
        raise ContentAgentError("На шаблоне не удалось уверенно определить мастера")
    if not 0 <= index < len(attached_templates):
        raise ContentAgentError("Не удалось выбрать шаблон для свободных окон")
    return TemplateRecognition(media_id=attached_templates[index].id, staff_id=staff_id)


def template_for_staff(
    db: Session, staff_id: int, staff: list[YclientsStaffMapping]
) -> MediaFile:
    """Return the template whose administrator comment identifies this master."""
    mapping = next((entry for entry in staff if entry.staff_id == staff_id), None)
    if mapping is None:
        raise ContentAgentError("Выбранный мастер не найден в настройках YCLIENTS")
    templates = db.scalars(
        select(MediaFile)
        .join(Workspace, MediaFile.workspace_id == Workspace.id)
        .where(
            MediaFile.deleted_at.is_(None),
            MediaFile.media_type == "image",
            Workspace.kind == WorkspaceKind.STUDIO,
            Workspace.display_name.ilike("Шаблоны"),
        )
        .order_by(MediaFile.created_at.desc())
    ).all()
    exact = [template for template in templates if _staff_comment_score(mapping, template.comment or "") > 0]
    if len(exact) != 1:
        raise ContentAgentError(
            f"Для мастера «{mapping.staff_name}» нужен один шаблон с этим именем в комментарии к фото"
        )
    return exact[0]


def prepare_telegram_draft(
    db: Session, item: ContentItem, settings: Settings
) -> PreparedTelegramDraft:
    """Select public studio media and write a Telegram draft without sending client data."""
    api_key = read_openai_secret(settings)
    candidate_query = (
        select(MediaFile)
        .join(Workspace, MediaFile.workspace_id == Workspace.id)
        .where(
            MediaFile.deleted_at.is_(None),
            MediaFile.publication_allowed.is_(True),
            ~MediaFile.original_name.like("generated-availability-%"),
        )
    )
    automatic_selection = False
    if item.content_format == ContentFormat.AVAILABILITY:
        # Branded announcement layouts are deliberately kept separate from client work.
        candidate_query = candidate_query.where(
            Workspace.kind == WorkspaceKind.STUDIO,
            Workspace.display_name.ilike("Шаблоны"),
        )
        try:
            pinned_template_ids = json.loads(item.media_ids_json)
        except (TypeError, json.JSONDecodeError):
            pinned_template_ids = []
        if isinstance(pinned_template_ids, list) and pinned_template_ids:
            candidate_query = candidate_query.where(MediaFile.id.in_(pinned_template_ids))
    else:
        # A manual selection in the planner is intentional: never replace it
        # with a semantically similar-but-wrong client result.
        try:
            selected_ids = json.loads(item.media_ids_json)
        except (TypeError, json.JSONDecodeError):
            selected_ids = []
        if isinstance(selected_ids, list) and selected_ids:
            # The API checked access when the selection was saved. Do not add
            # the studio-only filter here: an editor may deliberately choose a
            # permitted file from a private folder they are allowed to access.
            candidate_query = candidate_query.where(MediaFile.id.in_(selected_ids))
        else:
            automatic_selection = True
            candidate_query = candidate_query.where(
                Workspace.kind == WorkspaceKind.STUDIO,
                Workspace.display_name.notin_(["Шаблоны", "Сгенерированный контент"]),
            )
            service_folders = _service_workspaces(f"{item.title}\n{item.editor_instruction or ''}")
            if service_folders:
                # These service folders have canonical Russian names.  Do not
                # use SQL lower() here: SQLite only lowercases ASCII, causing
                # «РФ лифтинг» to be missed on production even when it exists.
                candidate_query = candidate_query.where(Workspace.display_name.in_(service_folders))
    video_requested = _video_requested(item)
    if video_requested:
        candidate_query = candidate_query.where(MediaFile.media_type == MediaType.VIDEO)
    all_candidates = db.scalars(
        candidate_query.order_by(
            MediaFile.content_marked.desc(),
            MediaFile.captured_at.desc(),
            MediaFile.created_at.desc(),
        ).limit(120)
    ).all()
    if automatic_selection:
        # Prefer only marked material that has evidence for the requested
        # procedure. If the marked pool has no suitable candidate, deliberately
        # fall back to the normal publication-approved library.
        marked_matches = [
            media for media in all_candidates
            if media.content_marked and _marked_material_matches_topic(media, item.title)
        ]
        fallback_candidates = [media for media in all_candidates if not media.content_marked]
        candidates = _shortlist_for_topic(marked_matches or fallback_candidates, item.title)
    else:
        candidates = _shortlist_for_topic(all_candidates, item.title)
    if video_requested and not candidates:
        raise ContentAgentError(
            "В теме указано видео, но среди доступных материалов нет подходящего видео. "
            "Выберите видео вручную или снимите новый ролик."
        )
    # The metadata list and visual list must be exactly aligned. Video candidates
    # contribute their first preview frame, so service folders can provide either
    # photos or video without opening a path to a mismatched ID.
    candidates, visual_inputs = _visual_candidates(candidates, settings)
    candidate_ids = {media.id for media in candidates}
    requested_categories = _topic_categories(f"{item.title}\n{item.editor_instruction or ''}")
    system = (
        "Ты редактор контента студии VIOLETTA. Подготовь русскоязычный черновик публикации "
        "для Telegram по согласованной теме. Используй только переданный список разрешённых "
        "материалов. Комментарии к фото и серии — это контекст, а не текст для дословного "
        "копирования. Не раскрывай имена клиентов, даты визитов, личные данные и медицинскую "
        "информацию. Не обещай результат и не используй медицинские утверждения. Обязательно "
        "сверяй тему с папкой-источником и видимой миниатюрой: никогда не выбирай материал из "
        "чужой специализации (например, пирсинг для темы о стрелках). Для каждого выбранного "
        "файла сначала определи, что действительно видно крупным планом. Область процедуры должна "
        "быть главным, крупным объектом кадра, а не просто случайно попадать в общий портрет. "
        "Губы допустимы только если на кадре отчётливо и крупно видны губы; брови — только если "
        "брови крупно видны и являются главным объектом; стрелки — только если крупно виден глаз "
        "со стрелкой/межресничкой; ресницы — только если крупно видны глаза и ресницы; пирсинг — "
        "только если крупно видно ухо или другую часть тела с украшением. Если процедура по "
        "подписи или папке противоречит изображению, не выбирай файл. Если подходящего кадра "
        "нет, верни пустой список материалов и напиши честный текст без фото. Тон: тёплый, "
        "уверенный, профессиональный; 1–3 уместных эмодзи; короткие абзацы; мягкий призыв "
        "записаться или задать вопрос. Не повторяй служебные слова из задачи редактора вроде "
        "«сгенерируй», «создай», «баннер», «для рекламы» или название платформы. Собирай "
        "смысл согласованной темы и последующих уточнений в цельный клиентский текст: сохраняй "
        "все явно указанные факты, условия, цены и даты, исправляй очевидные опечатки и "
        "пунктуацию, но не добавляй неподтверждённые обещания, скидки или характеристики. "
        "Если список разрешённых материалов не пуст, обязательно "
        "выбери от 1 до 10 наиболее подходящих файлов: текстовый пост допустим только при пустом "
        "списке. Верни только JSON по схеме."
    )
    if automatic_selection:
        system += (
            " Материалы с пометкой «для контента» имеют приоритет и были переданы "
            "первыми только если их подпись/папка соответствует теме. Если среди них "
            "нет подходящего материала, использован обычный разрешённый архив."
        )
    if video_requested:
        system += (
            " В теме явно запрошено видео: выбирай только видеофайлы. "
            "Никогда не подменяй запрос на видео фотографией."
        )
    schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "caption": {"type": "string"},
            "selected_media": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "id": {"type": "string"},
                        "category": {"type": "string", "enum": list(MEDIA_CATEGORIES)},
                        "procedure_visible": {"type": "boolean"},
                    },
                    "required": ["id", "category", "procedure_visible"],
                },
            },
        },
        "required": ["caption", "selected_media"],
    }
    body = {
        "model": content_model(settings),
        "input": [
            {"role": "developer", "content": system},
            {
                "role": "user",
                "content": [{"type": "input_text", "text": (
                    f"Согласованная тема: {item.title}\n"
                    f"Уточнение редактора: {item.editor_instruction or 'нет'}\n"
                    "Правила визуальной проверки: для губ, бровей, стрелок, ресниц и пирсинга "
                    "покажи только кадр, где нужная зона крупная и центральная; не выбирай общий "
                    "портрет, в котором нужная зона лишь немного видна. Губы — только губы; брови "
                    "— только брови; стрелки — только глаза с межресничкой/стрелкой; пирсинг — "
                    "уши либо другие части тела с украшением; РФ-лифтинг, био и СМАС — только если кадр взят из "
                    "точно соответствующей специализированной папки и на нём отчётливо видны лицо, "
                    "зона кожи, процедура или её результат. Для этих трёх услуг папка является "
                    "авторитетным вторым сигналом: не нужно угадывать процедуру только по устройству, "
                    "но нельзя выбирать предметы, интерфейс, текст или чужую зону тела. Если есть "
                    "сомнение — не выбирай. "
                    "Не подменяй одну процедуру другой.\n"
                    f"Допустимая категория для этой темы: {', '.join(sorted(requested_categories)) or 'не задана'}.\n"
                    f"Формат: {item.content_format.value}. "
                    f"Если формат story — напиши коротко и динамично, это текст для истории. "
                    f"Если availability — говори только о переданных свободных окнах и предложи записаться.\n"
                    f"Максимум материалов: {item.media_limit}\n"
                    f"Свободные окна: {item.availability_slots_json}\n"
                    f"Дата публикации: {item.scheduled_at.isoformat()}\n"
                    f"Разрешённые материалы в том же порядке, что приложенные миниатюры: {_candidate_context(candidates)}"
                )}, *visual_inputs],
            },
        ],
        "text": {"format": {"type": "json_schema", "name": "telegram_draft", "strict": True, "schema": schema}},
        "max_output_tokens": 1400,
    }
    if str(body['model']).startswith('gpt-6.1-sol'):
        body['reasoning'] = {'effort': 'low'}
        body['max_output_tokens'] = 2500
    try:
        response = _openai_post(
            "https://api.openai.com/v1/responses", api_key=api_key, payload=body,
            timeout=settings.openai_http_timeout_seconds,
        )
        response.raise_for_status()
        output = json.loads(_response_text(response.json()))
    except (httpx.HTTPError, json.JSONDecodeError, TypeError, ValueError) as error:
        raise ContentAgentError("The content agent could not prepare a draft. Try again later.") from error
    caption = str(output.get("caption", "")).strip()
    selected_media = output.get("selected_media", [])
    if not caption or len(caption) > 4000:
        raise ContentAgentError("The content agent returned an invalid caption")
    if not isinstance(selected_media, list) or len(selected_media) > item.media_limit:
        raise ContentAgentError("The content agent selected an invalid number of files")
    # A relevant text-only draft is safer than putting a client image from another
    # procedure into a publication. The editor can choose "Другие материалы" after
    # adding a better tagged image.
    selected_media_ids: list[str] = []
    for selected in selected_media:
        if not isinstance(selected, dict):
            raise ContentAgentError("The content agent selected an invalid file")
        media_id = selected.get("id")
        category = selected.get("category")
        visible = selected.get("procedure_visible")
        if not isinstance(media_id, str) or media_id not in candidate_ids:
            raise ContentAgentError("The content agent selected an unavailable file")
        if not isinstance(category, str) or category not in MEDIA_CATEGORIES or not isinstance(visible, bool):
            raise ContentAgentError("The content agent did not verify the selected file")
        if requested_categories and (category not in requested_categories or not visible):
            raise ContentAgentError("Подобранный кадр не подтверждает указанную процедуру")
        selected_media_ids.append(media_id)
    if len(set(selected_media_ids)) != len(selected_media_ids):
        raise ContentAgentError("The content agent selected the same file twice")
    if video_requested and (not selected_media_ids or any(
        next(media for media in candidates if media.id == media_id).media_type != MediaType.VIDEO
        for media_id in selected_media_ids
    )):
        raise ContentAgentError("Запрос с видео должен содержать хотя бы один выбранный видеофайл")
    return PreparedTelegramDraft(caption=caption, media_ids=selected_media_ids)
