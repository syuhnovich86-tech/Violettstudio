import re

names = {
    "Moscow", "Ramenskoye", "Novokuybyshevsk", "Astrashytski Haradok",
    "Dzyarzhynsk", "Presnenskiy", "Nizhniy Novgorod", "Sokhumi",
}
cyrillic = re.compile(r"[А-Яа-яЁё]")
with open("/data/geonames/cities500.txt", encoding="utf-8", errors="replace") as source:
    for line in source:
        columns = line.rstrip("\n").split("\t")
        if len(columns) < 9 or columns[1] not in names:
            continue
        candidates = [item for item in columns[3].split(",") if cyrillic.search(item)]
        print(columns[1], columns[8], repr(candidates))
