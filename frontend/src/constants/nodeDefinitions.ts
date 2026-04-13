import type { ModelNodeDefinition } from '../types';

export const NODE_DEFINITIONS: Record<string, ModelNodeDefinition> = {
  'gpt-image-1-generate': {
    id: 'gpt-image-1-generate',
    displayName: 'GPT Image 1',
    category: 'image-gen',
    apiProvider: 'openai',
    apiEndpoint: '/v1/images/generations',
    envKeyName: 'OPENAI_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: true,
        default: 'gpt-image-1',
        options: [
          { label: 'GPT Image 1', value: 'gpt-image-1' },
          { label: 'GPT Image 1.5', value: 'gpt-image-1.5' },
          { label: 'GPT Image 1 Mini', value: 'gpt-image-1-mini' },
        ],
      },
      {
        key: 'size',
        label: 'Size',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '1024×1024', value: '1024x1024' },
          { label: '1536×1024', value: '1536x1024' },
          { label: '1024×1536', value: '1024x1536' },
        ],
      },
      {
        key: 'quality',
        label: 'Quality',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: 'Low', value: 'low' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
        ],
      },
      {
        key: 'n',
        label: 'Count',
        type: 'integer',
        required: false,
        default: 1,
        min: 1,
        max: 10,
      },
    ],
  },

  'claude-chat': {
    id: 'claude-chat',
    displayName: 'Claude',
    category: 'text-gen',
    apiProvider: 'anthropic',
    apiEndpoint: '/v1/messages',
    envKeyName: 'ANTHROPIC_API_KEY',
    executionPattern: 'stream',
    inputPorts: [
      { id: 'messages', label: 'Messages', dataType: 'Text', required: true },
      { id: 'images', label: 'Images', dataType: 'Image', required: false, multiple: true },
    ],
    outputPorts: [
      { id: 'text', label: 'Text', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: true,
        default: 'claude-sonnet-4-6',
        options: [
          { label: 'Claude Opus 4', value: 'claude-opus-4-20250514' },
          { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
          { label: 'Claude Haiku 3.5', value: 'claude-haiku-3-5-20241022' },
        ],
      },
      {
        key: 'max_tokens',
        label: 'Max Tokens',
        type: 'integer',
        required: true,
        default: 4096,
        min: 1,
        max: 200000,
      },
      {
        key: 'temperature',
        label: 'Temperature',
        type: 'float',
        required: false,
        default: 1,
        min: 0,
        max: 1,
        step: 0.1,
      },
    ],
  },

  'runway-gen4-turbo': {
    id: 'runway-gen4-turbo',
    displayName: 'Runway Gen-4 Turbo',
    category: 'video-gen',
    apiProvider: 'runway',
    apiEndpoint: '/v1/tasks',
    envKeyName: 'RUNWAY_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: false },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: true,
        default: 'gen4_turbo',
        options: [
          { label: 'Gen-4 Turbo', value: 'gen4_turbo' },
          { label: 'Gen-4', value: 'gen4' },
          { label: 'Gen-4 Aleph', value: 'gen4_aleph' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration',
        type: 'enum',
        required: false,
        default: 5,
        options: [
          { label: '5 seconds', value: 5 },
          { label: '10 seconds', value: 10 },
        ],
      },
    ],
  },

  'elevenlabs-tts': {
    id: 'elevenlabs-tts',
    displayName: 'ElevenLabs TTS',
    category: 'audio-gen',
    apiProvider: 'elevenlabs',
    apiEndpoint: '/v1/text-to-speech/{voice_id}',
    envKeyName: 'ELEVENLABS_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'text', label: 'Text', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: false },
    ],
    params: [
      {
        key: 'model_id',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'eleven_multilingual_v2',
        options: [
          { label: 'v3 (Highest)', value: 'elevenlabs_v3' },
          { label: 'Multilingual v2', value: 'eleven_multilingual_v2' },
          { label: 'Flash v2.5', value: 'eleven_flash_v2_5' },
        ],
      },
      {
        key: 'stability',
        label: 'Stability',
        type: 'float',
        required: false,
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
      },
    ],
  },

  'flux-1-1-ultra': {
    id: 'flux-1-1-ultra',
    displayName: 'FLUX 1.1 Ultra',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/flux-pro/v1.1-ultra',
    envKeyName: ['FAL_KEY', 'BFL_API_KEY'],
    executionPattern: 'sync',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'image', label: 'Image Guide', dataType: 'Image', required: false },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'aspect_ratio',
        label: 'Aspect Ratio',
        type: 'enum',
        required: false,
        default: '16:9',
        options: [
          { label: '1:1', value: '1:1' },
          { label: '4:3', value: '4:3' },
          { label: '16:9', value: '16:9' },
          { label: '9:16', value: '9:16' },
        ],
      },
      {
        key: 'num_images',
        label: 'Count',
        type: 'integer',
        required: false,
        default: 1,
        min: 1,
        max: 4,
      },
    ],
  },

  'text-input': {
    id: 'text-input',
    displayName: 'Text Input',
    category: 'utility',
    apiProvider: 'openai',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [],
    outputPorts: [
      { id: 'text', label: 'Text', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'value',
        label: 'Text',
        type: 'textarea',
        required: true,
        default: '',
        placeholder: 'Enter text or prompt...',
      },
    ],
  },

  'image-input': {
    id: 'image-input',
    displayName: 'Image Input',
    category: 'utility',
    apiProvider: 'openai',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'filePath',
        label: 'File',
        type: 'file',
        required: true,
        default: '',
      },
    ],
  },

  'preview': {
    id: 'preview',
    displayName: 'Preview',
    category: 'utility',
    apiProvider: 'openai',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      { id: 'input', label: 'Input', dataType: 'Any', required: true },
    ],
    outputPorts: [],
    params: [],
  },

  'combine-text': {
    id: 'combine-text',
    displayName: 'Combine Text',
    category: 'utility',
    apiProvider: 'openai',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      { id: 'text1', label: 'Text 1', dataType: 'Text', required: true },
      { id: 'text2', label: 'Text 2', dataType: 'Text', required: false },
      { id: 'text3', label: 'Text 3', dataType: 'Text', required: false },
    ],
    outputPorts: [
      { id: 'text', label: 'Text', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'separator',
        label: 'Separator',
        type: 'string',
        required: false,
        default: '\\n',
        placeholder: 'e.g. \\n or " | " or ", "',
      },
      {
        key: 'template',
        label: 'Template',
        type: 'textarea',
        required: false,
        default: '',
        placeholder: 'Optional: use {text1}, {text2}, {text3} placeholders',
      },
    ],
  },

  'router': {
    id: 'router',
    displayName: 'Router',
    category: 'utility',
    apiProvider: 'openai',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      { id: 'input', label: 'Input', dataType: 'Any', required: true },
    ],
    outputPorts: [
      { id: 'out1', label: 'Out 1', dataType: 'Any', required: false },
      { id: 'out2', label: 'Out 2', dataType: 'Any', required: false },
      { id: 'out3', label: 'Out 3', dataType: 'Any', required: false },
    ],
    params: [],
  },

  'reroute': {
    id: 'reroute',
    displayName: 'Reroute',
    category: 'utility',
    apiProvider: 'openai',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      { id: 'input', label: '', dataType: 'Any', required: true },
    ],
    outputPorts: [
      { id: 'output', label: '', dataType: 'Any', required: false },
    ],
    params: [],
  },

  'openrouter-universal': {
    id: 'openrouter-universal',
    displayName: 'OpenRouter',
    category: 'universal',
    apiProvider: 'openrouter',
    apiEndpoint: 'https://openrouter.ai/api/v1/chat/completions',
    envKeyName: 'OPENROUTER_API_KEY',
    executionPattern: 'stream',
    inputPorts: [
      { id: 'messages', label: 'Messages', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'text', label: 'Text', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'Loading models...',
      },
      {
        key: 'temperature',
        label: 'Temperature',
        type: 'float',
        required: false,
        default: 1.0,
        min: 0,
        max: 2,
        step: 0.1,
      },
      {
        key: 'max_tokens',
        label: 'Max Tokens',
        type: 'integer',
        required: false,
        default: 4096,
        min: 1,
        max: 200000,
      },
    ],
  },

  'replicate-universal': {
    id: 'replicate-universal',
    displayName: 'Replicate',
    category: 'universal',
    apiProvider: 'replicate',
    apiEndpoint: 'https://api.replicate.com/v1/predictions',
    envKeyName: 'REPLICATE_API_TOKEN',
    executionPattern: 'async-poll',
    inputPorts: [],
    outputPorts: [],
    params: [
      {
        key: 'model_id',
        label: 'Model ID',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'owner/name (e.g. stability-ai/sdxl)',
      },
    ],
  },

  'fal-universal': {
    id: 'fal-universal',
    displayName: 'FAL',
    category: 'universal',
    apiProvider: 'fal',
    apiEndpoint: 'https://queue.fal.run',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'endpoint_id',
        label: 'Endpoint',
        type: 'string',
        required: true,
        default: 'fal-ai/flux-pro/v1.1-ultra',
        placeholder: 'fal-ai/flux-pro/v1.1-ultra',
      },
    ],
  },
};

export function getNodeDefinition(definitionId: string): ModelNodeDefinition | undefined {
  return NODE_DEFINITIONS[definitionId];
}

export function getNodesByCategory(): Record<string, ModelNodeDefinition[]> {
  const grouped: Record<string, ModelNodeDefinition[]> = {};
  for (const def of Object.values(NODE_DEFINITIONS)) {
    if (!grouped[def.category]) {
      grouped[def.category] = [];
    }
    grouped[def.category].push(def);
  }
  return grouped;
}
