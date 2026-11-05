from vita29.content.agent import _topic_categories


def test_topic_category_gate_recognizes_core_studio_procedures() -> None:
    assert _topic_categories("Перманентный макияж губ") == {"lips"}
    assert _topic_categories("Брови: натуральный эффект") == {"brows"}
    assert _topic_categories("Стрелки и межресничка") == {"eyeliner"}
    assert _topic_categories("Пирсинг уха") == {"piercing"}
    assert _topic_categories("Ламинирование ресниц") == {"lashes"}


def test_topic_category_gate_keeps_multi_procedure_brief_explicit() -> None:
    assert _topic_categories("Губы и брови: сезонное предложение") == {"lips", "brows"}
