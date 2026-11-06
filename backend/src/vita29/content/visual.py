"""On-demand branded visual generation for approved studio content.

The operation is never automatic: the editor must explicitly request a visual.
This keeps image-generation spend predictable and leaves ordinary photo posts
untouched.
"""

from __future__ import annotations

import base64
import hashlib
import io
import re
import uuid
from datetime import UTC, datetime

import httpx
from PIL import Image, ImageDraw, ImageFont, ImageOps
from sqlalchemy import select
from sqlalchemy.orm import Session

from vita29.content.agent import (
    ContentAgentError,
    ensure_openai_response,
    openai_ipv4_client,
    read_openai_secret,
)
from vita29.db.models import ContentItem, MediaFile, MediaType, Workspace, WorkspaceKind
from vita29.integrations.store import config_value
from vita29.media.storage import create_thumbnail, original_path
from vita29.settings import Settings

# This is the studio's reusable marketing brief. It reflects the decisions a
# senior beauty marketer makes before handing copy to a designer.
VIOLETTA_MARKETING_BANNER_RULES = """
Act as a senior beauty-studio marketer and art director. The banner has one
commercial idea only: one service, one benefit or offer, one clear action.

The studio, not the image model, typesets all readable Russian text. Create a
deliberately clean safe area in the selected visual family: either deep
charcoal with champagne-gold accents, or warm ivory with restrained taupe
editorial accents. Never add letters,
numbers, logos, watermarks, pseudo-Cyrillic or generic labels such as
"advertising banner". The local composition uses a fixed hierarchy:
1) a short offer heading, 2) a concrete service/value, 3) price or condition,
4) an optional short deadline. The heading is the largest readable line, a
price is the largest visual accent inside its offer card, explanatory detail
is smaller, and a deadline is the smallest. Every line is horizontally
centred in the reserved text block, uses a generous safe margin and is reduced
in size before it can overflow, clip or cover the model, a procedure result,
or the logo. Keep the layout wide, balanced and breathable rather than packing
text into a narrow corner. Use sentence case: the first letter is capitalised,
but names, abbreviations, prices and product names retain their correct form.

Never copy operational phrases such as "create", "write", "for advertising",
platform names, an editor's note, or the raw prompt into client-facing copy.
Preserve every stated price, discount, date and service name; silently correct
obvious spelling, spacing, capitalisation and punctuation mistakes; never
invent a price, deadline, discount, equipment, procedure or result. Treat
later editor notes as refinements of the original brief, not as a replacement,
unless they explicitly say to replace the text.

STRICT EDITOR COPY RULE: when the editor explicitly supplies wording after
"Написать:", "Текст:", "Надпись:" or "Подписи:", that wording is a
verbatim production requirement. Use every supplied phrase, in the supplied
order and with its supplied punctuation. Do not replace it with a slogan,
summary, benefit, generic beauty copy or any other invented sentence. The
application typesets this exact copy itself; the image model must create no
readable text at all.
""".strip()

# The generated image is only the background.  All factual Russian copy is
# painted locally, so it never turns into random white AI lettering or a
# malformed glyph.  These tones deliberately echo the studio's champagne-gold
# frames while staying readable on a deep charcoal card.
_GOLD_TEXT = (235, 194, 119, 255)
_GOLD_TEXT_BRIGHT = (255, 221, 151, 255)
_GOLD_SHADOW = (8, 6, 4, 220)
_GOLD_OUTLINE = (92, 61, 24, 245)
_IVORY = (245, 239, 231, 255)
_TAUPE = (104, 82, 70, 255)
_TAUPE_SOFT = (166, 143, 126, 255)


def _visual_style(
    topic_hint: str,
    instruction: str | None,
    *,
    collage: bool = False,
    requested_style: str | None = None,
) -> str:
    """Resolve a visual family without letting an old note override a choice.

    ``requested_style`` comes from the explicit editor control.  It is the
    source of truth: a light choice always produces the light editorial family
    and a dark choice always produces the dark-gold family.  Natural-language
    detection remains only as a backwards-compatible ``auto`` fallback.
    """
    selected = (requested_style or "auto").strip().casefold()
    if selected in {"light", "dark"}:
        return selected

    text = f"{topic_hint}\n{instruction or ''}".casefold()
    asks_light = bool(re.search(r"бел\w*|светл|крем|молоч|беж|нюд|редакцион|editorial|light", text))
    asks_dark = bool(re.search(r"т[её]мн|ч[её]рн|графит|dark", text))
    # If the free-form brief contains both terms, it is ambiguous.  Do not try
    # to give one word priority based on its position; preserve a stable
    # default until the editor explicitly chooses a family in the control.
    if asks_light and not asks_dark:
        return "light"
    if asks_dark and not asks_light:
        return "dark"
    return "light" if collage else "dark"


def _wants_collage(topic_hint: str, instruction: str | None = None) -> bool:
    """Recognise normal Russian spellings of a multi-photo collage request."""
    text = f"{topic_hint}\n{instruction or ''}".casefold()
    return bool(re.search(
        r"кол+аж|колаж|калаж|нескольк\w*(?:\s+\w+){0,3}\s+(?:фото|снимк|кадр)|"
        r"(?:фото|снимк|кадр).{0,36}(?:вместе|кол+аж|колаж|калаж)",
        text,
    ))


