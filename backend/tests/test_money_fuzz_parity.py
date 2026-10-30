"""Money parity, as a fuzz the frontend runs too (PR #198 review 4, L2).

contracts/fixtures/money/fuzz.json holds a few thousand amounts (log-uniform
from a millionth of a cent to ten million dollars, float denormals, and a
fine grid around every rounding edge: half a cent, a cent, a dime, $10) with
what services/money.py writes for each. This test checks Python against the
file; frontend/tests/pr198Fix4Money.test.ts checks pricing.ts against the
same file, so the two can't drift apart on any of them.

The test reads each row's amount from the file and never regenerates it
(the generator's ``pow`` differs by platform; PR #198 review 5, M2). To
rebuild the file after a deliberate change to the money rules:
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
    """Reads each row's amount from the file, never regenerates it.

    ``amounts()`` draws its floats with ``10 ** rng.uniform(...)``, and
    ``pow`` differs in the last bit between libm versions (macOS and glibc:
    CI regenerated 7637674.5538175125 where the file has 7637674.553817513;
    PR #198 review 5, M2), so only the ``__main__`` rebuild uses it. What is
    compared is platform-independent:

    - the amounts: JSON floats round-trip exactly (CPython parses decimal
      text correctly rounded and writes the shortest repr that reads back
      the same float), so every platform reads the same doubles;
    - services/money.py: ``*``, ``+`` and ``/`` are IEEE-754 exact (correctly
      rounded), ``math.floor`` is exact, and f-string formatting and ``,``
      grouping are CPython's own (dtoa), not libm. Its one libm call is
      ``math.log10`` in ``_two_figures``; a last-ulp error there can only
      matter for a value within an ulp of a power of ten, where the exponent
      can come out one off, and that is self-correcting: next to a power of
      ten the rounded figure is exactly 10 or 100 (in units of the last
      place), and the ``n >= 100`` check turns both readings into the same
      text. test_pr198_fix5 shifts log10 by one ulp both ways over every
      row here and checks the text doesn't change. (The check used to be
      ``rounded >= 10 ** (exponent + 1)``, a libm ``pow`` for a negative
      exponent; it is integer arithmetic now.)
    """
    table = json.loads(FIXTURE.read_text())
    assert len(table["rows"]) > 2000
    diffs = [(row["amount"], row["text"], row["spent"], money.usd_amount(row["amount"]), money.usd_spent(row["amount"]))
             for row in table["rows"]
             if (money.usd_amount(row["amount"]), money.usd_spent(row["amount"])) != (row["text"], row["spent"])]
    assert diffs[:10] == []


if __name__ == "__main__":
    FIXTURE.write_text(json.dumps({
        "about": "Money parity fuzz (PR #198 review 4, L2): `text` is services/money.usd_amount and lib/pricing "
                 "formatUsd, `spent` is usd_spent and formatSpentUsd. Both sides test against every row. "
                 "Rebuild with `python -m tests.test_money_fuzz_parity` from backend/.",
        "rows": rows(),
    }, indent=0) + "\n")
    print(len(rows()))
