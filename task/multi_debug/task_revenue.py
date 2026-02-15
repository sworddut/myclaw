from services.revenue import revenue_per_day


if __name__ == "__main__":
    start_date = "2026-02-15"
    end_date = "2026-02-15"
    total = 1200.0
    print("revenue/day:", revenue_per_day(total, start_date, end_date))
