import type { ModelNodeDefinition, NodeData, PortDataType } from '../types';
import { isPortCompatible } from './portCompatibility';

export type NextStepIntent = 'all' | 'edit-image' | 'image-to-video';
export interface CompatibleStep { definition: ModelNodeDefinition; matchingPortId: string; matchingPortLabel: string }

/** A graph edge reads the canonical output, never a batch preview's alternate. */
export function currentMediaSource(definition: ModelNodeDefinition, data: NodeData,
  displayedOutputs = data.outputs) {
  if (data.state !== 'complete') return null;
  for (const port of definition.outputPorts) {
    if (port.dataType !== 'Image' && port.dataType !== 'Video') continue;
    const output = data.outputs[port.id];
    if (output?.type === port.dataType && typeof output.value === 'string' && output.value
      && displayedOutputs[port.id]?.value === output.value) {
      return { handleId: port.id, dataType: port.dataType, value: output.value };
    }
  }
  return null;
}

export function compatibleSteps(definitions: ModelNodeDefinition[], type: PortDataType,
  direction: 'source' | 'target', intent: NextStepIntent = 'all'): CompatibleStep[] {
  return definitions.flatMap((definition) => {
    const ports = direction === 'source' ? definition.inputPorts : definition.outputPorts;
    const candidates = ports.filter((port) => direction === 'source'
      ? isPortCompatible(type, port.dataType) : isPortCompatible(port.dataType, type));
    // A mask or universal input is a fallback, not the primary artwork input.
    const port = candidates.find((candidate) => candidate.dataType === type) ?? candidates[0];
    if (!port) return [];
    if (intent !== 'all' && (direction !== 'source' || type !== 'Image' || port.dataType !== 'Image')) return [];
    if (intent === 'edit-image' && (!['image-gen', 'transform'].includes(definition.category)
      || !definition.outputPorts.some((output) => output.dataType === 'Image'))) return [];
    if (intent === 'image-to-video' && (definition.category !== 'video-gen'
      || !definition.outputPorts.some((output) => output.dataType === 'Video'))) return [];
    return [{ definition, matchingPortId: port.id, matchingPortLabel: port.label }];
  });
}
