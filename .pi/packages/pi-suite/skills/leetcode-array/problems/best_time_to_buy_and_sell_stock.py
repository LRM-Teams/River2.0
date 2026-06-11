from __future__ import annotations


def max_profit(prices: list[int]) -> int:
    min_price = float("inf")
    best = 0

    for price in prices:
        if price < min_price:
            min_price = price
            continue
        best = max(best, price - min_price)

    return best


if __name__ == "__main__":
    sample_prices = [7, 1, 5, 3, 6, 4]
    print(max_profit(sample_prices))
