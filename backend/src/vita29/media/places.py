import math
import re
from collections import defaultdict
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


COUNTRY_NAMES_RU = {
    "AM": "Армения", "AZ": "Азербайджан", "BY": "Беларусь", "CY": "Кипр",
    "CZ": "Чехия", "DE": "Германия", "EG": "Египет", "ES": "Испания",
    "FR": "Франция", "GE": "Грузия", "GR": "Греция", "IT": "Италия",
    "KZ": "Казахстан", "MV": "Мальдивы", "RU": "Россия", "TH": "Таиланд",
    "TR": "Турция", "UA": "Украина", "AE": "ОАЭ",
}
CYRILLIC_NAME = re.compile(r"[А-Яа-яЁё]")
KNOWN_RUSSIAN_NAMES = {
    "Admiralteisky": "Адмиралтейский", "Akhali Atoni": "Новый Афон",
    "Alakhadzi": "Алахадзы", "Aleksandrovskaya": "Александровская",
    "Astrashytski Haradok": "Острошицкий Городок", "Avtovo": "Автово",
    "Berëza": "Берёза", "Bobr": "Бобр", "Bol’shoye Stiklevo": "Большое Стиклево",
    "Boztepe": "Бозтепе", "Bronnitsy": "Бронницы", "Bykovo": "Быково",
    "Centralniy": "Центральный", "Dagomys": "Дагомыс", "Dzyarzhynsk": "Дзержинск",
    "Elmalı": "Элмалы", "Esenyurt": "Эсеньюрт", "Fruktove": "Фруктовое",
    "Güzelbağ": "Гюзельбаг", "Igumnovo": "Игумново",
    "Il’inskiy": "Ильинский", "Im. Telmana Posyolok": "Посёлок имени Тельмана",
    "Karaçallı": "Караджаллы", "Kargalık": "Каргалык", "Kerva": "Керва",
    "Khimki": "Химки", "Khoroshëvo-Mnevniki": "Хорошёво-Мнёвники",
    "Khryashchevka": "Хрящёвка", "Kolomna": "Коломна", "Koptëvo": "Коптево",
    "Kozhukhovo": "Кожухово", "Kraskovo": "Красково", "Kratovo": "Кратово",
    "Krechevitsy": "Кречевицы", "Krestovskiy ostrov": "Крестовский остров",
    "Kronstadt": "Кронштадт", "Kuznetsovo": "Кузнецово", "Lefortovo": "Лефортово",
    "Luzhniki": "Лужники", "Malen’koye": "Маленькое", "Malyshevo": "Малышево",
    "Meshcherino": "Мещерино", "Minsk": "Минск", "Molokovo": "Молоково",
    "Moscow": "Москва", "Nizhniy Novgorod": "Нижний Новгород",
    "Novokuybyshevsk": "Новокуйбышевск", "Novopodrezkovo": "Новоподрезково",
    "Novosemeykino": "Новосемейкино", "Novosel’ye": "Новоселье",
    "Novoye Selo": "Новое Село", "Ozerki": "Озерки", "P’rimorsk’oe": "Приморское",
    "Peresvet": "Пересвет", "Povedniki": "Поведники", "Pozharskoye": "Пожарское",
    "Presnenskiy": "Пресненский", "Pribrezhnyy": "Прибрежный", "Pushkin": "Пушкин",
    "Raduzhnyy": "Радужный", "Ramenskoye": "Раменское", "Rodnikovo": "Родниково",
    "Rozhdestveno": "Рождествено", "Ruza": "Руза", "Samara": "Самара",
    "Selyatino": "Селятино", "Sheremet’yevskiy": "Шереметьевский",
    "Shishkin Les": "Шишкин Лес", "Sochi": "Сочи", "Sokol": "Сокол",
    "Sokhumi": "Сухум", "Stepanshchino": "Степанщино", "Strogino": "Строгино",
    "Syenitsa": "Сеница", "Taganskiy": "Таганский", "Tarasovo": "Тарасово",
    "Tolyatti": "Тольятти", "Troitskoye": "Троицкое", "Ulucak": "Улуджак",
    "Ukromnoye": "Укромное", "Untolovo": "Унтолово", "Vagonoremont": "Вагоноремонт",
    "Valer’yanovo": "Валерьяново", "Vasyl'evsky Ostrov": "Васильевский остров",
    "Vyaz’ma": "Вязьма", "Vydropuzhsk": "Выдропужск", "Yağca": "Ягджа",
    "Yakovlevskoye": "Яковлевское", "Zaraysk": "Зарайск", "Zhukovsky": "Жуковский",
    "Zhulebino": "Жулебино",
}


