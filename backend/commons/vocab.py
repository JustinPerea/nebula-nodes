"""The keyword vocabulary (§6.3): canonical terms plus search synonyms."""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import yaml

VOCAB_PATH = Path(__file__).with_name("vocabulary.yaml")


def _norm(word: str) -> str:
    return word.strip().lower().replace("-", "_").replace(" ", "_")


@dataclass(frozen=True)
class Vocabulary:
    version: str
    terms: tuple[str, ...]
    synonyms: dict[str, str]

    def canonical(self, word: str) -> str | None:
        key = _norm(word)
        if key in self.terms:
            return key
        return self.synonyms.get(key)

    def expand(self, word: str) -> list[str]:
        term = self.canonical(word)
        if term is None:
            return [word.lower()]
        forms = [term] + sorted(s for s, t in self.synonyms.items() if t == term)
        return [f.replace("_", " ") for f in forms]


@lru_cache(maxsize=4)
def load_vocabulary(path: Path | None = None) -> Vocabulary:
    data = yaml.safe_load((path or VOCAB_PATH).read_text(encoding="utf-8"))
    terms: list[str] = []
    synonyms: dict[str, str] = {}
    for term, syns in (data.get("terms") or {}).items():
        canon = _norm(str(term))
        if canon in terms:
            raise ValueError(f"duplicate vocabulary term {canon}")
        terms.append(canon)
        for syn in syns or []:
            key = _norm(str(syn))
            if key in synonyms or key in terms:
                raise ValueError(f"synonym {key} is listed twice")
            synonyms[key] = canon
    overlap = set(terms) & set(synonyms)
    if overlap:
        raise ValueError(f"terms also listed as synonyms: {sorted(overlap)}")
    return Vocabulary(str(data.get("version", "1")), tuple(terms), synonyms)