def _font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    for location in ("/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/dejavu"):
        try:
            return ImageFont.truetype(f"{location}/{name}", size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def _serif_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    """Use a restrained serif face for the VIOLETTA wordmark."""
    names = ("DejaVuSerif-Bold.ttf", "DejaVuSerif.ttf") if bold else ("DejaVuSerif.ttf", "DejaVuSerif-Bold.ttf")
    for location in ("/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/dejavu"):
        for name in names:
            try:
                return ImageFont.truetype(f"{location}/{name}", size=size)
            except OSError:
                continue
    return _font(size, bold=bold)


def _draw_brand_lockup(
    draw: ImageDraw.ImageDraw, x: int, y: int, scale: float = 1.0, *, style: str = "dark"
) -> None:
    """Paint the studio logo as a transparent lockup.

    Image models are deliberately not trusted with brand marks or Cyrillic
    lettering.  This lockup has no opaque backing rectangle: it is composited
    directly over the generated image, just like a transparent logo asset.
    """
    soft_gold = (225, 185, 117, 235) if style == "dark" else _TAUPE_SOFT
    brand_gold = _GOLD_TEXT_BRIGHT if style == "dark" else _TAUPE
    size = round(88 * scale)
    stroke = max(2, round(2 * scale))
    draw.rectangle((x, y, x + size, y + size), outline=soft_gold, width=stroke)
    # The small VA monogram mirrors the studio's square logo without asking an
    # image model to render it.  A fine gold stroke evokes the pen in the mark.
    draw.text((x + round(14 * scale), y + round(15 * scale)), "V", font=_serif_font(round(52 * scale), bold=False), fill=brand_gold)
    draw.text((x + round(43 * scale), y + round(31 * scale)), "A", font=_serif_font(round(42 * scale), bold=False), fill=brand_gold)
    draw.line(
        (x + round(46 * scale), y + round(63 * scale), x + round(61 * scale), y + round(24 * scale)),
        fill=soft_gold,
        width=max(2, round(4 * scale)),
    )
    word_x = x + size + round(22 * scale)
    draw.text((word_x, y + round(9 * scale)), "СТУДИЯ ЭСТЕТИКИ", font=_font(round(14 * scale)), fill=brand_gold)
    draw.text((word_x, y + round(34 * scale)), "V I O L E T T A", font=_serif_font(round(29 * scale)), fill=brand_gold)


def _generated_workspace(db: Session, actor_id: str) -> Workspace:
    workspace = db.scalar(
        select(Workspace).where(
            Workspace.kind == WorkspaceKind.STUDIO,
            Workspace.display_name == "Сгенерированный контент",
        )
    )
    if workspace is None:
        workspace = Workspace(
            display_name="Сгенерированный контент", kind=WorkspaceKind.STUDIO, owner_id=actor_id
        )
        db.add(workspace)
        db.flush()
    return workspace


def _visual_prompt(
    topic_hint: str,
    instruction: str,
    has_source: bool,
    *,
    collage: bool = False,
    requested_style: str | None = None,
) -> str:
    style = _visual_style(topic_hint, instruction, collage=collage, requested_style=requested_style)
    if style == "light":
        art_direction = (
            "a genuinely light warm-ivory, milk-white, cream and sand editorial background, subtle "
            "taupe line art and restrained warm-brown or champagne-gold accents. Never use a black, "
            "charcoal or dark-brown background, dark card, or dark text panel in this light family. "
            "Use clean beauty-magazine styling, smooth rounded organic panels, "
            "quiet botanical line motifs in the outer edge only, and generous breathing room. Place a "
            "natural close beauty portrait or the relevant treatment result on one side and keep the "
            "opposite/lower area clean for local typography. It must feel like an elegant VIOLETTA "
            "editorial layout, never like a generic pastel Instagram template. "
        )
    else:
        art_direction = (
            "deep near-black/charcoal and espresso background (#12100e), restrained champagne-gold "
            "accents, very thin Art-Deco gold arcs and frames, and fine flowing metallic-gold silk "
            "ribbons only in the outer corners. Use cinematic beauty-studio lighting, calm luxury "
            "editorial composition, generous clean negative space and refined asymmetry. A natural "
            "close beauty portrait occupies the left half; the right half and lower third remain calm "
            "and uncluttered for local campaign copy. "
        )
    base = (
        "Create one polished premium 2:3 vertical social-media visual for VIOLETTA, a Russian "
        f"aesthetics studio. The requested visual family is {style}. {art_direction}"
        "No neon, no pink or blue gradients, no loud stickers, no childish graphics. "
        "Do not render letters, words, numbers, logos, watermarks or gibberish; the transparent studio "
        "logo and any requested readable copy are added separately after generation. Do not imitate a "
        "specific person's face from an example layout. Never change the treatment area into another procedure. "
    )
    base += f"Marketing and layout rules: {VIOLETTA_MARKETING_BANNER_RULES} "
    if has_source:
        base += (
            "Preserve the person, anatomy and visible procedure from the supplied photo faithfully. "
            "Make only the requested tasteful retouching/design adjustments. "
        )
    if collage:
        base += (
            "The editor explicitly requests a collage: compose 2 to 4 supplied photographs of the same "
            "procedure into one coherent premium editorial collage. Keep each source recognisable, use "
            "a clear hero image plus smaller rounded supporting photos, and do not invent a different "
            "person, procedure or result. "
        )
    else:
        base += "Do not make a multi-photo collage unless the editor explicitly asks for one. "
    # Do not give the image model the exact post title or editor wording.  It
    # has a strong tendency to turn those words into ugly, duplicated text.
    # The readable title is painted locally after generation; this hint is used
    # solely to choose the correct kind of subject.
    topic = f"{topic_hint}\n{instruction}".casefold()
    # "ПМ" must never be interpreted as hardware cosmetology.  Make this
    # constraint explicit before more general lip/brow/eye keywords below:
    # the image model otherwise likes to add a generic salon handpiece.
    if re.search(r"перманент|\bпм\b|татуаж|межреснич|стрелк", topic):
        base += (
            "This is permanent makeup, not hardware cosmetology. Never show any device, "
            "handpiece, ultrasound/RF/SMAS machine, laser, wand, cable, gloved hand, needle, "
            "syringe, injection, treatment procedure or medical equipment. Show only a refined "
            "finished result and an elegant beauty close-up. "
        )
        if re.search(r"губ|lip", topic):
            base += "For permanent lip makeup, make only lips the clear visual focus; do not substitute brows, eyes or ears. "
        elif re.search(r"бров|brow", topic):
            base += "For permanent brows, make only eyebrows the clear visual focus; do not substitute lips, eyes or ears. "
        elif re.search(r"стрелк|межреснич|глаз|eye", topic):
            base += "For permanent eyeliner, make only the eyes and precise eyeliner the clear visual focus; do not substitute lips, brows or ears. "
    elif re.search(r"рф[ -]?лифтинг|rf[ -]?lifting", topic):
        base += (
            "Show only a non-invasive cosmetic device/handpiece on facial skin or an "
            "elegant non-procedural beauty portrait. Never show a needle, syringe, injection or filler. "
        )
    elif re.search(r"смас|smas", topic):
        base += (
            "Show only an appropriate non-invasive ultrasound/cosmetic device on facial "
            "skin or an elegant non-procedural beauty portrait. Never show a needle, syringe, injection or filler. "
        )
    elif re.search(r"биоревитал|\bбио\b|biorev", topic):
        base += (
            "Show a careful skincare-treatment close-up, hydrated skin, or a subtle "
            "professional injection step only when it is clearly appropriate. Do not depict another procedure. "
        )
    elif re.search(r"бров|brow", topic):
        base += "For brows, make eyebrows the clear visual focus; do not substitute lips, ears or unrelated procedures. "
    elif re.search(r"ресниц|lash", topic):
        base += "For lashes, make the eye and lashes the clear visual focus; do not substitute lips, ears or unrelated procedures. "
    elif re.search(r"губ|lip", topic):
        base += "For lips, make lips the clear visual focus; do not substitute brows, eyes, ears or unrelated procedures. "
    return base + "Use visual storytelling only. The final artwork must contain zero characters in every language."


def requires_generated_visual(title: str, instruction: str | None = None) -> bool:
    """Recognize an explicit request for a campaign visual in Russian.

    This intentionally lives on the server instead of only in the browser: a
    stale PWA bundle must never silently turn a request such as "Создай
    рекламный пост" into an ordinary archive-photo post.  JavaScript's ``\\b``
    also does not recognise Cyrillic letters as word characters, so use a
    whitespace/end-of-string boundary here.
    """
    request = f"{title}\n{instruction or ''}".casefold()
    return bool(re.search(
        r"сген(?:е|и)рир(?:уй|овать)|генерир(?:уй|овать)|генерац|"
        r"созда(?:й|ть|йте)(?=\s|$)|"
        r"картин|изображен|макет|баннер|ретуш|надпис|текст на фото|кол+аж|колаж|калаж|"
        r"добав(?:ь|ить)|убер(?:и|ать)|удал(?:и|ить)|замен(?:и|ить)|"
        r"перчатк|маск[ауи]|фон|логотип",
        request,
    ))


def _display_title(title: str) -> str:
    """Remove a command prefix before it is painted onto the finished visual."""
    cleaned = re.sub(
        r"^\s*(?:сген(?:е|и)рируй|созда(?:й|ть|йте))\s+(?:(?:рекламный|фирменный)\s+)?(?:пост(?:\s+о)?|изображение|картинку|макет|баннер|слайд)\s*[:—–-]?\s*(?:на|про|о)?\s*",
        "",
        title,
        flags=re.IGNORECASE,
    )
    return cleaned.strip() or title.strip()


def _capitalize_first_letter(value: str) -> str:
    """Use a sentence-case title without destroying names or abbreviations."""
    for index, char in enumerate(value):
        if char.isalpha():
            return f"{value[:index]}{char.upper()}{value[index + 1:]}"
    return value


def append_editor_instruction(existing: str | None, refinement: str) -> str:
    """Keep the original brief when an editor adds a small correction.

    The former implementation saved only the latest pop-up value. A request
    like "make the price larger" therefore erased the service, price and
    deadline. A compact chronology is stable for both the text agent and the
    visual generator without relying on browser state.
    """
    def without_generic_generation_phrase(value: str) -> str:
        # This was injected by an older dialog as a helper placeholder and
        # subsequently leaked into a visible brief. It carries no editorial
        # meaning, so keep the editor's real request but remove this exact
        # boilerplate wherever it appears.
        value = re.sub(
            r"(?:^|\s)создать\s+фирменное\s+изображение\s+для\s+публикации\.?",
            " ",
            value,
            flags=re.IGNORECASE,
        )
        return " ".join(value.split())

    fresh = without_generic_generation_phrase(refinement)
    previous = without_generic_generation_phrase(existing or "")
    if not previous:
        return fresh
    if not fresh or fresh.casefold() in previous.casefold():
        return previous
    # The dialog used to pre-fill the old brief. If it is returned together
    # with a manual edit, it already holds all context and must not duplicate.
    if previous.casefold() in fresh.casefold():
        return fresh
    merged = f"{previous}\n\nУточнение редактора: {fresh}"
    if len(merged) <= 4500:
        return merged
    # A later correction is more useful than the oldest filler. Keep the
    # original beginning (where the service/offer normally lives) and always
    # preserve the newest note instead of silently cutting it away.
    marker = "\n\nУточнение редактора: "
    remaining = max(0, 4500 - len(marker) - len(fresh))
    return f"{previous[:remaining].rstrip()}{marker}{fresh}"


def _normalize_campaign_text(value: str) -> str:
    """Apply safe deterministic Russian copy corrections before drawing."""
    cleaned = " ".join(value.replace("—", " — ").split())
    corrections = {
        " сгенирируй ": " сгенерируй ",
        " виолетта ": " VIOLETTA ",
    }
    padded = f" {cleaned} "
    for incorrect, correct in corrections.items():
        padded = re.sub(re.escape(incorrect), correct, padded, flags=re.IGNORECASE)
    cleaned = padded.strip()
    cleaned = re.sub(r"\bруб(?:лей|\.)?\b", "₽", cleaned, flags=re.IGNORECASE)
    # Banner fonts intentionally support a compact, controlled character set.
    # Emoji and uncommon glyphs from a caption otherwise render as empty squares
    # once the wording is painted into the final JPEG.
    allowed_punctuation = set(" .,;:!?…—–-+/%₽№()[]«»\\\"'")
    cleaned = "".join(
        char if char.isalnum() or char in allowed_punctuation else " " for char in cleaned
    )
    cleaned = re.sub(r"\s+([,.;:!?])", r"\1", cleaned)
    cleaned = re.sub(r"\s{2,}", " ", cleaned)
    return _capitalize_first_letter(cleaned)


def _wrap_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, width: int) -> list[str]:
    """Wrap words for a fixed caption block without cutting a word in half."""
    lines: list[str] = []
    current = ""
    for word in text.split():
        candidate = f"{current} {word}".strip()
        if current and draw.textlength(candidate, font=font) > width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def _fit_wrapped_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    width: int,
    preferred_size: int,
    minimum_size: int,
    max_lines: int,
    *,
    bold: bool = False,
    serif: bool = False,
) -> tuple[ImageFont.FreeTypeFont, list[str], int]:
    """Fit copy into a fixed safe area without cutting it off.

    The previous banner layout used one hard-coded size, so a longer service
    name could run past the gold contour. The local renderer now shrinks first
    and only adds an ellipsis as a last resort.
    """
    font_factory = _serif_font if serif else _font
    for size in range(preferred_size, minimum_size - 1, -2):
        font = font_factory(size, bold=bold)
        lines = _wrap_text(draw, text, font, width)
        if len(lines) <= max_lines:
            return font, lines, size

    font = font_factory(minimum_size, bold=bold)
    lines = _wrap_text(draw, text, font, width)
    if len(lines) > max_lines:
        visible = lines[:max_lines]
        final = visible[-1].rstrip(" ,.;:—–-")
        while final and draw.textlength(f"{final}…", font=font) > width:
            final = final[:-1].rstrip()
        visible[-1] = f"{final or '…'}…"
        lines = visible
    return font, lines, minimum_size


