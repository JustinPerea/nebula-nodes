"""Rooted-membership fixtures for Paper's surviving deleted-node tombstones.

These test transport validation without editing Paper or invoking providers.
"""
from __future__ import annotations

import copy
import io
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from PIL import Image

from services.paper_transport import PaperCLI, PaperError


IDENTITY = {"fileId": "file-1", "pageId": "page-1", "objectId": "logo-1"}
SETTINGS = {"format": "png", "scale": "1x", "bounds": "object", "background": "artwork"}
ROOT = "root_node_page-1"


class MembershipTools:
    def __init__(self, export_path: Path):
        self.export_path = export_path
        self.info = {"file": {"id": "file-1", "name": "Editable fixture"}, "pageId": "page-1", "pageName": "Logos"}
        self.nodes = {
            "logo-1": {"id": "logo-1", "name": "Chosen logo", "parentId": "artboard-1", "childIds": [], "width": 12, "height": 8},
            "artboard-1": {"id": "artboard-1", "name": "Logo artboard", "parentId": ROOT, "childIds": ["logo-1"], "width": 120, "height": 80},
        }
        self.root_children = [{"id": "artboard-1", "name": "Logo artboard", "component": "Frame", "childCount": 1}]
        self.calls = []
        self.errors = {}
        self.on_export = None

    async def call(self, name, arguments):
        self.calls.append((name, copy.deepcopy(arguments)))
        if name in self.errors:
            raise self.errors[name]
        assert arguments.get("fileId") == "file-1"
        if name == "get_basic_info":
            assert arguments["pageId"] == "page-1"
            return copy.deepcopy(self.info)
        if name == "get_node_info":
            node = self.nodes.get(arguments["nodeId"])
            if node is None:
                raise PaperError("Linked Paper object is missing", "missing")
            return copy.deepcopy(node)
        if name == "get_children":
            assert arguments["nodeId"] == ROOT
            return {"children": copy.deepcopy(self.root_children), "count": len(self.root_children)}
        if name == "export":
            assert arguments["pageId"] == "page-1"
            if self.on_export:
                self.on_export()
            target = next(iter(arguments["nodes"]))
            return {"exports": [{"nodeId": target, "filePath": str(self.export_path)}]}
        raise AssertionError(f"Unexpected tool {name}")


class MembershipCLI(PaperCLI):
    def __init__(self, fixture):
        super().__init__()
        self.fixture = fixture

    @asynccontextmanager
    async def tools(self):
        yield self.fixture


@pytest.fixture
def tools(tmp_path, monkeypatch):
    out = io.BytesIO()
    Image.new("RGBA", (12, 8), (40, 100, 255, 180)).save(out, format="PNG")
    path = tmp_path / "export.png"
    path.write_bytes(out.getvalue())
    # These fixtures focus on membership, not the independently-tested path ACL.
    monkeypatch.setattr("services.paper_transport.require_allowed_path", Path)
    return MembershipTools(path)


@pytest.mark.asyncio
async def test_exact_live_logo_requires_reciprocal_ancestors_and_requested_page_root(tools):
    result = await MembershipCLI(tools).object_info(**{
        "file_id": "file-1", "page_id": "page-1", "object_id": "logo-1",
    })
    assert result["object"]["id"] == "logo-1"
    assert result["object"]["name"] == "Chosen logo"
    assert tools.calls == [
        ("get_basic_info", {"fileId": "file-1", "pageId": "page-1"}),
        ("get_node_info", {"fileId": "file-1", "nodeId": "logo-1"}),
        ("get_node_info", {"fileId": "file-1", "nodeId": "artboard-1"}),
        ("get_children", {"fileId": "file-1", "nodeId": ROOT}),
    ]


@pytest.mark.asyncio
async def test_capture_checks_membership_before_and_after_actual_export(tools):
    resolved, raw, bounds = await MembershipCLI(tools).capture(IDENTITY, SETTINGS)
    assert resolved["objectId"] == "logo-1"
    assert raw == tools.export_path.read_bytes()
    assert bounds == {"width": 12, "height": 8}
    assert [name for name, _ in tools.calls] == [
        "get_basic_info", "get_node_info", "get_node_info", "get_children", "export",
        "get_basic_info", "get_node_info", "get_node_info", "get_children",
    ]
    assert not any(name == "get_selection" for name, _ in tools.calls)


