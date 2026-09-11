import type { ReactNode } from 'react';
import type {
  CameraPath,
  CameraPose,
  DepthMap,
  DepthSequence,
  LocalAssetReference,
  PointCloud,
  SensorRig,
  SensorStream,
  SpatialContext,
  SpatialSessionMetadata,
  WorldValueV2,
} from '../../types/spatial';
import type { PortDataType, PortValue } from '../../types';
import { backendAssetUrlSync } from '../../lib/backend';
import { parseRepresentation, type ParsedRepresentation } from '../../lib/representationViewerRegistry';
import { WorldPreview } from './WorldPreview';
import '../../styles/spatial-preview.css';

interface ViewerOptions {
  readonly compact: boolean;
}

interface SummaryMetric {
  readonly label: string;
  readonly value: string;
}

interface AssetSummary {
  readonly links: readonly LocalAssetReference[];
  readonly total: number;
}

const MAX_VISIBLE_ASSET_LINKS = 3;

function formatNumber(value: number, maximumFractionDigits = 2): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value);
}

function formatDuration(seconds: number): string {
  if (seconds < 1) return `${formatNumber(seconds * 1_000, 0)} ms`;
  if (seconds < 60) return `${formatNumber(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function formatVector(value: readonly number[]): string {
  return value.map((component) => formatNumber(component)).join(', ');
}

function coordinateLabel(value: CameraPose['coordinateSystem']): string {
  return `${value.handedness}-handed · ${value.unit} · ${value.upAxis} up`;
}

function boundedAssets(assets: readonly LocalAssetReference[]): AssetSummary {
  return {
    links: assets.slice(0, MAX_VISIBLE_ASSET_LINKS),
    total: assets.length,
  };
}

function SummaryCard({
  eyebrow,
  title,
  subtitle,
  metrics,
  chips = [],
  assets,
  compact,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly metrics: readonly SummaryMetric[];
  readonly chips?: readonly string[];
  readonly assets?: AssetSummary;
  readonly compact: boolean;
}) {
  return (
    <section
      className={`spatial-preview${compact ? ' spatial-preview--compact' : ''}`}
      aria-label={`${eyebrow} output`}
    >
      <header className="spatial-preview__header">
        <span className="spatial-preview__glyph" aria-hidden="true" />
        <span className="spatial-preview__heading">
          <span className="spatial-preview__eyebrow">{eyebrow}</span>
          <strong className="spatial-preview__title" title={title}>{title}</strong>
        </span>
      </header>
      {subtitle && <p className="spatial-preview__subtitle">{subtitle}</p>}
      <dl className="spatial-preview__metrics">
        {metrics.slice(0, compact ? 3 : 4).map((metric) => (
          <div className="spatial-preview__metric" key={metric.label}>
            <dt>{metric.label}</dt>
            <dd title={metric.value}>{metric.value}</dd>
          </div>
        ))}
      </dl>
      {chips.length > 0 && (
        <div className="spatial-preview__chips" aria-label="Properties">
          {chips.slice(0, compact ? 3 : 5).map((chip) => (
            <span className="spatial-preview__chip" key={chip}>{chip}</span>
          ))}
        </div>
      )}
      {assets && assets.total > 0 && (
        <div className="spatial-preview__assets">
          <span className="spatial-preview__assets-label">Local assets</span>
          {assets.links.map((asset) => (
            <a
              className="spatial-preview__asset nodrag nowheel"
              href={backendAssetUrlSync(asset.uri)}
              download
              key={asset.id}
              onClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              title={`Download ${asset.id}`}
            >
              <span>{asset.id}</span>
              <small>{asset.mediaType}</small>
            </a>
          ))}
          {assets.total > assets.links.length && (
            <span className="spatial-preview__asset-overflow">
              +{assets.total - assets.links.length} more validated local assets
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function InvalidRepresentation({ type, compact }: { readonly type: PortDataType; readonly compact: boolean }) {
  return (
    <section
      className={`spatial-preview spatial-preview--invalid${compact ? ' spatial-preview--compact' : ''}`}
      role="status"
      aria-label={`Invalid ${type} output`}
      data-testid="representation-invalid"
    >
      <span className="spatial-preview__eyebrow">Invalid structured output</span>
      <strong className="spatial-preview__title">{type} unavailable</strong>
      <p className="spatial-preview__subtitle">
        This value does not match Nebula&apos;s versioned spatial contract.
      </p>
    </section>
  );
}

function cameraPoseSummary(value: CameraPose, options: ViewerOptions): ReactNode {
  return (
    <SummaryCard
      eyebrow="Camera pose"
      title={value.id}
      subtitle={coordinateLabel(value.coordinateSystem)}
      compact={options.compact}
      metrics={[
        { label: 'Position', value: formatVector(value.position) },
        { label: 'Orientation', value: formatVector(value.orientation) },
        { label: 'Time', value: value.timestampSeconds === undefined ? 'Unspecified' : formatDuration(value.timestampSeconds) },
        { label: 'Image plane', value: value.intrinsics ? `${value.intrinsics.width} × ${value.intrinsics.height}` : 'No intrinsics' },
      ]}
      chips={value.intrinsics ? ['Pinhole intrinsics', 'Normalized quaternion'] : ['Normalized quaternion']}
    />
  );
}

function cameraPathSummary(value: CameraPath, options: ViewerOptions): ReactNode {
  const firstTime = value.poses[0]?.timestampSeconds ?? 0;
  const lastTime = value.poses[value.poses.length - 1]?.timestampSeconds ?? firstTime;
  return (
    <SummaryCard
      eyebrow="Camera path"
      title={value.id}
      subtitle={coordinateLabel(value.coordinateSystem)}
      compact={options.compact}
      metrics={[
        { label: 'Poses', value: formatNumber(value.poses.length, 0) },
        { label: 'Duration', value: formatDuration(lastTime - firstTime) },
        { label: 'Interpolation', value: value.interpolation },
        { label: 'Path', value: value.closed ? 'Closed loop' : 'Open' },
      ]}
      chips={[value.closed ? 'Loop' : 'Open path', 'Strict timestamps']}
    />
  );
}

function spatialContextSummary(value: SpatialContext, options: ViewerOptions): ReactNode {
  const roles = new Set(value.anchors.map((anchor) => anchor.role));
  return (
    <SummaryCard
      eyebrow="Spatial context"
      title={value.id}
      subtitle={coordinateLabel(value.coordinateSystem)}
      compact={options.compact}
      metrics={[
        { label: 'Anchors', value: formatNumber(value.anchors.length, 0) },
        { label: 'Roles', value: formatNumber(roles.size, 0) },
        { label: 'Frame', value: value.coordinateSystem.id },
      ]}
      chips={Array.from(roles)}
      assets={boundedAssets(value.anchors.map((anchor) => anchor.asset))}
    />
  );
}

function depthMapSummary(value: DepthMap, options: ViewerOptions): ReactNode {
  return (
    <SummaryCard
      eyebrow="Depth map"
      title={value.id}
      subtitle={coordinateLabel(value.coordinateSystem)}
      compact={options.compact}
      metrics={[
        { label: 'Resolution', value: `${value.width} × ${value.height}` },
        { label: 'Range', value: `${formatNumber(value.minDepth)}–${formatNumber(value.maxDepth)} ${value.unit}` },
        { label: 'Encoding', value: value.encoding },
        { label: 'Camera', value: value.cameraPose.id },
      ]}
      chips={[
        `${value.depthConvention} · ${value.byteOrder}`,
        `distance = sample × ${value.sampleScale} + ${value.sampleOffset}`,
        value.invalidSample === null ? 'Invalid: nonfinite samples' : `Invalid: ${value.invalidSample} and nonfinite samples`,
      ]}
      assets={boundedAssets([value.asset])}
    />
  );
}

function depthSequenceSummary(value: DepthSequence, options: ViewerOptions): ReactNode {
  const firstFrame = value.frames[0];
  const lastFrame = value.frames[value.frames.length - 1];
  const firstTime = firstFrame?.cameraPose.timestampSeconds ?? 0;
  const lastTime = lastFrame?.cameraPose.timestampSeconds ?? firstTime;
  return (
    <SummaryCard
      eyebrow="Depth sequence"
      title={value.id}
      subtitle={coordinateLabel(value.coordinateSystem)}
      compact={options.compact}
      metrics={[
        { label: 'Frames', value: formatNumber(value.frames.length, 0) },
        { label: 'Duration', value: formatDuration(lastTime - firstTime) },
        { label: 'First resolution', value: firstFrame ? `${firstFrame.width} × ${firstFrame.height}` : 'Unavailable' },
        { label: 'First encoding', value: firstFrame?.encoding ?? 'Unavailable' },
      ]}
      assets={boundedAssets(value.frames.map((frame) => frame.asset))}
    />
  );
}

function pointCloudSummary(value: PointCloud, options: ViewerOptions): ReactNode {
  return (
    <SummaryCard
      eyebrow="Point cloud"
      title={value.id}
      subtitle={coordinateLabel(value.coordinateSystem)}
      compact={options.compact}
      metrics={[
        { label: 'Points', value: formatNumber(value.pointCount, 0) },
        { label: 'Format', value: value.format.toUpperCase() },
        { label: 'Color', value: value.hasColor ? 'Included' : 'Absent' },
        { label: 'Normals', value: value.hasNormals ? 'Included' : 'Absent' },
      ]}
      chips={[value.hasColor ? 'Color' : 'No color', value.hasNormals ? 'Normals' : 'No normals']}
      assets={boundedAssets([value.asset])}
    />
  );
}

function sensorRigSummary(value: SensorRig, options: ViewerOptions): ReactNode {
  const modalities = Array.from(new Set(value.sensors.map((sensor) => sensor.modality)));
  return (
    <SummaryCard
      eyebrow="Sensor rig"
      title={value.id}
      subtitle={coordinateLabel(value.coordinateSystem)}
      compact={options.compact}
      metrics={[
        { label: 'Sensors', value: formatNumber(value.sensors.length, 0) },
        { label: 'Modalities', value: formatNumber(modalities.length, 0) },
        { label: 'Frame', value: value.coordinateSystem.id },
      ]}
      chips={modalities}
    />
  );
}

function sensorStreamSummary(value: SensorStream, options: ViewerOptions): ReactNode {
  const firstTime = value.samples[0]?.timestampSeconds ?? 0;
  const lastTime = value.samples[value.samples.length - 1]?.timestampSeconds ?? firstTime;
  return (
    <SummaryCard
      eyebrow="Sensor stream"
      title={value.id}
      subtitle={coordinateLabel(value.coordinateSystem)}
      compact={options.compact}
      metrics={[
        { label: 'Samples', value: formatNumber(value.samples.length, 0) },
        { label: 'Duration', value: formatDuration(lastTime - firstTime) },
        { label: 'Sensor', value: value.sensorId },
        { label: 'Rig', value: value.rigId },
      ]}
      chips={[value.modality, 'Strict timestamps']}
      assets={boundedAssets(value.samples.map((sample) => sample.asset))}
    />
  );
}

function spatialSessionSummary(value: SpatialSessionMetadata, options: ViewerOptions): ReactNode {
  const created = value.createdAtMs === undefined
    ? 'Unspecified'
    : value.createdAtMs > 8_640_000_000_000_000
      ? `${value.createdAtMs} ms since epoch`
      : new Date(value.createdAtMs).toLocaleString();
  return (
    <SummaryCard
      eyebrow="Spatial session"
      title={value.label ?? value.id}
      subtitle={value.id}
      compact={options.compact}
      metrics={[
        { label: 'Source', value: value.source },
        { label: 'Provider', value: value.provider ?? 'Provider-neutral' },
        { label: 'Model', value: value.model ?? 'Unspecified' },
        { label: 'Created', value: created },
      ]}
      chips={value.tags}
    />
  );
}

function collectWorldAssets(value: WorldValueV2): AssetSummary {
  const links: LocalAssetReference[] = [];
  const add = (asset: LocalAssetReference | undefined) => {
    if (asset && links.length < MAX_VISIBLE_ASSET_LINKS) links.push(asset);
  };
  value.assets.splats.forEach((splat) => add(splat.asset));
  add(value.assets.panorama);
  add(value.assets.colliderMesh);
  add(value.assets.thumbnail);
  add(value.assets.pointCloud?.asset);
  value.assets.depthSequence?.frames.forEach((frame) => add(frame.asset));
  value.spatialContext?.anchors.forEach((anchor) => add(anchor.asset));
  const total = value.assets.splats.length
    + (value.assets.panorama ? 1 : 0)
    + (value.assets.colliderMesh ? 1 : 0)
    + (value.assets.thumbnail ? 1 : 0)
    + (value.assets.pointCloud ? 1 : 0)
    + (value.assets.depthSequence?.frames.length ?? 0)
    + (value.spatialContext?.anchors.length ?? 0);
  return { links, total };
}

function worldV2Summary(value: WorldValueV2, options: ViewerOptions): ReactNode {
  const representations = value.assets.splats.length
    + (value.assets.pointCloud ? 1 : 0)
    + (value.assets.depthSequence ? 1 : 0)
    + (value.assets.panorama ? 1 : 0)
    + (value.assets.colliderMesh ? 1 : 0);
  return (
    <SummaryCard
      eyebrow="World · contract v2"
      title={value.displayName}
      subtitle={`${value.coordinateSystem.handedness}-handed · ${value.coordinateSystem.unit} · ${value.coordinateSystem.upAxis} up`}
      compact={options.compact}
      metrics={[
        { label: 'Representations', value: formatNumber(representations, 0) },
        { label: 'Splats', value: formatNumber(value.assets.splats.length, 0) },
        { label: 'Session', value: value.session.source },
        { label: 'Provider', value: value.session.provider ?? 'Provider-neutral' },
      ]}
      chips={[
        ...(value.assets.pointCloud ? ['Point cloud'] : []),
        ...(value.assets.depthSequence ? ['Depth sequence'] : []),
        ...(value.spatialContext ? ['Spatial context'] : []),
        ...(value.defaultCamera ? ['Default camera'] : []),
      ]}
      assets={collectWorldAssets(value)}
    />
  );
}

function renderRepresentation(value: ParsedRepresentation, options: ViewerOptions): ReactNode {
  switch (value.type) {
    case 'World':
      return value.value.version === 1
        ? <WorldPreview value={value.value.value} compact={options.compact} />
        : worldV2Summary(value.value.value, options);
    case 'CameraPose':
      return cameraPoseSummary(value.value, options);
    case 'CameraPath':
      return cameraPathSummary(value.value, options);
    case 'SpatialContext':
      return spatialContextSummary(value.value, options);
    case 'DepthMap':
      return depthMapSummary(value.value, options);
    case 'DepthSequence':
      return depthSequenceSummary(value.value, options);
    case 'PointCloud':
      return pointCloudSummary(value.value, options);
    case 'SensorRig':
      return sensorRigSummary(value.value, options);
    case 'SensorStream':
      return sensorStreamSummary(value.value, options);
    case 'SpatialSession':
      return spatialSessionSummary(value.value, options);
  }
}

export function RepresentationViewer({
  type,
  value,
  compact = false,
}: {
  readonly type: PortDataType;
  readonly value: PortValue['value'] | unknown;
  readonly compact?: boolean;
}) {
  const parsed = parseRepresentation(type, value);
  if (!parsed) return <InvalidRepresentation type={type} compact={compact} />;
  return <>{renderRepresentation(parsed, { compact })}</>;
}
