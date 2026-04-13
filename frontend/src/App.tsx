import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './components/Canvas';
import { NodeLibrary } from './components/panels/NodeLibrary';
import { Inspector } from './components/panels/Inspector';
import { Toolbar } from './components/panels/Toolbar';
import './App.css';

export default function App() {
  return (
    <ReactFlowProvider>
      <Canvas />
      <NodeLibrary />
      <Inspector />
      <Toolbar />
    </ReactFlowProvider>
  );
}
