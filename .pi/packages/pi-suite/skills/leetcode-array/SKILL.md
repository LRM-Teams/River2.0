---
name: leetcode-array
description: Common LeetCode array problems with Python reference solutions. Use when the user wants array practice, standard solution patterns, or quick runnable examples.
metadata:
  clawdbot:
    emoji: "🧮"
    requires:
      files: ["problems/*.py"]
---

# LeetCode Array

Use this skill when the user wants representative LeetCode array exercises with runnable Python solutions.

## Included problems

- `problems/two_sum.py` - hash map lookup for complement matching
- `problems/best_time_to_buy_and_sell_stock.py` - one-pass minimum tracking
- `problems/product_of_array_except_self.py` - prefix and suffix products

## How to use

Read the matching problem file first, then explain:
- the core pattern
- time and space complexity
- one common mistake

Run examples locally if needed:

```bash
python3 problems/two_sum.py
python3 problems/best_time_to_buy_and_sell_stock.py
python3 problems/product_of_array_except_self.py
```

## Answering style

- Start with the pattern before the code
- Prefer the runnable Python examples in `problems/`
- If the user asks for another language, translate from the Python reference solution
