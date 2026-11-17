"""size_text: a size as a person line says it (frontend/src/lib/sizeText.ts is the same rule)."""
from __future__ import annotations

from execution.person_line import size_text
from services.typesafe_client import _images_over_line, _request_over_line

MB = 1024 * 1024


def test_size_text_drops_a_trailing_zero_and_writes_gb_from_1024_mb() -> None:
    assert size_text(528 * MB) == "528 MB"
    assert size_text(16.3 * MB) == "16.3 MB"
    assert size_text(3072 * MB) == "3 GB"
    assert size_text(1536 * MB) == "1.5 GB"
    assert size_text(1023.9 * MB) == "1023.9 MB"
    # The unit is chosen after rounding, and both sides round with integer arithmetic on the bytes.
    # 1,127,428,915 bytes is 1.0499999998 GB, which is 1 GB to one decimal; the old float nudge printed 1.1 GB.
    assert size_text(1_127_428_915) == "1 GB"
    # 1,073,741,823 bytes is 1023.999999 MB: it rounds to 1,024 MB, so it reads "1 GB", not "1024 MB".
    assert size_text(1_073_741_823) == "1 GB"
    assert size_text(1_073_689_396) == "1 GB"
    assert size_text(1_073_000_000) == "1023.3 MB"


def test_a_size_that_reads_as_its_limit_says_over_the_limit_alone() -> None:
    assert _request_over_line(33.4 * MB).startswith("The request is 33.4 MB, over TypeSafe’s 32 MB limit.")
    assert _request_over_line(32.02 * MB).startswith("The request is over TypeSafe’s 32 MB limit.")
    assert _images_over_line(4, 40 * MB).startswith("The 4 images come to 40 MB even as small JPEGs, over TypeSafe’s 32 MB request limit.")
    assert _images_over_line(4, 32.02 * MB).startswith("The 4 images are over TypeSafe’s 32 MB request limit even as small JPEGs.")
