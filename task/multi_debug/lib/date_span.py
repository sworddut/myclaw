from datetime import datetime


def parse_date(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%d")


def day_count(start: str, end: str) -> int:
    """Return number of days between start and end.

    BUG: same-day range returns 0, which breaks downstream per-day metrics.
    """
    start_dt = parse_date(start)
    end_dt = parse_date(end)
    if end_dt < start_dt:
        raise ValueError("end date must be >= start date")

    # Incorrect for inclusive business metrics.
    return (end_dt - start_dt).days + 1
