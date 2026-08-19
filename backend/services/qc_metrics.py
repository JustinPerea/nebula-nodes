"""Deterministic image/video metrics used by the local Video QC modes."""

from __future__ import annotations

import math
from typing import Any, Sequence

import numpy as np
from PIL import Image

try:  # OpenCV is required only for the explicit ``opencv`` analysis mode.
    import cv2
except ImportError:  # pragma: no cover - exercised through monkeypatched tests
    cv2 = None  # type: ignore[assignment]

try:
    from skimage.metrics import structural_similarity
except ImportError:  # pragma: no cover - exercised through monkeypatched tests
    structural_similarity = None  # type: ignore[assignment]

from services.qc_common import clamp_score, normalized_rgb


def _arrays(frames: Sequence[Image.Image]) -> list[np.ndarray]:
    return [normalized_rgb(frame) for frame in frames]


def _gray_u8(array: np.ndarray) -> np.ndarray:
    # Keep heuristic mode independent from OpenCV. The coefficients match the
    # standard Rec. 601 RGB-to-luma conversion closely enough for the coarse
    # local metrics below.
    rgb = (array * 255).astype(np.float32)
    gray = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    return np.clip(gray, 0, 255).astype(np.uint8)


def _require_opencv() -> Any:
    if cv2 is None:
        raise RuntimeError(
            "OpenCV analysis mode requires opencv-python-headless; "
            "install backend/requirements.txt in the backend environment"
        )
    return cv2


def _global_ssim(first: np.ndarray, second: np.ndarray) -> float:
    """Small dependency-free SSIM fallback for heuristic mode.

    scikit-image remains pinned for the production-quality windowed metric,
    but a missing optional local-analysis package must not make every heuristic
    QC node unimportable. This computes the standard global SSIM expression per
    channel and averages the result.
    """
    scores: list[float] = []
    c1 = 0.01**2
    c2 = 0.03**2
    for channel in range(first.shape[2]):
        x = first[..., channel].astype(np.float64)
        y = second[..., channel].astype(np.float64)
        mean_x = float(np.mean(x))
        mean_y = float(np.mean(y))
        var_x = float(np.var(x))
        var_y = float(np.var(y))
        covariance = float(np.mean((x - mean_x) * (y - mean_y)))
        numerator = (2 * mean_x * mean_y + c1) * (2 * covariance + c2)
        denominator = (mean_x**2 + mean_y**2 + c1) * (var_x + var_y + c2)
        scores.append(numerator / denominator if denominator else 1.0)
    return float(np.mean(scores))


def image_similarity(first: np.ndarray, second: np.ndarray) -> dict[str, float]:
    pixel_similarity = 1.0 - float(np.mean(np.abs(first - second)))
    hist_scores: list[float] = []
    for channel in range(3):
        hist_a, _ = np.histogram(first[..., channel], bins=32, range=(0, 1), density=True)
        hist_b, _ = np.histogram(second[..., channel], bins=32, range=(0, 1), density=True)
        if np.std(hist_a) == 0 or np.std(hist_b) == 0:
            hist_scores.append(1.0 if np.allclose(hist_a, hist_b) else 0.0)
        else:
            hist_scores.append((float(np.corrcoef(hist_a, hist_b)[0, 1]) + 1.0) / 2.0)
    ssim = (
        float(structural_similarity(first, second, channel_axis=2, data_range=1.0))
        if structural_similarity is not None
        else _global_ssim(first, second)
    )
    return {
        "pixel_similarity": clamp_score(pixel_similarity),
        "histogram_correlation": clamp_score(float(np.mean(hist_scores))),
        "ssim": clamp_score((ssim + 1.0) / 2.0),
    }


def loop_metrics(frames: Sequence[Image.Image], *, opencv: bool) -> dict[str, Any]:
    arrays = _arrays([frames[0], frames[-1]])
    similarity = image_similarity(arrays[0], arrays[1])
    seam = (
        0.45 * similarity["pixel_similarity"]
        + 0.25 * similarity["histogram_correlation"]
        + 0.30 * similarity["ssim"]
    )
    flow_magnitude: float | None = None
    if opencv:
        active_cv2 = _require_opencv()
        flow = active_cv2.calcOpticalFlowFarneback(
            _gray_u8(arrays[1]),
            _gray_u8(arrays[0]),
            None,
            0.5,
            3,
            15,
            3,
            5,
            1.2,
            0,
        )
        magnitude = active_cv2.magnitude(flow[..., 0], flow[..., 1])
        flow_magnitude = round(float(np.mean(magnitude)), 4)
        flow_score = math.exp(-flow_magnitude / 12.0)
        seam = 0.75 * seam + 0.25 * flow_score
    seam_score = clamp_score(seam)
    if seam_score >= 0.82:
        discontinuity = "none"
    elif similarity["histogram_correlation"] < 0.65:
        discontinuity = "color_or_lighting"
    elif similarity["pixel_similarity"] < 0.65:
        discontinuity = "position_or_content"
    else:
        discontinuity = "motion"
    return {
        "seam_score": seam_score,
        "loop_safe": seam_score >= 0.78,
        "discontinuity_type": discontinuity,
        "frame_analysis": {**similarity, "optical_flow_magnitude": flow_magnitude},
    }


