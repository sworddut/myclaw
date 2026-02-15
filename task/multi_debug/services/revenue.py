from lib.date_span import day_count


def revenue_per_day(total_revenue: float, start: str, end: str) -> float:
    days = day_count(start, end)
    return total_revenue / days
