class BaseService:
    def __init__(self, days=30):
        self.days = days

    def calculate_daily(self, total):
        return total / self.days
