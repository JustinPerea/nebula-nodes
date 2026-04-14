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
      {
        key: 'voice_id',
        label: 'Voice ID',
        type: 'string',
        required: false,
        default: '21m00Tcm4TlvDq8ikWAM',
        placeholder: 'Rachel (default)',
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

  'dalle-3-generate': {
    id: 'dalle-3-generate',
    displayName: 'DALL-E 3',
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
        default: 'dall-e-3',
        options: [
          { label: 'DALL-E 3', value: 'dall-e-3' },
          { label: 'DALL-E 2', value: 'dall-e-2' },
        ],
      },
      {
        key: 'size',
        label: 'Size',
        type: 'enum',
        required: false,
        default: '1024x1024',
        options: [
          { label: '1024×1024', value: '1024x1024' },
          { label: '1024×1792', value: '1024x1792' },
          { label: '1792×1024', value: '1792x1024' },
        ],
      },
      {
        key: 'quality',
        label: 'Quality',
        type: 'enum',
        required: false,
        default: 'standard',
        options: [
          { label: 'Standard', value: 'standard' },
          { label: 'HD', value: 'hd' },
        ],
      },
      {
        key: 'style',
        label: 'Style',
        type: 'enum',
        required: false,
        default: 'vivid',
        options: [
          { label: 'Vivid', value: 'vivid' },
          { label: 'Natural', value: 'natural' },
        ],
      },
    ],
  },

  'gpt-4o-chat': {
    id: 'gpt-4o-chat',
    displayName: 'GPT-4o Chat',
    category: 'text-gen',
    apiProvider: 'openai',
    apiEndpoint: '/v1/chat/completions',
    envKeyName: 'OPENAI_API_KEY',
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
        default: 'gpt-4o',
        options: [
          { label: 'GPT-4o', value: 'gpt-4o' },
          { label: 'GPT-4o Mini', value: 'gpt-4o-mini' },
          { label: 'GPT-4.1', value: 'gpt-4.1' },
        ],
      },
      {
        key: 'max_tokens',
        label: 'Max Tokens',
        type: 'integer',
        required: false,
        default: 4096,
        min: 1,
        max: 128000,
      },
      {
        key: 'temperature',
        label: 'Temperature',
        type: 'float',
        required: false,
        default: 1,
        min: 0,
        max: 2,
        step: 0.1,
      },
    ],
  },

  'gemini-chat': {
    id: 'gemini-chat',
    displayName: 'Gemini',
    category: 'text-gen',
    apiProvider: 'google',
    apiEndpoint: '/v1beta/models/{model}:streamGenerateContent',
    envKeyName: 'GOOGLE_API_KEY',
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
        default: 'gemini-2.5-flash',
        options: [
          { label: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro' },
          { label: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash' },
          { label: 'Gemini 3 Pro Preview', value: 'gemini-3-pro-preview' },
          { label: 'Gemini 3 Flash Preview', value: 'gemini-3-flash-preview' },
        ],
      },
      {
        key: 'max_tokens',
        label: 'Max Tokens',
        type: 'integer',
        required: false,
        default: 8192,
        min: 1,
        max: 65535,
      },
      {
        key: 'temperature',
        label: 'Temperature',
        type: 'float',
        required: false,
        default: 1,
        min: 0,
        max: 2,
        step: 0.1,
      },
      {
        key: 'thinkingBudget',
        label: 'Thinking Budget',
        type: 'integer',
        required: false,
        placeholder: 'Default',
        min: 0,
        max: 65536,
      },
    ],
  },

  'imagen-4-generate': {
    id: 'imagen-4-generate',
    displayName: 'Imagen 4',
    category: 'image-gen',
    apiProvider: 'google',
    apiEndpoint: '/v1beta/models/{model}:generateImages',
    envKeyName: 'GOOGLE_API_KEY',
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
        default: 'imagen-4.0-generate-001',
        options: [
          { label: 'Imagen 4', value: 'imagen-4.0-generate-001' },
          { label: 'Imagen 4 Ultra', value: 'imagen-4.0-ultra-generate-001' },
          { label: 'Imagen 4 Fast', value: 'imagen-4.0-fast-generate-001' },
        ],
      },
      {
        key: 'aspectRatio',
        label: 'Aspect Ratio',
        type: 'enum',
        required: false,
        default: '1:1',
        options: [
          { label: '1:1', value: '1:1' },
          { label: '4:3', value: '4:3' },
          { label: '3:4', value: '3:4' },
          { label: '16:9', value: '16:9' },
          { label: '9:16', value: '9:16' },
        ],
      },
      {
        key: 'numberOfImages',
        label: 'Count',
        type: 'integer',
        required: false,
        default: 1,
        min: 1,
        max: 4,
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        placeholder: 'Random',
      },
      {
        key: 'enhancePrompt',
        label: 'Enhance Prompt',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'personGeneration',
        label: 'Person Generation',
        type: 'enum',
        required: false,
        default: 'allow_adult',
        options: [
          { label: 'Allow All', value: 'allow_all' },
          { label: 'Allow Adult', value: 'allow_adult' },
          { label: "Don't Allow", value: 'dont_allow' },
        ],
      },
    ],
  },

  'kling-v2-1': {
    id: 'kling-v2-1',
    displayName: 'Kling v2.1',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/kling-video/v2.1/pro/image-to-video',
    envKeyName: 'FAL_KEY',
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
        key: 'duration',
        label: 'Duration',
        type: 'enum',
        required: false,
        default: '5',
        options: [
          { label: '5 seconds', value: '5' },
          { label: '10 seconds', value: '10' },
        ],
      },
      {
        key: 'aspect_ratio',
        label: 'Aspect Ratio',
        type: 'enum',
        required: false,
        default: '16:9',
        options: [
          { label: '16:9', value: '16:9' },
          { label: '9:16', value: '9:16' },
          { label: '1:1', value: '1:1' },
        ],
      },
    ],
  },

  'sora-2': {
    id: 'sora-2',
    displayName: 'Sora 2',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/sora-2/text-to-video',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '1080p',
        options: [
          { label: '720p', value: '720p' },
          { label: '1080p', value: '1080p' },
        ],
      },
      {
        key: 'aspect_ratio',
        label: 'Aspect Ratio',
        type: 'enum',
        required: false,
        default: '16:9',
        options: [
          { label: '16:9', value: '16:9' },
          { label: '9:16', value: '9:16' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration (s)',
        type: 'enum',
        required: false,
        default: 4,
        options: [
          { label: '4s', value: 4 },
          { label: '8s', value: 8 },
          { label: '12s', value: 12 },
          { label: '16s', value: 16 },
          { label: '20s', value: 20 },
        ],
      },
    ],
  },

  'nano-banana': {
    id: 'nano-banana',
    displayName: 'Nano Banana',
    category: 'image-gen',
    apiProvider: 'google',
    apiEndpoint: '/v1beta/models/{model}:generateContent',
    envKeyName: 'GOOGLE_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'images', label: 'Images', dataType: 'Image', required: false, multiple: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
      { id: 'text', label: 'Text', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'gemini-2.5-flash-preview-05-20',
        options: [
          { label: 'Gemini 2.5 Flash Image', value: 'gemini-2.5-flash-preview-05-20' },
          { label: 'Gemini 3.1 Flash Image Preview', value: 'gemini-3.1-flash-image-preview' },
          { label: 'Gemini 3 Pro Image', value: 'gemini-3-pro-image-preview' },
        ],
      },
      {
        key: 'aspect_ratio',
        label: 'Aspect Ratio',
        type: 'enum',
        required: false,
        default: '1:1',
        options: [
          { label: '1:1', value: '1:1' },
          { label: '16:9', value: '16:9' },
          { label: '9:16', value: '9:16' },
          { label: '4:3', value: '4:3' },
          { label: '3:4', value: '3:4' },
        ],
      },
    ],
  },

  'veo-3': {
    id: 'veo-3',
    displayName: 'Veo 3',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/veo3',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'aspect_ratio',
        label: 'Aspect Ratio',
        type: 'enum',
        required: false,
        default: '16:9',
        options: [
          { label: '16:9', value: '16:9' },
          { label: '9:16', value: '9:16' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration',
        type: 'enum',
        required: false,
        default: '8s',
        options: [
          { label: '8 seconds', value: '8s' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '720p',
        options: [
          { label: '720p', value: '720p' },
          { label: '1080p', value: '1080p' },
        ],
      },
    ],
  },

  'flux-schnell': {
    id: 'flux-schnell',
    displayName: 'FLUX Schnell',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/flux/schnell',
    envKeyName: 'FAL_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
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
          { label: '16:9', value: '16:9' },
          { label: '9:16', value: '9:16' },
          { label: '4:3', value: '4:3' },
          { label: '3:4', value: '3:4' },
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
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        default: undefined,
        min: 0,
        max: 2147483647,
      },
    ],
  },

  'fast-sdxl': {
    id: 'fast-sdxl',
    displayName: 'Fast SDXL',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/fast-sdxl',
    envKeyName: 'FAL_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'image_size',
        label: 'Image Size',
        type: 'enum',
        required: false,
        default: 'square_hd',
        options: [
          { label: 'Square HD', value: 'square_hd' },
          { label: 'Square', value: 'square' },
          { label: 'Landscape 4:3', value: 'landscape_4_3' },
          { label: 'Landscape 16:9', value: 'landscape_16_9' },
          { label: 'Portrait 4:3', value: 'portrait_4_3' },
          { label: 'Portrait 16:9', value: 'portrait_16_9' },
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
      {
        key: 'guidance_scale',
        label: 'Guidance Scale',
        type: 'float',
        required: false,
        default: 7.5,
        min: 1,
        max: 20,
        step: 0.5,
      },
      {
        key: 'negative_prompt',
        label: 'Negative Prompt',
        type: 'string',
        required: false,
        default: '',
        placeholder: 'What to avoid in the image...',
      },
    ],
  },

  'wan-2-6-t2v': {
    id: 'wan-2-6-t2v',
    displayName: 'Wan 2.6 T2V',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'wan/v2.6/text-to-video',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'duration',
        label: 'Duration',
        type: 'enum',
        required: false,
        default: '5s',
        options: [
          { label: '5 seconds', value: '5s' },
          { label: '10 seconds', value: '10s' },
          { label: '15 seconds', value: '15s' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '720p',
        options: [
          { label: '720p', value: '720p' },
          { label: '1080p', value: '1080p' },
        ],
      },
      {
        key: 'aspect_ratio',
        label: 'Aspect Ratio',
        type: 'enum',
        required: false,
        default: '16:9',
        options: [
          { label: '16:9', value: '16:9' },
          { label: '9:16', value: '9:16' },
          { label: '1:1', value: '1:1' },
        ],
      },
    ],
  },

  'luma-ray2-t2v': {
    id: 'luma-ray2-t2v',
    displayName: 'Luma Ray 2',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/luma-dream-machine/ray-2',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
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
          { label: '16:9', value: '16:9' },
          { label: '9:16', value: '9:16' },
          { label: '4:3', value: '4:3' },
          { label: '3:4', value: '3:4' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration',
        type: 'enum',
        required: false,
        default: '5s',
        options: [
          { label: '5 seconds', value: '5s' },
          { label: '9 seconds', value: '9s' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '720p',
        options: [
          { label: '540p', value: '540p' },
          { label: '720p', value: '720p' },
          { label: '1080p', value: '1080p' },
        ],
      },
    ],
  },

  'ltx-video-2': {
    id: 'ltx-video-2',
    displayName: 'LTX Video 2',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/ltx-2/image-to-video',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'duration',
        label: 'Duration',
        type: 'enum',
        required: false,
        default: '6',
        options: [
          { label: '6 seconds', value: '6' },
          { label: '8 seconds', value: '8' },
          { label: '10 seconds', value: '10' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '1080p',
        options: [
          { label: '1080p', value: '1080p' },
          { label: '1440p', value: '1440p' },
          { label: '2160p', value: '2160p' },
        ],
      },
    ],
  },

  'meshy-text-to-3d': {
    id: 'meshy-text-to-3d',
    displayName: 'Meshy 6 Text-to-3D',
    category: '3d-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/meshy/v6/text-to-3d',
    envKeyName: ['MESHY_API_KEY', 'FAL_KEY'],
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'mesh', label: 'Mesh', dataType: 'Mesh', required: false },
    ],
    params: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'enum',
        required: false,
        default: 'full',
        options: [
          { label: 'Preview', value: 'preview' },
          { label: 'Full', value: 'full' },
        ],
      },
      {
        key: 'topology',
        label: 'Topology',
        type: 'enum',
        required: false,
        default: 'triangle',
        options: [
          { label: 'Triangle', value: 'triangle' },
          { label: 'Quad', value: 'quad' },
        ],
      },
      {
        key: 'target_polycount',
        label: 'Polycount',
        type: 'integer',
        required: false,
        default: 30000,
        min: 1000,
        max: 200000,
      },
      {
        key: 'symmetry_mode',
        label: 'Symmetry',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Off', value: 'off' },
          { label: 'Auto', value: 'auto' },
          { label: 'On', value: 'on' },
        ],
      },
      {
        key: 'enable_pbr',
        label: 'PBR Materials',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'pose_mode',
        label: 'Pose Mode',
        type: 'enum',
        required: false,
        default: '',
        options: [
          { label: 'None', value: '' },
          { label: 'A-Pose', value: 'a-pose' },
          { label: 'T-Pose', value: 't-pose' },
        ],
      },
      {
        key: 'enable_rigging',
        label: 'Rigging',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        placeholder: 'Random',
      },
    ],
  },

  'meshy-image-to-3d': {
    id: 'meshy-image-to-3d',
    displayName: 'Meshy 6 Image-to-3D',
    category: '3d-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/meshy/v6/image-to-3d',
    envKeyName: ['MESHY_API_KEY', 'FAL_KEY'],
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
    ],
    outputPorts: [
      { id: 'mesh', label: 'Mesh', dataType: 'Mesh', required: false },
    ],
    params: [
      {
        key: 'topology',
        label: 'Topology',
        type: 'enum',
        required: false,
        default: 'triangle',
        options: [
          { label: 'Triangle', value: 'triangle' },
          { label: 'Quad', value: 'quad' },
        ],
      },
      {
        key: 'target_polycount',
        label: 'Polycount',
        type: 'integer',
        required: false,
        default: 30000,
        min: 1000,
        max: 200000,
      },
      {
        key: 'symmetry_mode',
        label: 'Symmetry',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Off', value: 'off' },
          { label: 'Auto', value: 'auto' },
          { label: 'On', value: 'on' },
        ],
      },
      {
        key: 'should_texture',
        label: 'Texture',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'enable_pbr',
        label: 'PBR Materials',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'pose_mode',
        label: 'Pose Mode',
        type: 'enum',
        required: false,
        default: '',
        options: [
          { label: 'None', value: '' },
          { label: 'A-Pose', value: 'a-pose' },
          { label: 'T-Pose', value: 't-pose' },
        ],
      },
      {
        key: 'enable_rigging',
        label: 'Rigging',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        placeholder: 'Random',
      },
    ],
  },

  'hunyuan3d-text-to-3d': {
    id: 'hunyuan3d-text-to-3d',
    displayName: 'Hunyuan3D V3 Text-to-3D',
    category: '3d-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/hunyuan3d-v3/text-to-3d',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'mesh', label: 'Mesh', dataType: 'Mesh', required: false },
    ],
    params: [
      {
        key: 'generate_type',
        label: 'Quality',
        type: 'enum',
        required: false,
        default: 'Normal',
        options: [
          { label: 'Normal', value: 'Normal' },
          { label: 'Low Poly', value: 'LowPoly' },
          { label: 'Geometry Only', value: 'Geometry' },
        ],
      },
      {
        key: 'face_count',
        label: 'Face Count',
        type: 'integer',
        required: false,
        default: 500000,
        min: 40000,
        max: 1500000,
      },
      {
        key: 'enable_pbr',
        label: 'PBR Materials',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'polygon_type',
        label: 'Polygon Type',
        type: 'enum',
        required: false,
        default: 'triangle',
        options: [
          { label: 'Triangle', value: 'triangle' },
          { label: 'Quadrilateral', value: 'quadrilateral' },
        ],
      },
    ],
  },

  'hunyuan3d-image-to-3d': {
    id: 'hunyuan3d-image-to-3d',
    displayName: 'Hunyuan3D V3 Image-to-3D',
    category: '3d-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/hunyuan3d-v3/image-to-3d',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'front_image', label: 'Front Image', dataType: 'Image', required: true },
      { id: 'back_image', label: 'Back Image', dataType: 'Image', required: false },
      { id: 'left_image', label: 'Left Image', dataType: 'Image', required: false },
      { id: 'right_image', label: 'Right Image', dataType: 'Image', required: false },
    ],
    outputPorts: [
      { id: 'mesh', label: 'Mesh', dataType: 'Mesh', required: false },
    ],
    params: [
      {
        key: 'generate_type',
        label: 'Quality',
        type: 'enum',
        required: false,
        default: 'Normal',
        options: [
          { label: 'Normal', value: 'Normal' },
          { label: 'Low Poly', value: 'LowPoly' },
          { label: 'Geometry Only', value: 'Geometry' },
        ],
      },
      {
        key: 'face_count',
        label: 'Face Count',
        type: 'integer',
        required: false,
        default: 500000,
        min: 40000,
        max: 1500000,
      },
      {
        key: 'enable_pbr',
        label: 'PBR Materials',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'polygon_type',
        label: 'Polygon Type',
        type: 'enum',
        required: false,
        default: 'triangle',
        options: [
          { label: 'Triangle', value: 'triangle' },
          { label: 'Quadrilateral', value: 'quadrilateral' },
        ],
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