@pytest.mark.asyncio
async def test_top_level_artboard_is_valid_when_live_page_children_list_it(tools):
    identity = {**IDENTITY, "objectId": "artboard-1"}
    resolved, raw, bounds = await MembershipCLI(tools).capture(identity, SETTINGS)
    assert resolved["objectId"] == "artboard-1"
    assert raw == tools.export_path.read_bytes()
    assert bounds == {"width": 120, "height": 80}
    assert [name for name, _ in tools.calls].count("get_children") == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["inspect", "capture"])
async def test_same_id_name_size_tombstone_fails_before_blank_export(tools, operation):
    tools.nodes["logo-1"].update(parentId=None, childIds=[])
    tools.nodes["replacement"] = {**tools.nodes["logo-1"], "id": "replacement", "parentId": "artboard-1"}
    tools.nodes["artboard-1"]["childIds"] = ["replacement"]
    cli = MembershipCLI(tools)
    with pytest.raises(PaperError, match="missing or detached") as error:
        if operation == "inspect":
            await cli.object_info("file-1", "page-1", "logo-1")
        else:
            await cli.capture(IDENTITY, SETTINGS)
    assert error.value.state == "missing"
    assert not any(name == "export" for name, _ in tools.calls)
    assert not any(arguments.get("nodeId") == "replacement" for _, arguments in tools.calls)


@pytest.mark.asyncio
async def test_wrong_page_root_rejects_same_file_object(tools):
    tools.nodes["artboard-1"]["parentId"] = "root_node_page-2"
    with pytest.raises(PaperError, match="not on the linked page") as error:
        await MembershipCLI(tools).capture(IDENTITY, SETTINGS)
    assert error.value.state == "missing"
    assert not any(name == "export" for name, _ in tools.calls)


@pytest.mark.asyncio
async def test_parent_pointer_without_reciprocal_child_membership_is_missing(tools):
    tools.nodes["artboard-1"]["childIds"] = []
    with pytest.raises(PaperError, match="missing from its parent") as error:
        await MembershipCLI(tools).object_info("file-1", "page-1", "logo-1")
    assert error.value.state == "missing"


@pytest.mark.asyncio
async def test_detached_artboard_absent_from_root_children_is_missing(tools):
    tools.root_children = []
    with pytest.raises(PaperError, match="missing from its page") as error:
        await MembershipCLI(tools).capture(IDENTITY, SETTINGS)
    assert error.value.state == "missing"
    assert not any(name == "export" for name, _ in tools.calls)


@pytest.mark.asyncio
async def test_deletion_during_export_is_rejected_by_second_membership_check(tools):
    tools.on_export = lambda: tools.nodes["logo-1"].update(parentId=None, childIds=[])
    with pytest.raises(PaperError, match="missing or detached") as error:
        await MembershipCLI(tools).capture(IDENTITY, SETTINGS)
    assert error.value.state == "missing"
    assert [name for name, _ in tools.calls].count("export") == 1
    assert [name for name, _ in tools.calls].count("get_basic_info") == 2


@pytest.mark.asyncio
async def test_valid_parent_change_during_export_requires_retry(tools):
    def move():
        tools.nodes["logo-1"]["parentId"] = "artboard-2"
        tools.nodes["artboard-1"]["childIds"] = []
        tools.nodes["artboard-2"] = {**tools.nodes["artboard-1"], "id": "artboard-2", "childIds": ["logo-1"]}
        tools.root_children.append({"id": "artboard-2", "name": "Other artboard", "childCount": 1})
    tools.on_export = move
    with pytest.raises(PaperError, match="changed while exporting") as error:
        await MembershipCLI(tools).capture(IDENTITY, SETTINGS)
    assert error.value.state == "unavailable"
    assert [name for name, _ in tools.calls].count("get_children") == 2


@pytest.mark.asyncio
async def test_root_membership_removed_during_export_is_rejected(tools):
    tools.on_export = lambda: tools.root_children.clear()
    with pytest.raises(PaperError, match="missing from its page") as error:
        await MembershipCLI(tools).capture(IDENTITY, SETTINGS)
    assert error.value.state == "missing"


@pytest.mark.asyncio
@pytest.mark.parametrize("tool", ["get_basic_info", "get_node_info", "get_children", "export"])
async def test_inherited_tool_errors_preserve_state_and_message(tools, tool):
    original = PaperError("Paper disconnected fixture", "unavailable")
    tools.errors[tool] = original
    with pytest.raises(PaperError) as error:
        await MembershipCLI(tools).capture(IDENTITY, SETTINGS)
    assert error.value is original
    assert error.value.state == "unavailable"