def _caption_hint_copy(value: str | None) -> str | None:
    """Use a useful sentence of the prepared caption only as a fallback.

    This avoids the mechanical card title on a banner when the editor did not
    write an explicit "Написать:" line, without putting an entire long-form
    Telegram caption over the image.
    """
    if not value:
        return None
    compact = " ".join(value.split())
    if not compact:
        return None
    sentences = re.split(r"(?<=[.!?])\s+", compact)
    for sentence in sentences:
        if re.search(r"акци|скидк|купон|подар|₽|руб|%|комплекс", sentence, flags=re.IGNORECASE):
            return sentence[:320]
    return sentences[0][:320] if sentences else None


def _campaign_copy(
    title: str, instruction: str | None, copy_hint: str | None = None
) -> tuple[str, bool]:
    """Extract factual copy, never the editor's imperative wording.

    The editor can write a normal phrase such as ``Написать: комплекс … —
    4 000 рублей``.  Only what follows that marker is campaign copy; wording
    like "сгенерируй картинку" is an instruction to the agent and must never
    be printed on the banner.
    """
    # The phrase may be written naturally, for example: "добавить золотую
    # надпись и подписи: Работа мастера Вероники, ваша студия Виолетта".  The
    # final marker is deliberately broad enough to recognise "подписи:", but
    # only text *after* a separator becomes banner copy.  Imperatives before
    # it never leak into the visual.
    marker = re.compile(
        r"(?:написать|напиши|текст(?:\s+на\s+(?:картинке|фото))?|"
        r"надпис(?:ь|и)|подпис(?:ь|и))\s*[:—–-]\s*(.+)",
        flags=re.IGNORECASE | re.DOTALL,
    )
    history = re.split(r"\n\s*Уточнение редактора:\s*", instruction or "", flags=re.IGNORECASE)

    def explicit_copy(value: str) -> str | None:
        found = marker.search(value)
        # Preserve punctuation and requested wording exactly. Only whitespace
        # is folded because the renderer cannot use a literal line break as a
        # separate label. The 520-character limit protects the image layout.
        return " ".join(found.group(1).split())[:520] if found else None

    copy = explicit_copy(history[0]) if history else None
    has_exact_copy = copy is not None
    for note in history[1:]:
        # A new explicit "Написать:" block is a conscious replacement for
        # banner wording. Other notes remain visual refinements only.
        replacement = explicit_copy(note)
        if replacement:
            copy = replacement
            has_exact_copy = True
            continue
        if copy:
            # Do not "tidy" explicit editor wording: that used to turn a
            # requested signature into a generic sentence. A later explicit
            # replacement remains possible through the branch above.
            if not has_exact_copy:
                copy = _normalize_campaign_text(copy)
            for old, new in re.findall(
                r"замени\s+[«\"]?(.+?)[»\"]?\s+на\s+[«\"]?(.+?)[»\"]?(?:[.!]|$)",
                note,
                flags=re.IGNORECASE,
            ):
                copy = re.sub(
                    re.escape(_normalize_campaign_text(old.strip())),
                    _normalize_campaign_text(new.strip()),
                    copy,
                    flags=re.IGNORECASE,
                )
    if copy:
        return copy, has_exact_copy

    # A prepared caption is written by the content model and is a valid
    # fallback only when it contains an actual offer.  A generic caption or a
    # raw editor command must never become a fake banner heading such as
    # «Рекламный баннер» or «Сгенерируй изображение».
    caption_copy = _caption_hint_copy(copy_hint)
    if caption_copy and re.search(r"акци|скидк|купон|подар|₽|руб|комплекс", caption_copy, flags=re.IGNORECASE):
        return _normalize_campaign_text(caption_copy), False

    found = explicit_copy(title)
    if found:
        return found, True
    title_copy = _display_title(title)
    if re.search(r"сген(?:е|и)р|созда|картин|изображен|баннер|реклам|пост", title_copy, flags=re.IGNORECASE):
        return "", False
    return _normalize_campaign_text(" ".join(title_copy.split())[:180]), False


