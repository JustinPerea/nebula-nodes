import { NODE_DEFINITIONS } from '../frontend/src/constants/nodeDefinitions';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = `${__dirname}/../backend/data/node_definitions.json`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(NODE_DEFINITIONS, null, 2));

console.log(`Exported ${Object.keys(NODE_DEFINITIONS).length} node definitions to backend/data/node_definitions.json`);
