import os

import requests


def fetch_orders() -> list[dict]:
    token = os.environ.get("ORDERS_API_TOKEN", "")
    resp = requests.get(
        "https://api.example.com/v1/orders",
        headers={"Authorization": f"Bearer {token}"},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()["orders"]


if __name__ == "__main__":
    print(len(fetch_orders()))