def _split_offers(copy: str) -> list[tuple[str, str | None]]:
    """Separate up to two promotional offers, retaining every stated price."""
    price_pattern = re.compile(r"\d[\d\s]{1,10}\s*(?:₽|руб(?:\.|лей)?)", flags=re.IGNORECASE)
    offers: list[tuple[str, str | None]] = []
    prices = list(price_pattern.finditer(copy))
    if prices:
        start = 0
        for match in prices[:2]:
            details = copy[start:match.start()].strip(" .;—–-")
            offers.append((details or "Акция", match.group(0).replace("рублей", "₽").replace("руб.", "₽").strip()))
            start = match.end()
        tail = copy[start:].strip(" .;—–-")
        if tail and len(offers) < 2:
            offers.append((tail, None))
    elif copy.strip():
        offers.append((copy.strip(), None))
    return offers[:2] or [(copy, None)]


def _draw_centered_lines(
    draw: ImageDraw.ImageDraw,
    lines: list[str],
    y: int,
    font: ImageFont.FreeTypeFont,
    step: int,
    *,
    fill: tuple[int, int, int, int] = _GOLD_TEXT,
) -> int:
    for line in lines:
        _draw_firm_gold_text(draw, (540, y), line, font, anchor="ma", fill=fill)
        y += step
    return y


