"""What counts as a failed connection on an httpx request.

httpx reports a dropped connection as ``httpx.TransportError``, except for one
case: a TLS error in the middle of a response on an async client. anyio's
TLSStream re-raises any ``ssl.SSLError`` other than an unexpected EOF as is
(anyio/streams/tls.py, the ``except ssl.SSLError`` in
``_call_sslobject_method``), and httpcore's anyio backend maps ``ssl.SSLError``
only during the handshake (``start_tls``), not in ``read``/``write``. So a bad
record MAC or a decryption failure mid-response reaches the caller as a raw
``ssl.SSLError`` that ``except httpx.TransportError`` and ``except
httpx.HTTPError`` both miss. (The sync backend maps every OSError on a read,
SSLError included, to ReadError, so only async clients are affected.)

Catch these tuples instead of the bare httpx classes wherever a failed
connection should be retried or reported as a connection problem.
"""
from __future__ import annotations

import ssl

import httpx

# A failed connection: what ``except httpx.TransportError`` means to catch.
TRANSPORT_ERRORS: tuple[type[BaseException], ...] = (httpx.TransportError, ssl.SSLError)

# Any failed request: what ``except httpx.HTTPError`` means to catch.
HTTP_ERRORS: tuple[type[BaseException], ...] = (httpx.HTTPError, ssl.SSLError)


def is_transport_error(exc: BaseException) -> bool:
    """True for a failed connection, including a raw mid-response TLS error."""
    return isinstance(exc, TRANSPORT_ERRORS)


def describe(exc: BaseException) -> str:
    """Readable text for an HTTP error. A raw TLS error reads as a broken
    connection instead of OpenSSL's ``[SSL: ...] (_ssl.c:NNNN)`` text."""
    if isinstance(exc, ssl.SSLError):
        return "connection failed (the secure connection broke mid-response)"
    return str(exc)