def _color_histogram(array: np.ndarray) -> np.ndarray:
    parts = [np.histogram(array[..., c], bins=16, range=(0, 1))[0] for c in range(3)]
    hist = np.concatenate(parts).astype(np.float32)
    total = float(hist.sum())
    return hist / total if total else hist


def frame_stability_metrics(frames: Sequence[Image.Image]) -> dict[str, float]:
    arrays = _arrays(frames)
    histograms = [_color_histogram(array) for array in arrays]
    color_distances = [float(np.mean(np.abs(histograms[0] - hist))) for hist in histograms[1:]]
    similarities = [image_similarity(a, b)["ssim"] for a, b in zip(arrays, arrays[1:])]
    color_drift = clamp_score(float(np.mean(color_distances)) * 16.0 if color_distances else 0.0)
    return {
        "color_drift_score": color_drift,
        "background_stability_score": clamp_score(float(np.mean(similarities)) if similarities else 1.0),
    }


def detect_faces(frames: Sequence[Image.Image]) -> tuple[list[list[tuple[int, int, int, int]]], dict[str, float]]:
    active_cv2 = _require_opencv()
    cascade_path = active_cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    cascade = active_cv2.CascadeClassifier(cascade_path)
    detections: list[list[tuple[int, int, int, int]]] = []
    primary_geometry: list[tuple[float, float, float]] = []
    edge_density: list[float] = []
    for image in frames:
        rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
        gray = active_cv2.cvtColor(rgb, active_cv2.COLOR_RGB2GRAY)
        found = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(24, 24))
        boxes = [tuple(int(v) for v in box) for box in found]
        detections.append(boxes)
        if boxes:
            x, y, width, height = max(boxes, key=lambda box: box[2] * box[3])
            primary_geometry.append(
                ((x + width / 2) / image.width, (y + height / 2) / image.height, (width * height) / (image.width * image.height))
            )
            crop = gray[y : y + height, x : x + width]
            edge_density.append(float(np.mean(active_cv2.Canny(crop, 80, 160) > 0)))
    if len(primary_geometry) > 1:
        geom = np.asarray(primary_geometry, dtype=np.float32)
        identity_drift = clamp_score(float(np.mean(np.std(geom, axis=0))) * 6.0)
        expression_drift = clamp_score(float(np.std(edge_density)) * 5.0 if edge_density else 0.0)
    else:
        identity_drift = 0.0
        expression_drift = 0.0
    return detections, {
        "identity_drift_score": identity_drift,
        "expression_drift_score": expression_drift,
    }