def _draw_firm_gold_text(
    draw: ImageDraw.ImageDraw,
    position: tuple[int, int],
    text: str,
    font: ImageFont.FreeTypeFont,
    *,
    anchor: str,
    fill: tuple[int, int, int, int] = _GOLD_TEXT,
) -> None:
    """Paint high-contrast champagne-gold type with a restrained dark shadow.

    Gold alone tends to disappear over a warm skin tone.  The shallow shadow
    and fine dark outline preserve the premium, metallic impression without a
    white fallback or a heavy, generic text box.
    """
    x, y = position
    draw.text(
        (x + 2, y + 3), text, font=font, fill=_GOLD_SHADOW, anchor=anchor,
        stroke_width=2, stroke_fill=_GOLD_SHADOW,
    )
    draw.text(
        position, text, font=font, fill=fill, anchor=anchor,
        stroke_width=1, stroke_fill=_GOLD_OUTLINE,
    )


def _draw_campaign_copy(
    draw: ImageDraw.ImageDraw,
    title: str,
    instruction: str | None,
    copy_hint: str | None = None,
) -> None:
    """Lay out a readable offer card locally, rather than trusting AI text."""
    copy, has_exact_editor_copy = _campaign_copy(title, instruction, copy_hint)
    if not copy:
        return
    offers = _split_offers(copy)
    has_promo = bool(re.search(r"акци|скидк|купон|подар|₽|руб", copy, flags=re.IGNORECASE))
    if not has_promo:
        caption = copy if has_exact_editor_copy else _capitalize_first_letter(copy)
        font, lines, size = _fit_wrapped_text(
            draw, caption, 870, preferred_size=54, minimum_size=30, max_lines=3, bold=True
        )
        line_step = round(size * 1.22)
        panel_height = 70 + len(lines) * line_step
        top = 1302 - panel_height
        draw.rounded_rectangle((48, top, 1032, 1302), radius=28, fill=(10, 8, 7, 194), outline=(222, 174, 88, 245), width=2)
        _draw_centered_lines(draw, lines, top + 34, font, line_step, fill=_GOLD_TEXT)
        return

    # Promotional text is deliberately composed as a card with a semantic
    # heading and one or two offer rows.  This means prices and conditions live
    # on the image itself, while the post caption remains a readable duplicate.
    # The offer needs to be immediately readable in a feed.  Use a large
    # title and one calm outer panel; a second rounded outline inside it made
    # the earlier banner look cramped and visually noisy.
    heading_font = _serif_font(68, bold=False)
    prepared_offers: list[
        tuple[
            list[str],
            ImageFont.FreeTypeFont,
            int,
            list[str],
            ImageFont.FreeTypeFont | None,
            int,
            int,
            str | None,
        ]
    ] = []
    for details, price in offers:
        has_price = bool(price)
        detail_font, detail_lines, detail_size = _fit_wrapped_text(
            draw,
            details if has_exact_editor_copy else _capitalize_first_letter(details),
            560 if has_price else 810,
            preferred_size=48 if has_price else 54,
            minimum_size=28,
            max_lines=3,
        )
        detail_step = round(detail_size * 1.2)
        price_font: ImageFont.FreeTypeFont | None = None
        price_lines: list[str] = []
        price_size = 0
        if price:
            price_font, price_lines, price_size = _fit_wrapped_text(
                draw, price, 240, preferred_size=68, minimum_size=40, max_lines=2, serif=True
            )
        text_height = max(len(detail_lines) * detail_step, len(price_lines) * round(price_size * 1.1))
        card_height = max(168, min(236, text_height + 48))
        prepared_offers.append((
            detail_lines, detail_font, detail_step, price_lines, price_font, price_size, card_height, price
        ))

    total_height = 112 + sum(offer[6] + 14 for offer in prepared_offers) + 30
    top = max(330, 1302 - total_height)
    draw.rounded_rectangle((48, top, 1032, 1302), radius=30, fill=(10, 8, 7, 210), outline=(222, 174, 88, 245), width=2)
    _draw_firm_gold_text(
        draw, (540, top + 42), "АКЦИЯ", heading_font, anchor="ma", fill=_GOLD_TEXT_BRIGHT
    )
    y = top + 112
    for detail_lines, detail_font, detail_step, price_lines, price_font, price_size, card_height, price in prepared_offers:
        if price:
            divider = 710
            draw.line((divider, y + 22, divider, y + card_height - 22), fill=(225, 185, 117, 205), width=2)
            detail_center = 392
        else:
            detail_center = 540
        first_y = y + max(28, (card_height - len(detail_lines) * detail_step) // 2)
        for line in detail_lines:
            _draw_firm_gold_text(
                draw, (detail_center, first_y), line, detail_font, anchor="ma", fill=_GOLD_TEXT
            )
            first_y += detail_step
        if price and price_font:
            price_step = round(price_size * 1.1)
            price_y = y + (card_height - len(price_lines) * price_step) // 2 + price_step // 2
            for line in price_lines:
                _draw_firm_gold_text(
                    draw, (858, price_y), line, price_font, anchor="mm", fill=_GOLD_TEXT_BRIGHT
                )
                price_y += price_step
        y += card_height + 14


def _draw_light_editorial_copy(
    draw: ImageDraw.ImageDraw,
    title: str,
    instruction: str | None,
    copy_hint: str | None = None,
) -> None:
    """Typeset a restrained light editorial block for the ivory brand family."""
    copy, exact = _campaign_copy(title, instruction, copy_hint)
    if not copy:
        return
    # The copy is intentionally laid out by the application: Russian remains
    # correct and editors get exactly the phrase they asked for, not AI text.
    display = copy if exact else _capitalize_first_letter(copy)
    font, lines, size = _fit_wrapped_text(
        draw, display, 790, preferred_size=50, minimum_size=27, max_lines=5, serif=True
    )
    step = round(size * 1.23)
    height = max(150, 70 + len(lines) * step)
    # In the light collage the large hero photograph reaches about y=910.
    # Keeping the copy below it preserves the result image and makes the
    # editorial hierarchy match the approved references.
    top = max(940, 1278 - height)
    draw.rounded_rectangle(
        (132, top, 1028, 1288), radius=34,
        fill=(247, 241, 233, 238), outline=(183, 158, 137, 220), width=2,
    )
    y = top + 35
    for line in lines:
        draw.text((580, y), line, font=font, fill=_TAUPE, anchor="ma")
        y += step


def _overlay_brand_caption(
    image_bytes: bytes,
    title: str,
    instruction: str | None = None,
    copy_hint: str | None = None,
    requested_style: str | None = None,
) -> bytes:
    """Add reliable readable Russian branding after image generation.

    Image models are not relied on for tiny Russian lettering.  The model creates
    the artistic background; Pillow adds the concise, editable studio signature.
    """
    style = _visual_style(
        title, instruction, collage=_wants_collage(title, instruction), requested_style=requested_style
    )
    with Image.open(io.BytesIO(image_bytes)) as source:
        source_image = ImageOps.exif_transpose(source).convert("RGB")
    # The image model supplies the subject and atmosphere, but not the final
    # layout.  Building the canvas locally makes the selected family a hard
    # choice: a light request always has an ivory editorial canvas and a dark
    # request always has a deep black/gold canvas, even when a model returns a
    # background in the opposite colour family.
    image = _brand_visual_canvas(source_image, style)
    draw = ImageDraw.Draw(image, "RGBA")
    _draw_brand_lockup(draw, 52, 46, style=style)
    if style == "light":
        _draw_light_editorial_copy(draw, title, instruction, copy_hint)
    else:
        _draw_campaign_copy(draw, title, instruction, copy_hint)
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=93, optimize=True)
    return output.getvalue()


