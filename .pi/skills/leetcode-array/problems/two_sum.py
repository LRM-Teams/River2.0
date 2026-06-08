from __future__ import annotations


def two_sum(nums: list[int], target: int) -> list[int]:
    seen: dict[int, int] = {}

    for index, value in enumerate(nums):
        complement = target - value
        if complement in seen:
            return [seen[complement], index]
        seen[value] = index

    return []


if __name__ == "__main__":
    sample_nums = [2, 7, 11, 15]
    sample_target = 9
    print(two_sum(sample_nums, sample_target))
