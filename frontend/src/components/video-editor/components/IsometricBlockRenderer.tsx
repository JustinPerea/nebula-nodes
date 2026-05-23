import { Suspense } from 'react';
import { ThreeCanvas } from '@remotion/three';
import { OrthographicCamera, useGLTF } from '@react-three/drei';
import { useVideoConfig } from 'remotion';
import type { TrackItem } from '../../../types/video';

interface IsometricBlockRendererProps {
  item: TrackItem;
}

interface CameraConfig {
  azimuth?: number;   // degrees, default 45
  elevation?: number; // degrees, default arctan(1/sqrt(2)) ≈ 35.264
  zoom?: number;      // default 10
}

const DEFAULT_AZIMUTH = 45;
const DEFAULT_ELEVATION = (Math.atan(1 / Math.SQRT2) * 180) / Math.PI; // ≈ 35.264
const DEFAULT_ZOOM = 10;
const CAMERA_RADIUS = 20;

/** Spherical → Cartesian for an orbiting camera looking at origin.
 *  Azimuth = horizontal angle (around Y axis), elevation = vertical angle. */
function cameraPositionFromAngles(camera: CameraConfig): [number, number, number] {
  const azimuth = camera.azimuth ?? DEFAULT_AZIMUTH;
  const elevation = camera.elevation ?? DEFAULT_ELEVATION;
  const azRad = (azimuth * Math.PI) / 180;
  const elRad = (elevation * Math.PI) / 180;
  const x = CAMERA_RADIUS * Math.cos(elRad) * Math.sin(azRad);
  const y = CAMERA_RADIUS * Math.sin(elRad);
  const z = CAMERA_RADIUS * Math.cos(elRad) * Math.cos(azRad);
  return [x, y, z];
}

function PrimitiveCube({ color, size }: { color: string; size: number }) {
  return (
    <mesh>
      <boxGeometry args={[size, size, size]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

function PrimitiveSphere({ color, size }: { color: string; size: number }) {
  return (
    <mesh>
      <sphereGeometry args={[size / 2, 32, 16]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

function PrimitiveCylinder({ color, size }: { color: string; size: number }) {
  return (
    <mesh>
      <cylinderGeometry args={[size / 2, size / 2, size, 24]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

function PrimitiveCone({ color, size }: { color: string; size: number }) {
  return (
    <mesh>
      <coneGeometry args={[size / 2, size, 24]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

function PrimitivePlane({ color, size }: { color: string; size: number }) {
  return (
    <mesh>
      <planeGeometry args={[size, size]} />
      <meshStandardMaterial color={color} side={2 /* THREE.DoubleSide */} />
    </mesh>
  );
}

function GLTFPrimitive({ url }: { url: string }) {
  const gltf = useGLTF(url);
  // gltf.scene is the loaded Three.js Object3D.
  return <primitive object={gltf.scene} />;
}

interface VoxelCell {
  x: number;
  y: number;
  z: number;
  color?: string;
}

function VoxelGrid({ voxels, fallbackColor }: { voxels: VoxelCell[]; fallbackColor: string }) {
  // Initial implementation: render N <mesh> elements (one per cell). Upgrade to
  // <instancedMesh> with per-instance colors in a follow-up if real voxel grids
  // exceed ~500 cells. The 10,000-cell soft cap is enforced by the spec; UI
  // warning lives in the Properties Panel.
  return (
    <>
      {voxels.map((cell, idx) => (
        <mesh key={idx} position={[cell.x, cell.y, cell.z]}>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color={cell.color ?? fallbackColor} />
        </mesh>
      ))}
    </>
  );
}

export function IsometricBlockRenderer({ item }: IsometricBlockRendererProps) {
  const { width, height } = useVideoConfig();
  const geometry = (item.props.geometry as string) ?? 'cube';
  const color = (item.props.color as string) ?? '#888888';
  const size = (item.props.size as number) ?? 1;
  const camera = (item.props.camera as CameraConfig | undefined) ?? {};
  const position = cameraPositionFromAngles(camera);
  const zoom = camera.zoom ?? DEFAULT_ZOOM;

  const voxels = geometry === 'voxel'
    ? ((item.props.voxels as VoxelCell[] | undefined) ?? [])
    : null;

  return (
    <div
      data-iso-geometry={geometry}
      data-voxel-count={voxels?.length}
      style={{ width: '100%', height: '100%' }}
    >
      <ThreeCanvas width={width} height={height}>
        <OrthographicCamera makeDefault position={position} zoom={zoom} />
        <ambientLight intensity={0.5} />
        <directionalLight position={[10, 10, 10]} intensity={1.0} />
        <Suspense fallback={null}>
          {geometry === 'cube'     && <PrimitiveCube     color={color} size={size} />}
          {geometry === 'sphere'   && <PrimitiveSphere   color={color} size={size} />}
          {geometry === 'cylinder' && <PrimitiveCylinder color={color} size={size} />}
          {geometry === 'cone'     && <PrimitiveCone     color={color} size={size} />}
          {geometry === 'plane'    && <PrimitivePlane    color={color} size={size} />}
          {geometry === 'gltf' && (item.props.gltfUrl as string) && (
            <GLTFPrimitive url={item.props.gltfUrl as string} />
          )}
          {geometry === 'voxel' && voxels && (
            <VoxelGrid voxels={voxels} fallbackColor={color} />
          )}
        </Suspense>
      </ThreeCanvas>
    </div>
  );
}
