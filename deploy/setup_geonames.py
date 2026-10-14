from pathlib import Path
from urllib.request import urlopen
from zipfile import ZipFile


root = Path("/srv/vita29/geonames")
archive = root / "cities500.zip"
url = "https://download.geonames.org/export/dump/cities500.zip"

with urlopen(url, timeout=120) as response, archive.open("wb") as output:  # noqa: S310
    while chunk := response.read(1024 * 1024):
        output.write(chunk)

with ZipFile(archive) as source:
    member = source.getinfo("cities500.txt")
    if member.file_size < 1_000_000:
        raise RuntimeError("GeoNames archive is unexpectedly small")
    source.extract(member, root)

archive.unlink()
(root / "ATTRIBUTION.txt").write_text(
    "Place names supplied by GeoNames (https://www.geonames.org/), CC BY 4.0.\n",
    encoding="utf-8",
)
