from datetime import datetime


def parse_date(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%d")


def day_count(start: str, end: str) -> int:
    """Return number of days between start and end (inclusive)."""
    start_dt = parse_date(start)
    end_dt = parse_date(end)
    if end_dt < start_dt:
        raise ValueError("end date must be >= start date")

    return (end_dt - start_dt).days + 1
