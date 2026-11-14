import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { shotPortId } from '../constants/ports';
import { sceneCardView } from './cinemaScene';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The handle ids a node has, read from its definition and whatever ports
 * its data still lists, so the wires into a card that can't draw stay drawn. */
export function handleIds(data: Record<string, unknown>): { inputs: string[]; outputs: string[] } {
  const definitionId = typeof data.definitionId === 'string' ? data.definitionId : '';
  const definition = NODE_DEFINITIONS[definitionId];
  const ids = (ports: unknown) => (Array.isArray(ports) ? ports : [])
    .flatMap((port) => (isRecord(port) && typeof port.id === 'string' ? [port.id] : []));
  const inputs = [...ids(definition?.inputPorts), ...ids(data.dynamicInputPorts)];
  const outputs = [...ids(definition?.outputPorts), ...ids(data.dynamicOutputPorts)];
  if (definitionId === 'cinema-scene') {
    const params = isRecord(data.params) ? data.params : {};
    outputs.push(...sceneCardView(params.scene).shots.map((shot) => shotPortId(shot.id)));
  }
  return { inputs: [...new Set(inputs)], outputs: [...new Set(outputs)] };
}