def _paste_rounded(
    canvas: Image.Image, image: Image.Image, box: tuple[int, int, int, int], radius: int
) -> None:
    """Paste an archival photograph into a soft editorial card without altering it."""
    x, y, width, height = box
    card = ImageOps.fit(image, (width, height), method=Image.Resampling.LANCZOS)
    mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, width, height), radius=radius, fill=255)
    canvas.paste(card, (x, y), mask)


def _brand_visual_canvas(source: Image.Image, style: str) -> Image.Image:
    """Put generated artwork inside a deterministic light or dark art direction.

    This is deliberately separate from the prompt.  A prompt can guide a model,
    whereas this composition guarantees that the editor's explicit light/dark
    selection remains visible in every final card.
    """
    if style == "light":
        canvas = Image.new("RGB", (1080, 1350), (246, 240, 232))
        _paste_rounded(canvas, source, (54, 172, 972, 716), 42)
        draw = ImageDraw.Draw(canvas, "RGBA")
        draw.rounded_rectangle(
            (52, 170, 1028, 892), radius=44, outline=(178, 151, 127, 210), width=2
        )
        draw.arc((18, 986, 1050, 1528), 188, 334, fill=(182, 155, 133, 125), width=4)
        draw.arc((-340, -254, 498, 374), 22, 160, fill=(196, 170, 146, 110), width=3)
        return canvas

    canvas = Image.new("RGB", (1080, 1350), (14, 11, 9))
    _paste_rounded(canvas, source, (54, 146, 972, 860), 34)
    draw = ImageDraw.Draw(canvas, "RGBA")
    draw.rounded_rectangle(
        (52, 144, 1028, 1010), radius=36, outline=(223, 179, 103, 205), width=2
    )
    draw.arc((-250, -190, 1210, 1320), 208, 48, fill=(224, 181, 106, 125), width=4)
    return canvas