def compositing_metrics(frames: Sequence[Image.Image], *, opencv: bool) -> dict[str, Any]:
    active_cv2 = _require_opencv() if opencv else None
    arrays = _arrays(frames)
    edge_densities: list[float] = []
    light_matches: list[float] = []
    temperature_matches: list[float] = []
    chroma_ratios: list[float] = []
    for array in arrays:
        gray = _gray_u8(array)
        if active_cv2 is not None:
            edges = active_cv2.Canny(gray, 80, 160)
            edge_densities.append(float(np.mean(edges > 0)))
        else:
            gray_f = gray.astype(np.float32)
            grad_x = np.abs(np.diff(gray_f, axis=1))
            grad_y = np.abs(np.diff(gray_f, axis=0))
            # A deliberately coarse local edge proxy: high-contrast changes
            # in either axis, normalized over the sampled frame.
            edge_pixels = int(np.count_nonzero(grad_x > 28.0)) + int(
                np.count_nonzero(grad_y > 28.0)
            )
            edge_densities.append(
                edge_pixels / max(1, grad_x.size + grad_y.size)
            )
        h, w = gray.shape
        center = array[h // 4 : 3 * h // 4, w // 4 : 3 * w // 4]
        border = np.concatenate(
            [array[: h // 6].reshape(-1, 3), array[-h // 6 :].reshape(-1, 3), array[:, : w // 6].reshape(-1, 3), array[:, -w // 6 :].reshape(-1, 3)]
        )
        center_luma = float(np.mean(center))
        border_luma = float(np.mean(border))
        light_matches.append(math.exp(-abs(center_luma - border_luma) * 4.0))
        center_temp = float(np.mean(center[..., 0] - center[..., 2]))
        border_temp = float(np.mean(border[:, 0] - border[:, 2]))
        temperature_matches.append(math.exp(-abs(center_temp - border_temp) * 5.0))
        if opencv:
            rgb = (array * 255).astype(np.uint8)
            green = rgb[..., 1].astype(np.int16)
            red = rgb[..., 0].astype(np.int16)
            blue = rgb[..., 2].astype(np.int16)
            chroma_ratios.append(float(np.mean((green > red + 35) & (green > blue + 35))))

    edge_variance = float(np.std(edge_densities))
    edge_spill = clamp_score(edge_variance * 8.0 + max(edge_densities, default=0.0) * 0.4)
    light_match = clamp_score(float(np.mean(light_matches)))
    depth_consistency = clamp_score(float(np.mean(temperature_matches)))
    chroma_ratio = float(np.mean(chroma_ratios)) if chroma_ratios else 0.0
    cutout = clamp_score(edge_spill * 0.65 + min(1.0, chroma_ratio * 8.0) * 0.35)
    overall = clamp_score((1.0 - edge_spill + light_match + depth_consistency + 1.0 - cutout) / 4.0)
    artifacts: list[str] = []
    if edge_spill > 0.55:
        artifacts.append("edge_spill")
    if light_match < 0.55:
        artifacts.append("light_mismatch")
    if depth_consistency < 0.55:
        artifacts.append("depth_inconsistency")
    if cutout > 0.55:
        artifacts.append("cutout_appearance")
    if chroma_ratio > 0.08:
        artifacts.append("chroma_key")
    return {
        "compositing_artifacts": artifacts,
        "edge_spill_score": edge_spill,
        "light_match_score": light_match,
        "depth_consistency_score": depth_consistency,
        "cutout_appearance_score": cutout,
        "overall_integration_score": overall,
        "chroma_key_detected": chroma_ratio > 0.08 if opencv else False,
        "background_consistency_score": depth_consistency,
    }


def _horizon(gray: np.ndarray) -> dict[str, float] | None:
    vertical = np.mean(np.abs(np.diff(gray.astype(np.float32), axis=0)), axis=1)
    if vertical.size == 0 or float(vertical.max()) < 1.0:
        return None
    y = int(np.argmax(vertical))
    confidence = clamp_score(float(vertical[y]) / 80.0)
    return {"y": round(y / max(1, gray.shape[0] - 1), 4), "confidence": confidence}


def _coarse_angle(horizon: dict[str, float] | None) -> str:
    if horizon is None:
        return "undetermined"
    y = horizon["y"]
    if y < 0.38:
        return "low-angle"
    if y > 0.68:
        return "high-angle"
    return "eye-level"


def camera_geometry_metrics(
    frames: Sequence[Image.Image],
    *,
    reference: Image.Image | None,
    opencv: bool,
) -> dict[str, Any]:
    active_cv2 = _require_opencv() if opencv else None
    arrays = _arrays(frames)
    grays = [_gray_u8(array) for array in arrays]
    horizons = [item for item in (_horizon(gray) for gray in grays) if item is not None]
    horizon = max(horizons, key=lambda item: item["confidence"]) if horizons else None
    shifts: list[tuple[float, float]] = []
    zooms: list[float] = []
    homographies: list[list[list[float]]] = []
    vanishing_points: list[dict[str, float]] = []
    distortion_samples: list[float] = []

    for first, second in zip(grays, grays[1:]):
        if active_cv2 is not None:
            (dx, dy), response = active_cv2.phaseCorrelate(
                first.astype(np.float32), second.astype(np.float32)
            )
            if response >= 0.01:
                shifts.append(
                    (dx / max(1, first.shape[1]), dy / max(1, first.shape[0]))
                )
        else:
            # Coarse heuristic motion: compare the luminance-weighted content
            # centroid. It cannot recover a homography, but it truthfully
            # captures broad pan/tilt without importing OpenCV.
            centroids: list[tuple[float, float]] = []
            for gray in (first, second):
                weights = np.abs(gray.astype(np.float32) - float(np.median(gray)))
                total = float(np.sum(weights))
                if total <= 1e-6:
                    centroids.append((0.5, 0.5))
                    continue
                ys, xs = np.indices(gray.shape, dtype=np.float32)
                centroids.append(
                    (
                        float(np.sum(xs * weights) / total) / max(1, gray.shape[1] - 1),
                        float(np.sum(ys * weights) / total) / max(1, gray.shape[0] - 1),
                    )
                )
            shifts.append(
                (
                    centroids[1][0] - centroids[0][0],
                    centroids[1][1] - centroids[0][1],
                )
            )
        if active_cv2 is not None:
            detector = active_cv2.ORB_create(nfeatures=500)
            key_a, desc_a = detector.detectAndCompute(first, None)
            key_b, desc_b = detector.detectAndCompute(second, None)
            if desc_a is not None and desc_b is not None and len(key_a) >= 4 and len(key_b) >= 4:
                matches = sorted(active_cv2.BFMatcher(active_cv2.NORM_HAMMING, crossCheck=True).match(desc_a, desc_b), key=lambda match: match.distance)[:80]
                if len(matches) >= 4:
                    pts_a = np.float32([key_a[m.queryIdx].pt for m in matches]).reshape(-1, 1, 2)
                    pts_b = np.float32([key_b[m.trainIdx].pt for m in matches]).reshape(-1, 1, 2)
                    matrix, _ = active_cv2.findHomography(pts_a, pts_b, active_cv2.RANSAC, 4.0)
                    if matrix is not None and abs(matrix[2, 2]) > 1e-8:
                        matrix = matrix / matrix[2, 2]
                        homographies.append(np.round(matrix, 5).tolist())
                        zooms.append(float(math.sqrt(abs(matrix[0, 0] * matrix[1, 1])) - 1.0))

    if active_cv2 is not None:
        edge_map = active_cv2.Canny(grays[len(grays) // 2], 60, 150)
        lines = active_cv2.HoughLinesP(edge_map, 1, np.pi / 180, threshold=60, minLineLength=45, maxLineGap=10)
        slopes: list[tuple[float, float]] = []
        if lines is not None:
            h, w = grays[0].shape
            edge_y, edge_x = np.nonzero(edge_map)
            for raw in lines[:80]:
                x1, y1, x2, y2 = [float(v) for v in raw[0]]
                if abs(x2 - x1) < 8:
                    continue
                slope = (y2 - y1) / (x2 - x1)
                intercept = y1 - slope * x1
                slopes.append((slope, intercept))
                # Hough segments are straight by construction, so their own
                # endpoints cannot reveal curvature. Measure nearby detected
                # edge pixels against the fitted segment instead. This remains
                # an explicit straight-line-deviation proxy, not a calibrated
                # optical distortion coefficient.
                corridor = (
                    (edge_x >= min(x1, x2) - 4)
                    & (edge_x <= max(x1, x2) + 4)
                    & (edge_y >= min(y1, y2) - 8)
                    & (edge_y <= max(y1, y2) + 8)
                )
                if int(np.count_nonzero(corridor)) >= 8:
                    distances = np.abs(slope * edge_x[corridor] - edge_y[corridor] + intercept) / math.sqrt(slope * slope + 1.0)
                    close = distances[distances <= 8.0]
                    if close.size >= 8:
                        distortion_samples.append(float(np.percentile(close, 75)) / max(h, w))
            left = [line for line in slopes if line[0] < -0.1]
            right = [line for line in slopes if line[0] > 0.1]
            if left and right:
                m1, b1 = left[0]
                m2, b2 = right[0]
                x = (b2 - b1) / (m1 - m2)
                y = m1 * x + b1
                if math.isfinite(x) and math.isfinite(y):
                    vanishing_points.append({"x": round(x / w, 4), "y": round(y / h, 4)})

    pan = float(np.mean([shift[0] for shift in shifts])) if shifts else 0.0
    tilt = float(np.mean([shift[1] for shift in shifts])) if shifts else 0.0
    zoom = float(np.mean(zooms)) if zooms else 0.0
    reference_match: float | None = None
    if reference is not None:
        reference_match = image_similarity(arrays[len(arrays) // 2], normalized_rgb(reference))["ssim"]
    confidence = clamp_score((horizon["confidence"] if horizon else 0.2) * 0.6 + min(1.0, len(shifts) / max(1, len(frames) - 1)) * 0.4)
    return {
        "detected_camera_angle": _coarse_angle(horizon),
        "vanishing_points": vanishing_points,
        "horizon_line": horizon,
        "motion_estimate": {"pan": round(pan, 4), "tilt": round(tilt, 4), "zoom": round(zoom, 4)},
        "lens_distortion_estimate": round(float(np.mean(distortion_samples)), 5) if distortion_samples else None,
        "reference_match_score": reference_match,
        "geometry_confidence": confidence,
        "homographies": homographies[:4] if opencv else [],
    }
