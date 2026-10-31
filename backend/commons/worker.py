"""The analysis worker (§6.1): in-process, started by Justin, metered.

Runs only while Nebula runs and only after Start (no daemon). One item at a
time. Pauses when the load average passes the threshold, stops spending
when the daily cap or the process call budget is reached.
"""
from __future__ import annotations

import asyncio
import os
from typing import Callable

from cinema.color import COMMONS_READER_SURFACE, composite_on
from commons import analysis_errors
from commons import media, records
from commons.db import now_iso
from commons.reader import MODEL_ID, PROMPT_VERSION, AnalysisInvalid, read_image, validate
from commons.vocab import load_vocabulary

_DELAYS = {"analyzed": 0.0, "failed": 1.0, "idle": 5.0, "paused_load": 30.0, "cap_reached": 60.0}


def default_load_threshold() -> float:
    return float(max(32, 4 * (os.cpu_count() or 8)))


def _env_budget() -> int | None:
    raw = os.environ.get("NEBULA_COMMONS_CALL_BUDGET", "").strip()
    return int(raw) if raw else None


# Why a fully transparent reference was never sent to the reader.
CLEAR_ERROR = "too transparent to add colors; not sent to the reader"

class AnalysisWorker:
    def __init__(self, store, *, reader=read_image, load_avg: Callable[[], float] | None = None,
                 sleep=asyncio.sleep, budget: int | None = None) -> None:
        self.store = store
        self._reader = reader
        self._load = load_avg or (lambda: os.getloadavg()[0])
        self._sleep = sleep
        self.budget = budget if budget is not None else _env_budget()
        self.budget_used = 0
        self.state = "stopped"
        self._task: asyncio.Task | None = None
        self._stopping = False

    def status(self) -> dict:
        running = self._task is not None and not self._task.done()
        return {"state": self.state if running or self.state == "budget_exhausted" else "stopped",
                "running": running, "budget_used": self.budget_used, "budget": self.budget,
                "model": MODEL_ID, "prompt_version": PROMPT_VERSION}

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        from commons import runtime

        self._stopping = False
        self.state = "running"
        self._task = runtime.spawn(self.run_forever())

    async def stop(self) -> None:
        self._stopping = True
        if self._task is not None:
            try:
                await asyncio.wait_for(asyncio.shield(self._task), timeout=5)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()
        self.state = "stopped"

    async def run_forever(self) -> None:
        await asyncio.to_thread(records.requeue_stale_analyzing, self.store)
        while not self._stopping:
            outcome = await self.run_once()
            if outcome == "budget_exhausted":
                return
            delay = _DELAYS.get(outcome, 5.0)
            waited = 0.0
            while waited < delay and not self._stopping:
                await self._sleep(min(1.0, delay - waited))
                waited += 1.0

    async def run_once(self) -> str:
        store = self.store
        threshold = float(store.get_setting("load_threshold", default_load_threshold()))
        if self._load() > threshold:
            self.state = "paused_load"
            return "paused_load"
        if records.meter_today(store)["remaining"] <= 0:
            self.state = "cap_reached"
            return "cap_reached"
        if self.budget is not None and self.budget_used >= self.budget:
            self.state = "budget_exhausted"
            return "budget_exhausted"
        asset = await asyncio.to_thread(records.claim_next, store, now_iso=now_iso())
        if asset is None:
            self.state = "idle"
            return "idle"
        self.state = "analyzing"
        vocab = load_vocabulary()
        # The measurement the reader is given is the asset's, so the analysis
        # records that version (measure-1 for an asset measured before alpha counted).
        common = dict(prompt_version=PROMPT_VERSION, model_id=MODEL_ID, vocab_version=vocab.version,
                      code_version=asset.get("code_version") or "measure-1")
        try:
            data = store.blob_path(asset["blob_key"]).read_bytes()
            # As the person sees it in Commons: a transparent reference over
            # the tile's surface, never over the colour hidden under its
            # alpha. An opaque one is sent exactly as before.
            seen = composite_on(media.load_image(data, asset["mime"], keep_alpha=True), COMMONS_READER_SURFACE)
            png = None if seen is None else media.encode_png(seen, max_edge=1568)
        except (media.MediaError, OSError) as exc:
            await asyncio.to_thread(records.write_analysis_failed, store, asset["id"], error=f"cannot load image: {exc}",
                                    raw_output=None, fewshot_ids=[], error_kind=analysis_errors.UNREADABLE, **common)
            self.state = "running"
            return "failed"
        if png is None:
            # Fully transparent: nothing to read, so it is never sent and no
            # call is counted. It fails for good (no retries: it won't change).
            await asyncio.to_thread(records.write_analysis_failed, store, asset["id"], error=CLEAR_ERROR,
                                    raw_output=None, fewshot_ids=[], error_kind=analysis_errors.UNREADABLE,
                                    max_attempts=0, **common)
            self.state = "running"
            return "failed"
        palette = (asset.get("measurements") or {}).get("palette") or []
        shots = await asyncio.to_thread(records.pick_fewshots, store)
        shot_ids = [s["id"] for s in shots]
        await asyncio.to_thread(records.meter_increment, store)
        self.budget_used += 1
        try:
            result = await self._reader(png, palette, shots, vocab=vocab)
        except Exception as exc:  # noqa: BLE001 - never leave the asset stuck in 'analyzing'
            await asyncio.to_thread(records.write_analysis_failed, store, asset["id"], error=f"reader crashed: {exc}",
                                    raw_output=None, fewshot_ids=shot_ids,
                                    error_kind=analysis_errors.classify_exception(exc), **common)
            self.state = "running"
            return "failed"
        if result.error or result.structured is None:
            await asyncio.to_thread(records.write_analysis_failed, store, asset["id"], error=result.error or "no output",
                                    raw_output=result.raw, fewshot_ids=shot_ids,
                                    error_kind=result.error_kind or analysis_errors.classify_text(result.error)
                                    or analysis_errors.OTHER, **common)
            self.state = "running"
            return "failed"
        try:
            fields, candidates, regions = validate(result.structured, palette_len=len(palette), vocab=vocab)
        except AnalysisInvalid as exc:
            await asyncio.to_thread(records.write_analysis_failed, store, asset["id"], error=str(exc),
                                    raw_output=result.raw, fewshot_ids=shot_ids,
                                    error_kind=analysis_errors.OTHER, **common)
            self.state = "running"
            return "failed"
        await asyncio.to_thread(
            records.write_analysis_ok, store, asset["id"], fields=fields, raw_output=result.raw or "",
            fewshot_ids=shot_ids, prompt_version=PROMPT_VERSION, model_id=result.model or MODEL_ID,
            vocab_version=vocab.version, candidates=candidates, proposed_regions=regions,
            duration_ms=result.duration_ms, code_version=common["code_version"])
        self.state = "running"
        return "analyzed"