def _russian_name(default_name: str, alternate_names: str) -> str:
    known_name = KNOWN_RUSSIAN_NAMES.get(default_name)
    if known_name is not None:
        return known_name
    for name in alternate_names.split(","):
        candidate = name.strip()
        if candidate and CYRILLIC_NAME.search(candidate) and not re.search(
            r"[ІіЇїЄєҐґЎўЈјӘәӨөҮүҖҗҢңҺһÆæ]", candidate
        ):
            return candidate
    return default_name


@dataclass(frozen=True)
class Place:
    country_code: str
    city: str
    latitude: float
    longitude: float


def _distance_km(latitude: float, longitude: float, place: Place) -> float:
    radius = 6371.0
    first_latitude = math.radians(latitude)
    second_latitude = math.radians(place.latitude)
    latitude_delta = second_latitude - first_latitude
    longitude_delta = math.radians(place.longitude - longitude)
    haversine = (
        math.sin(latitude_delta / 2) ** 2
        + math.cos(first_latitude)
        * math.cos(second_latitude)
        * math.sin(longitude_delta / 2) ** 2
    )
    return radius * 2 * math.asin(math.sqrt(haversine))


class OfflinePlaceResolver:
    """Resolve GPS coordinates locally using the GeoNames cities500 dataset."""

    def __init__(self, dataset_path: Path):
        self._grid: dict[tuple[int, int], list[Place]] = defaultdict(list)
        self._cache: dict[tuple[float, float], tuple[str | None, str | None, str]] = {}
        if not dataset_path.is_file():
            return
        russian_names_path = dataset_path.with_name("ru_names.tsv")
        russian_names: dict[str, str] = {}
        if russian_names_path.is_file():
            with russian_names_path.open("r", encoding="utf-8", errors="replace") as source:
                for line in source:
                    geoname_id, separator, name = line.rstrip("\n").partition("\t")
                    if separator and geoname_id and name:
                        russian_names[geoname_id] = name
        with dataset_path.open("r", encoding="utf-8", errors="replace") as source:
            for line in source:
                columns = line.rstrip("\n").split("\t")
                if len(columns) < 9:
                    continue
                try:
                    place = Place(
                        country_code=columns[8].upper(),
                        city=russian_names.get(columns[0])
                        or _russian_name(columns[1].strip(), columns[3]),
                        latitude=float(columns[4]),
                        longitude=float(columns[5]),
                    )
                except ValueError:
                    continue
                self._grid[(math.floor(place.latitude), math.floor(place.longitude))].append(place)

    def resolve_rounded(
        self, latitude: float, longitude: float
    ) -> tuple[str | None, str | None, str]:
        cache_key = (latitude, longitude)
        cached = self._cache.get(cache_key)
        if cached is not None:
            return cached
        if not self._grid:
            coordinate = f"{latitude:.3f}, {longitude:.3f}"
            return None, None, coordinate
        latitude_cell = math.floor(latitude)
        longitude_cell = math.floor(longitude)
        candidates: list[Place] = []
        for radius in range(1, 4):
            candidates.clear()
            for latitude_offset in range(-radius, radius + 1):
                for longitude_offset in range(-radius, radius + 1):
                    candidates.extend(
                        self._grid.get(
                            (latitude_cell + latitude_offset, longitude_cell + longitude_offset),
                            [],
                        )
                    )
            if candidates:
                break
        if not candidates:
            coordinate = f"{latitude:.3f}, {longitude:.3f}"
            result = (None, None, coordinate)
            self._cache[cache_key] = result
            return result
        nearest = min(candidates, key=lambda place: _distance_km(latitude, longitude, place))
        distance = _distance_km(latitude, longitude, nearest)
        country_name = COUNTRY_NAMES_RU.get(nearest.country_code, nearest.country_code)
        if distance > 150:
            coordinate = f"{latitude:.3f}, {longitude:.3f}"
            result = (country_name, None, f"{country_name} · {coordinate}")
        else:
            result = (
                country_name,
                nearest.city,
                f"{country_name} · {nearest.city}",
            )
        if len(self._cache) < 100_000:
            self._cache[cache_key] = result
        return result

    def resolve(
        self, latitude: float | None, longitude: float | None
    ) -> tuple[str | None, str | None, str | None]:
        if latitude is None or longitude is None:
            return None, None, None
        return self.resolve_rounded(round(latitude, 3), round(longitude, 3))


@lru_cache(maxsize=4)
def get_place_resolver(dataset_path: str) -> OfflinePlaceResolver:
    return OfflinePlaceResolver(Path(dataset_path))
