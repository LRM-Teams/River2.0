from __future__ import annotations


def product_except_self(nums: list[int]) -> list[int]:
    result = [1] * len(nums)

    prefix = 1
    for index, value in enumerate(nums):
        result[index] = prefix
        prefix *= value

    suffix = 1
    for index in range(len(nums) - 1, -1, -1):
        result[index] *= suffix
        suffix *= nums[index]

    return result


if __name__ == "__main__":
    sample_nums = [1, 2, 3, 4]
    print(product_except_self(sample_nums))