def _before_after_collage(
    source_media: list[MediaFile], settings: Settings, title: str,
    instruction: str | None = None, copy_hint: str | None = None, requested_style: str | None = None,
) -> bytes:
    """Create a real-photo collage in the dark or light VIOLETTA design family.

    This uses the selected client photographs exactly as supplied.  The image
    model is not asked to redraw results, so the editor never gets a plausible
    but inaccurate clinical result photo.
    """
    style = _visual_style(title, instruction, collage=True, requested_style=requested_style)
    canvas = Image.new("RGB", (1080, 1350), (244, 238, 230) if style == "light" else (16, 13, 11))
    draw = ImageDraw.Draw(canvas, "RGBA")
    border = _TAUPE_SOFT if style == "light" else (233, 194, 120, 255)
    _draw_brand_lockup(draw, 50, 38, 0.82, style=style)
    sources: list[Image.Image] = []
    for entry in source_media[:4]:
        with Image.open(original_path(settings, entry.storage_key)) as image:
            sources.append(ImageOps.exif_transpose(image).convert("RGB"))

    if style == "light":
        # A magazine-style asymmetric grid: a hero result with supporting
        # close-ups.  It closely matches the approved light references while
        # remaining entirely deterministic and faithful to the source photos.
        placements_by_count = {
            2: [(58, 188, 420, 480), (514, 188, 508, 720)],
            3: [(58, 188, 408, 356), (58, 572, 408, 356), (500, 188, 522, 740)],
            4: [(58, 188, 398, 332), (58, 548, 398, 332), (58, 908, 398, 300), (492, 188, 530, 650)],
        }
        placements = placements_by_count.get(len(sources), placements_by_count[4])
        for index, image in enumerate(sources):
            x, y, width, height = placements[index]
            _paste_rounded(canvas, image, (x, y, width, height), 32)
            draw.rounded_rectangle((x - 2, y - 2, x + width + 2, y + height + 2), radius=34, outline=border, width=2)
        # Decorative line, kept behind text and away from result details.
        draw.arc((26, 1020, 1060, 1550), 188, 334, fill=(184, 160, 140, 105), width=4)
        _draw_light_editorial_copy(draw, title, instruction, copy_hint)
    else:
        if len(sources) == 2:
            placements = [(70, 154, 940, 500), (70, 706, 940, 500)]
            labels = ("ДО", "ПОСЛЕ")
        else:
            placements = [(56, 154, 464, 492), (560, 154, 464, 492), (56, 690, 464, 492), (560, 690, 464, 492)]
            labels = tuple("" for _ in range(len(sources)))
        for index, image in enumerate(sources):
            x, y, width, height = placements[index]
            _paste_rounded(canvas, image, (x, y, width, height), 14)
            draw.rounded_rectangle((x - 3, y - 3, x + width + 3, y + height + 3), radius=14, outline=border, width=3)
            if labels[index]:
                draw.rounded_rectangle((x + 18, y + 18, x + 150, y + 62), radius=16, fill=(11, 9, 7, 210))
                _draw_firm_gold_text(
                    draw, (x + 38, y + 27), labels[index], _font(22, bold=True), anchor="la", fill=_GOLD_TEXT_BRIGHT
                )
        _draw_campaign_copy(draw, title, instruction, copy_hint)
    output = io.BytesIO()
    canvas.save(output, format="JPEG", quality=94, optimize=True)
    return output.getvalue()


