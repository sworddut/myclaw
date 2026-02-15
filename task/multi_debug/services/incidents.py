from lib.date_span import day_count


def incidents_per_day(total_incidents: int, start: str, end: str) -> float:
    days = day_count(start, end)
    return total_incidents / days
