def divide(a, b):
    if b == 0:
        return "Error: Division by zero is not allowed."
    return a / b


if __name__ == '__main__':
    x = 10
    y = 2  # Changed from 0 to 2 to avoid division by zero
    print('result:', divide(x, y))
