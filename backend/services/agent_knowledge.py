"""Bounded, source-preserving provider knowledge for private Claude sessions."""
from __future__ import annotations

import os
import json
import stat
import subprocess
from pathlib import Path

KNOWLEDGE_PATHS = (
    ".agents/skills", "docs/model-providers", "docs/api-guides",
    "docs/MODEL_REFERENCE.md", "docs/fal-model-schemas.md", "docs/KREA-MCP.md",
)
MAX_KNOWLEDGE_FILES = 512
MAX_KNOWLEDGE_FILE_BYTES = 512 * 1024
MAX_KNOWLEDGE_BYTES = 8 * 1024 * 1024
TEXT_SUFFIXES = frozenset({".md", ".json", ".yaml", ".yml", ".txt"})


class KnowledgeSnapshotError(ValueError):
    pass


def _tracked_files(project_root: Path) -> list[str]:
    try:
        result = subprocess.run(
            ["git", "ls-files", "-z", "--", *KNOWLEDGE_PATHS], cwd=project_root,
            capture_output=True, timeout=5, check=True,
        )
    except (OSError, subprocess.SubprocessError):
        # GitHub source ZIPs have no .git directory. Use the tracked portable
        # inventory, never a recursive fallback that adopts user/untracked text.
        manifest = project_root / "backend/data/provider_knowledge_manifest.json"
        try:
            info = manifest.lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or manifest.resolve() != manifest or info.st_size > 128 * 1024):
                raise KnowledgeSnapshotError("Repo provider knowledge could not be indexed")
            data = json.loads(manifest.read_text(encoding="utf-8"))
            paths = data.get("paths") if isinstance(data, dict) else None
            if (not isinstance(data, dict) or type(data.get("version")) is not int
                    or data["version"] != 1 or not isinstance(paths, list)
                    or len(paths) > MAX_KNOWLEDGE_FILES
                    or any(not isinstance(path, str) or not _allowed_relative(Path(path)) for path in paths)):
                raise KnowledgeSnapshotError("Repo provider knowledge could not be indexed")
            return paths
        except (OSError, UnicodeError, ValueError) as exc:
            raise KnowledgeSnapshotError("Repo provider knowledge could not be indexed") from exc
    return result.stdout.decode("utf-8").split("\0")


def _allowed_relative(relative: Path) -> bool:
    if relative.is_absolute() or ".." in relative.parts or relative.suffix.lower() not in TEXT_SUFFIXES:
        return False
    return any(relative == Path(root) or relative.is_relative_to(Path(root)) for root in KNOWLEDGE_PATHS)


def _directory(path: Path) -> None:
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or path.is_symlink():
        raise KnowledgeSnapshotError("Provider knowledge destination contains an alias")


def snapshot_provider_knowledge(project_root: Path, workdir: Path) -> int:
    """Copy only tracked provider text, preserving an existing session snapshot.

    Every source and destination remains inside its respective declared root.
    No file is overwritten on resume, and aliases/multiple hard links are
    rejected. A path-only inventory never includes settings, outputs or user
    agent configuration.
    """
    project_root, workdir = project_root.resolve(), Path(workdir).absolute()
    if workdir.resolve() != workdir:
        raise KnowledgeSnapshotError("Provider knowledge workspace contains an alias")
    sources = []
    total = 0
    for entry in _tracked_files(project_root):
        if not entry:
            continue
        relative = Path(entry)
        if not _allowed_relative(relative):
            continue
        source = project_root / relative
        try:
            info = source.lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or source.resolve() != source):
                raise KnowledgeSnapshotError("Provider knowledge source contains an alias")
            if info.st_size > MAX_KNOWLEDGE_FILE_BYTES:
                raise KnowledgeSnapshotError("Provider knowledge file exceeds its size limit")
            if len(sources) >= MAX_KNOWLEDGE_FILES or total + info.st_size > MAX_KNOWLEDGE_BYTES:
                raise KnowledgeSnapshotError("Provider knowledge exceeds its snapshot limit")
            # O_NOFOLLOW rejects a last-component replacement after the check.
            descriptor = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(descriptor, "rb") as stream:
                opened = os.fstat(stream.fileno())
                if ((opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino)
                        or opened.st_nlink != 1):
                    raise KnowledgeSnapshotError("Provider knowledge source changed while opening")
                data = stream.read(MAX_KNOWLEDGE_FILE_BYTES + 1)
            if len(data) > MAX_KNOWLEDGE_FILE_BYTES:
                raise KnowledgeSnapshotError("Provider knowledge file exceeds its size limit")
            # A source may grow between lstat and open without changing inode.
            # Aggregate the actual bounded bytes, before retaining/writing them.
            total += len(data)
            if total > MAX_KNOWLEDGE_BYTES:
                raise KnowledgeSnapshotError("Provider knowledge exceeds its snapshot limit")
            data.decode("utf-8")
        except (OSError, UnicodeError) as exc:
            raise KnowledgeSnapshotError("Provider knowledge source is unavailable or invalid") from exc
        sources.append((relative, data))
    # The private directory is normally allocated by the backend. Creating its
    # last component supports standalone callers without adopting shared roots.
    _directory(workdir)
    for relative, data in sources:
        destination = workdir / relative
        current = workdir
        for component in relative.parts[:-1]:
            current = current / component
            _directory(current)
        try:
            descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                                 | getattr(os, "O_NOFOLLOW", 0), 0o600)
        except FileExistsError:
            info = destination.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise KnowledgeSnapshotError("Provider knowledge destination contains an alias")
            continue
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
    return len(sources)