def _requires_true_photo_edit(instruction: str) -> bool:
    """Return true only for a real retouch/object-change request.

    Selecting several photos normally means “make a collage”.  It must not
    accidentally become an image-model redraw merely because an editor wrote
    a general phrase such as “add a post”.
    """
    return bool(re.search(
        r"ретуш|убер(?:и|ть)|удал(?:и|ить)|замен(?:и|ить)|"
        r"перчатк|маск[ауи]|добав(?:ь|ить).{0,45}(?:на фото|в кадр|в изображен)|"
        r"измен(?:и|ить).{0,45}(?:фото|изображен|лиц|кож)",
        instruction.casefold(),
    ))


def _save_generated_image(
    db: Session, settings: Settings, item: ContentItem, actor_id: str, instruction: str, image: bytes
) -> MediaFile:
    workspace = _generated_workspace(db, actor_id)
    asset_id = str(uuid.uuid4())
    storage_key = f"generated/creative/{item.id}-{asset_id}.jpg"
    path = original_path(settings, storage_key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(image)
    generated = MediaFile(
        owner_id=actor_id, uploaded_by_id=actor_id, workspace_id=workspace.id,
        storage_key=storage_key, original_name=f"generated-creative-{item.id}.jpg",
        media_type=MediaType.IMAGE, mime_type="image/jpeg", size_bytes=len(image),
        checksum_sha256=hashlib.sha256(image).hexdigest(), publication_allowed=True,
        comment=f"Сгенерированный контент: {instruction.strip()[:600]}", captured_at=datetime.now(UTC),
    )
    db.add(generated)
    db.flush()
    create_thumbnail(settings, generated.storage_key, generated.id)
    return generated


def generate_branded_visual(
    db: Session,
    settings: Settings,
    item: ContentItem,
    actor_id: str,
    instruction: str,
    source_media: list[MediaFile],
    *,
    copy_hint: str | None = None,
    force_edit: bool = False,
) -> MediaFile:
    """Generate or carefully edit one visual and save it in the shared output folder."""
    selected_style = getattr(item, "visual_style", "auto")
    image_sources = [entry for entry in source_media if entry.media_type == MediaType.IMAGE][:16]
    # The order selected in the archive is meaningful: for two photos it is
    # "before" then "after". Render this locally so the client result is never
    # invented or mixed by an image model.
    if len(image_sources) >= 2 and (not force_edit or not _requires_true_photo_edit(instruction)):
        return _save_generated_image(
            db, settings, item, actor_id, instruction,
            _before_after_collage(
                image_sources, settings, item.title, instruction, copy_hint, requested_style=selected_style,
            ),
        )
    api_key = read_openai_secret(settings)
    image_model = config_value(settings, "openai_image_model", settings.openai_image_model)
    # The short topic is passed alongside an optional editor note, so image
    # generation cannot accidentally illustrate a different treatment.
    collage_requested = _wants_collage(item.title, instruction)
    # Several selected source photos are intentionally treated as a collage as
    # well: the content agent made that selection specifically for one merged
    # publication visual. A single selected photo remains a normal edit.
    prompt = _visual_prompt(
        item.title,
        instruction,
        bool(image_sources),
        collage=collage_requested or len(image_sources) >= 2,
        requested_style=selected_style,
    )
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        with openai_ipv4_client(settings.openai_http_timeout_seconds) as client:
            if image_sources:
                files: list[tuple[str, tuple[str, bytes, str]]] = []
                for entry in image_sources:
                    path = original_path(settings, entry.storage_key)
                    with Image.open(path) as source:
                        normalized = io.BytesIO()
                        ImageOps.exif_transpose(source).convert("RGB").save(normalized, format="JPEG", quality=94)
                    files.append(("image", (f"{entry.id}.jpg", normalized.getvalue(), "image/jpeg")))
                response = client.post(
                    "https://api.openai.com/v1/images/edits", headers=headers,
                    data={"model": image_model, "prompt": prompt, "size": "1024x1536", "quality": "high", "output_format": "jpeg", "background": "opaque"},
                    files=files,
                )
            else:
                response = client.post(
                    "https://api.openai.com/v1/images/generations", headers=headers,
                    json={"model": image_model, "prompt": prompt, "size": "1024x1536", "quality": "high", "output_format": "jpeg", "background": "opaque"},
                )
        ensure_openai_response(response).raise_for_status()
        encoded = response.json()["data"][0]["b64_json"]
        raw_image = base64.b64decode(encoded)
    except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError, OSError) as error:
        raise ContentAgentError("Не удалось сгенерировать изображение. Попробуйте уточнить запрос позже.") from error

    final_image = _overlay_brand_caption(
        raw_image, item.title, instruction, copy_hint, requested_style=selected_style,
    )
    return _save_generated_image(db, settings, item, actor_id, instruction, final_image)
