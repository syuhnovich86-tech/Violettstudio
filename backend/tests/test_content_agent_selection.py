from types import SimpleNamespace

from vita29.content.agent import _marked_material_matches_topic


def marked_media(*, folder: str, comment: str = "", name: str = "source.jpg"):
    return SimpleNamespace(
        workspace=SimpleNamespace(display_name=folder),
        comment=comment,
        batch=None,
        original_name=name,
    )


def test_marked_material_needs_matching_procedure_evidence() -> None:
    assert _marked_material_matches_topic(
        marked_media(folder="Стрелки", comment="работа ведущего мастера"),
        "Видео о стрелках",
    )
    assert not _marked_material_matches_topic(
        marked_media(folder="Пирсинг", comment="ухо с украшением"),
        "Видео о стрелках",
    )


def test_marked_material_can_be_used_for_a_broad_topic() -> None:
    assert _marked_material_matches_topic(
        marked_media(folder="Виолетта ПМ"),
        "Красота в ноябре",
    )
