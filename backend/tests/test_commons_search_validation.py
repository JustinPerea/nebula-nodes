"""Malformed filters fail before executing search; store activation is separate."""
from __future__ import annotations

import re
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from commons import search
from commons.actors import Actor
from routes.commons import actor_dep, router, store_dep


INVALID_FILTERS = [
    pytest.param({"axes": []}, "axes must be an object", id="empty-axis-list"),
    pytest.param({"axes": [1]}, "axes must be an object", id="axis-list"),
    pytest.param({"axes": "quiet_loud"}, "axes must be an object", id="axis-string"),
    pytest.param({"axes": {"quiet_loud": []}}, "two-number range", id="empty-bounds"),
    pytest.param({"axes": {"quiet_loud": [0]}}, "two-number range", id="short-bounds"),
    pytest.param({"axes": {"quiet_loud": [-1, 0, 1]}}, "two-number range", id="long-bounds"),
    pytest.param({"axes": {"quiet_loud": "01"}}, "two-number range", id="string-bounds"),
    pytest.param({"axes": {"quiet_loud": {"0": 0, "1": 1}}}, "two-number range", id="object-bounds"),
    pytest.param({"axes": {"quiet_loud": [False, 1]}}, "finite number", id="boolean-bound"),
    pytest.param({"axes": {"quiet_loud": [None, 1]}}, "finite number", id="null-bound"),
    pytest.param({"axes": {"quiet_loud": [{}, 1]}}, "finite number", id="object-bound"),
    pytest.param({"axes": {"quiet_loud": ["NaN", 1]}}, "finite number", id="nan-bound"),
    pytest.param({"axes": {"quiet_loud": [0, "Infinity"]}}, "finite number", id="infinite-bound"),
    pytest.param({"axes": {"quiet_loud": [0.5, -0.5]}}, "within -1..1", id="reversed-bounds"),
    pytest.param({"palette_near": []}, "palette_near must be an object", id="empty-palette-list"),
    pytest.param({"palette_near": [1]}, "palette_near must be an object", id="palette-list"),
    pytest.param({"palette_near": "#123456"}, "palette_near must be an object", id="palette-string"),
    pytest.param({"palette_near": {}}, "palette_near.hex", id="missing-color"),
    pytest.param({"palette_near": {"hex": None}}, "palette_near.hex", id="null-color"),
    pytest.param({"palette_near": {"hex": 123456}}, "palette_near.hex", id="numeric-color"),
    pytest.param({"palette_near": {"hex": "#zzzzzz"}}, "palette_near.hex", id="invalid-color"),
    pytest.param({"palette_near": {"hex": "#123456", "max_delta_e": []}}, "finite number", id="list-distance"),
    pytest.param({"palette_near": {"hex": "#123456", "max_delta_e": True}}, "finite number", id="boolean-distance"),
    pytest.param({"palette_near": {"hex": "#123456", "max_delta_e": "Infinity"}}, "finite number", id="infinite-distance"),
    pytest.param({"palette_near": {"hex": "#123456", "max_delta_e": 0}}, "in (0, 10]", id="zero-distance"),
    pytest.param({"keywords": "minimal"}, "keywords must be a list of strings", id="keyword-string"),
    pytest.param({"keywords": {"minimal": True}}, "keywords must be a list of strings", id="keyword-map"),
    pytest.param({"keywords": [{}]}, "keywords must be a list of strings", id="keyword-object"),
    pytest.param({"keywords": [None]}, "keywords must be a list of strings", id="keyword-null"),
    pytest.param({"keywords": [1]}, "keywords must be a list of strings", id="keyword-number"),
    pytest.param({"collection": []}, "collection must be a string", id="collection-list"),
    pytest.param({"media": {}}, "media must be a string", id="media-object"),
    pytest.param({"made_by": []}, "made_by must be a string", id="maker-list"),
    pytest.param({"role": []}, "role must be a string", id="role-list"),
    pytest.param({"role": {}}, "role must be a string", id="role-object"),
]


@pytest.mark.parametrize("filters,message", INVALID_FILTERS)
def test_malformed_nested_filters_raise_value_error(filters, message):
    with pytest.raises(ValueError, match=re.escape(message)):
        search.Filters.from_dict(filters)


@pytest.fixture
def search_api(monkeypatch):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[actor_dep] = lambda: Actor("agent:cli", "agent")
    # FastAPI resolves the store dependency before parsing filters. Override it
    # with a sentinel to test query rejection independently of the activation gate.
    app.dependency_overrides[store_dep] = lambda: object()
    execute_search = Mock(return_value=[])
    monkeypatch.setattr(search, "search", execute_search)
    yield TestClient(app, raise_server_exceptions=False), execute_search


@pytest.mark.parametrize("filters,message", INVALID_FILTERS)
def test_search_api_rejects_invalid_filters_before_search(search_api, filters, message):
    client, execute_search = search_api
    response = client.post("/api/commons/search", json={"filters": filters})
    assert response.status_code == 422
    assert response.json()["detail"].startswith("bad filters: ")
    assert message in response.json()["detail"]
    execute_search.assert_not_called()


def test_valid_filters_keep_existing_normalization_and_defaults(search_api):
    client, execute_search = search_api
    response = client.post("/api/commons/search", json={"filters": {
        "axes": {"quiet_loud": ["-0.8", "0.2"]},
        "keywords": ["minimalist", "NOT_IN_VOCAB"],
        "palette_near": {"hex": "abcdef", "max_delta_e": "5"},
        "collection": "col-example", "media": "image", "made_by": "ai",
        "role": "attract", "corrected_only": True, "has_comments": True, "inbox": True,
    }})
    assert response.status_code == 200 and response.json() == {"results": []}
    filters = execute_search.call_args.kwargs["filters"]
    assert filters == search.Filters(
        axes={"quiet_loud": (-0.8, 0.2)}, keywords=["minimal", "not_in_vocab"],
        palette_near={"hex": "abcdef", "max_delta_e": 5.0},
        collection="col-example", media="image", made_by="ai", role="attract",
        corrected_only=True, has_comments=True, inbox=True,
    )
    assert search.Filters.from_dict({"axes": None, "keywords": None, "palette_near": None}) == search.Filters()
    assert search.Filters.from_dict(None) == search.Filters()
    assert search.Filters.from_dict({"palette_near": {"hex": "#123456"}}).palette_near == {
        "hex": "#123456", "max_delta_e": 10.0,
    }
    assert search.Filters.from_dict({"axes": {"warm_cold": (-1, 1)}}).axes == {"warm_cold": (-1.0, 1.0)}
    assert search.Filters.from_dict({"palette_near": {"hex": "123456"}}).palette_near["hex"] == "123456"


def test_oversized_numeric_bounds_fail_as_value_error():
    with pytest.raises(ValueError, match="finite number"):
        search.Filters.from_dict({"axes": {"quiet_loud": [0, 10**1000]}})


@pytest.mark.parametrize("filters", [[], "axes", 0, False])
def test_parser_rejects_nonobject_filters(filters):
    with pytest.raises(ValueError, match="filters must be an object"):
        search.Filters.from_dict(filters)
