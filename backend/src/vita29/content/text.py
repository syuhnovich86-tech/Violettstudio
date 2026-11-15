"""Shared typography rules for studio-generated content."""
import re


def normalize_pm(value: str) -> str:
    """Write the standalone Russian abbreviation for permanent makeup in capitals."""
    return re.sub(r'(?<![\w])пм(?![\w])', 'ПМ', value, flags=re.IGNORECASE)
