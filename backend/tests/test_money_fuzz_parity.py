"""Money parity, as a fuzz the frontend runs too (PR #198 review 4, L2).

contracts/fixtures/money/fuzz.json holds a few thousand amounts (log-uniform
from a millionth of a cent to ten million dollars, float denormals, and a
fine grid around every rounding edge: half a cent, a cent, a dime, $10) with
what services/money.py writes for each. This test checks Python against the
file; frontend/tests/pr198Fix4Money.test.ts checks pricing.ts against the
same file, so the two can't drift apart on any of them.

To rebuild the file after a deliberate change to the money rules:
``python -m tests.test_money_fuzz_parity`` from backend/.
"""
from __future__ import annotations

import json
import random
from pathlib import Path

from services import money

FIXTURE = Path(__file__).resolve().parents[2] / "contracts" / "fixtures" / "money" / "fuzz.json"


def amounts() -> list[float]:
    rng = random.Random(198)
    values = [10 ** rng.uniform(-8, 7) for _ in range(1200)]
    values += [10 ** rng.uniform(-330, -6) for _ in range(150)]
    values += [5e-324, 1e-300, 9.99999e-07, 1e-06, 1.0000001e-06, 9.9e-07, 1.23e-06]
    for edge in (0.00001, 0.0001, 0.001, 0.005, 0.01, 0.015, 0.0995, 0.1, 0.995, 1.005, 2.675, 9.995, 10, 99.5):
        values += [edge * (1 + step / 1000) for step in range(-12, 13)]
    values += [round(rng.uniform(0, 12), rng.choice([2, 3, 4, 5])) for _ in range(600)]
    values += [k / 10000 for k in range(0, 300)]
    return values


def rows() -> list[dict]:
    return [{"amount": value, "text": money.usd_amount(value), "spent": money.usd_spent(value)} for value in amounts()]


def test_python_writes_every_fuzz_amount_as_the_shared_file_says():
    table = json.loads(FIXTURE.read_text())
    assert table["rows"] == rows()


if __name__ == "__main__":
    FIXTURE.write_text(json.dumps({
        "about": "Money parity fuzz (PR #198 review 4, L2): `text` is services/money.usd_amount and lib/pricing "
                 "formatUsd, `spent` is usd_spent and formatSpentUsd. Both sides test against every row. "
                 "Rebuild with `python -m tests.test_money_fuzz_parity` from backend/.",
        "rows": rows(),
    }, indent=0) + "\n")
    print(len(rows()))
