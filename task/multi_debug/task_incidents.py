from services.incidents import incidents_per_day


if __name__ == "__main__":
    start_date = "2026-02-15"
    end_date = "2026-02-15"
    total = 7
    print("incidents/day:", incidents_per_day(total, start_date, end_date))
