"""Path policy for secondary textures/materials requested by mesh loaders."""
from pathlib import Path

from trimesh.resolvers import FilePathResolver

from services.file_access import require_allowed_path


class ProtectedFileResolver(FilePathResolver):
    def __init__(self, source):
        super().__init__(str(require_allowed_path(source)))

    def get(self, name):
        candidate = require_allowed_path(Path(self.parent) / name.strip())
        if not candidate.exists():
            candidate = require_allowed_path(Path(self.parent) / Path(name).name)
        return candidate.read_bytes()

    def namespaced(self, namespace):
        return ProtectedFileResolver(require_allowed_path(Path(self.parent) / namespace))

    def write(self, name, data):
        raise ValueError("Mesh input resources are read-only")

    def keys(self):
        # Loaders may ask whether a named resource is present; avoid recursively
        # listing a directory that could contain protected storage.
        return ()

    def __contains__(self, name):
        return require_allowed_path(Path(self.parent) / name.strip()).is_file()