@pytest.mark.asyncio
@pytest.mark.parametrize("scope", ["file", "page"])
async def test_basic_info_cannot_substitute_another_file_or_page(tools, scope):
    if scope == "file":
        tools.info["file"]["id"] = "another-file"
    else:
        tools.info["pageId"] = "another-page"
    with pytest.raises(PaperError):
        await MembershipCLI(tools).capture(IDENTITY, SETTINGS)
    assert tools.calls == [("get_basic_info", {"fileId": "file-1", "pageId": "page-1"})]


@pytest.mark.asyncio
async def test_supplied_node_scope_cannot_override_requested_identity(tools):
    tools.nodes["logo-1"]["fileId"] = "another-file"
    tools.nodes["logo-1"]["file"] = {"id": "file-1"}
    with pytest.raises(PaperError, match="did not resolve the linked file"):
        await MembershipCLI(tools).capture(IDENTITY, SETTINGS)
    assert not any(name == "export" for name, _ in tools.calls)


@pytest.mark.asyncio
async def test_ancestry_cycles_fail_closed(tools):
    tools.nodes["artboard-1"].update(parentId="logo-1", childIds=["logo-1"])
    tools.nodes["logo-1"]["childIds"] = ["artboard-1"]
    with pytest.raises(PaperError, match="ancestry could not be verified"):
        await MembershipCLI(tools).capture(IDENTITY, SETTINGS)
    assert not any(name == "export" for name, _ in tools.calls)


@pytest.mark.asyncio
async def test_ancestor_lookup_count_has_a_finite_limit(tools, monkeypatch):
    monkeypatch.setattr("services.paper_transport.MAX_OBJECT_ANCESTORS", 2)
    tools.nodes["artboard-1"]["parentId"] = "outer-frame"
    tools.nodes["outer-frame"] = {"id": "outer-frame", "name": "Outer", "parentId": ROOT, "childIds": ["artboard-1"]}
    tools.root_children = [{"id": "outer-frame"}]
    with pytest.raises(PaperError, match="exceeds the verification limit"):
        await MembershipCLI(tools).capture(IDENTITY, SETTINGS)
    assert len(tools.calls) == 4
    assert not any(name == "export" for name, _ in tools.calls)


@pytest.mark.asyncio
async def test_relative_export_path_is_rejected_before_path_canonicalization(tools, monkeypatch):
    monkeypatch.chdir(tools.export_path.parent)
    tools.export_path = Path("export.png")
    assert tools.export_path.is_file()
    with pytest.raises(PaperError, match="absolute local file path"):
        await MembershipCLI(tools).capture(IDENTITY, SETTINGS)


@pytest.fixture
def grouped_stdio_cli(tmp_path, monkeypatch):
    @asynccontextmanager
    async def stdio_fixture(*args, **kwargs):
        try:
            yield object(), object()
        except Exception as original:
            raise ExceptionGroup("stdio teardown", [ExceptionGroup("nested task group", [original])]) from original

    class SessionFixture:
        def __init__(self, *args):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def initialize(self):
            pass

        async def call_tool(self, *args):
            return None

    monkeypatch.setattr("services.paper_transport.stdio_client", stdio_fixture)
    monkeypatch.setattr("services.paper_transport.ClientSession", SessionFixture)
    cli = PaperCLI()
    executable = tmp_path / "paper-cli-fixture"
    executable.write_text("fixture; never executed")
    cli.command = str(executable)
    return cli


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["missing", "unavailable"])
async def test_nested_stdio_exception_groups_preserve_validated_paper_error(grouped_stdio_cli, state):
    original = PaperError("Linked Paper object is missing" if state == "missing" else "Paper tool failed", state)
    with pytest.raises(PaperError) as error:
        async with grouped_stdio_cli.tools():
            raise original
    assert error.value is original
    assert error.value.state == state
    assert isinstance(error.value.__cause__, ExceptionGroup)


@pytest.mark.asyncio
async def test_generic_stdio_exception_groups_stay_sanitized_unavailable(grouped_stdio_cli):
    with pytest.raises(PaperError) as error:
        async with grouped_stdio_cli.tools():
            raise ValueError("private fixture path and relay credentials")
    assert error.value.state == "unavailable"
    assert str(error.value) == "Paper is disconnected or its request timed out; last good snapshot retained"
    assert "private" not in str(error.value)
    assert "credentials" not in str(error.value)
