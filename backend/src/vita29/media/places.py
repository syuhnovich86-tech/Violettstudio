import math
from collections import defaultdict
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


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
        with dataset_path.open("r", encoding="utf-8", errors="replace") as source:
            for line in source:
                columns = line.rstrip("\n").split("\t")
                if len(columns) < 9:
                    continue
                try:
                    place = Place(
                        country_code=columns[8].upper(),
                        city=columns[1].strip(),
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
        if distance > 150:
            coordinate = f"{latitude:.3f}, {longitude:.3f}"
            result = (nearest.country_code, None, f"{nearest.country_code} · {coordinate}")
        else:
            result = (
                nearest.country_code,
                nearest.city,
                f"{nearest.country_code} · {nearest.city}",
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
