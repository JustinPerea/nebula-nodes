"""iCloud 'Optimize Mac Storage' leaves files dataless (§5.2).

`st_flags & SF_DATALESS` marks them; stat.SF_DATALESS only exists from
Python 3.13 and Nebula runs 3.12, so the value is hard-coded. A dataless file
is never read inline: `brctl download` is requested and the flag is polled
until it clears (120 s timeout, at most 4 at once)."""
from __future__ import annotations

import asyncio
import os
import subprocess
import time
from pathlib import Path
from typing import Any, Callable

SF_DATALESS = 0x40000000


def is_dataless(st: Any) -> bool:
    return bool(getattr(st, "st_flags", 0) & SF_DATALESS)


class DatalessDownloader:
    def __init__(self, max_concurrent: int = 4, timeout: float = 120.0, poll: float = 2.0, *,
                 run: Callable = subprocess.run, stat: Callable = os.stat, sleep: Callable = asyncio.sleep,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._sem = asyncio.Semaphore(max_concurrent)
        self.timeout, self.poll = timeout, poll
        self._run, self._stat, self._sleep, self._clock = run, stat, sleep, clock

    async def download(self, path: Path) -> bool:
        async with self._sem:
            try:
                await asyncio.to_thread(self._run, ["brctl", "download", str(path)],
                                        capture_output=True, timeout=30)
            except (OSError, subprocess.SubprocessError):
                pass  # the poll below decides
            deadline = self._clock() + self.timeout
            while self._clock() < deadline:
                try:
                    st = self._stat(path)
                except FileNotFoundError:
                    return False
                if not is_dataless(st):
                    return True
                await self._sleep(self.poll)
            return False
