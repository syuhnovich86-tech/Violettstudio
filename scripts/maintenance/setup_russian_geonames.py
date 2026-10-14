import shutil
import urllib.request
import zipfile
from pathlib import Path


root = Path("/srv/vita29/geonames")
archive_path = root / "alternateNamesV2.zip"
output_path = root / "ru_names.tsv"
download_url = "https://download.geonames.org/export/dump/alternateNamesV2.zip"

root.mkdir(parents=True, exist_ok=True)
if not archive_path.is_file():
    temporary = archive_path.with_suffix(".zip.part")
    with urllib.request.urlopen(download_url, timeout=120) as response, temporary.open("wb") as target:
        shutil.copyfileobj(response, target, length=1024 * 1024)
    temporary.replace(archive_path)

names: dict[str, tuple[str, bool]] = {}
with zipfile.ZipFile(archive_path) as archive:
    with archive.open("alternateNamesV2.txt") as source:
        for raw_line in source:
            columns = raw_line.decode("utf-8", errors="replace").rstrip("\n").split("\t")
            if len(columns) < 4 or columns[2] != "ru":
                continue
            geoname_id = columns[1]
            name = columns[3].strip()
            preferred = len(columns) > 4 and columns[4] == "1"
            if not geoname_id or not name:
                continue
            previous = names.get(geoname_id)
            if previous is None or (preferred and not previous[1]):
                names[geoname_id] = (name, preferred)

temporary_output = output_path.with_suffix(".tsv.part")
with temporary_output.open("w", encoding="utf-8", newline="\n") as target:
    for geoname_id, (name, _) in sorted(names.items(), key=lambda item: int(item[0])):
        target.write(f"{geoname_id}\t{name}\n")
temporary_output.replace(output_path)
print(f"russian_names={len(names)} path={output_path}")
