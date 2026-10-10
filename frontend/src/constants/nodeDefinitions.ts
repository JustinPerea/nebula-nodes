import type { ModelNodeDefinition } from '../types';

export const NODE_DEFINITIONS: Record<string, ModelNodeDefinition> = {
  'paper-source': {
    id: 'paper-source',
    displayName: 'Paper Source',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [],
    outputPorts: [{ id: 'image', label: 'Image', dataType: 'Image', required: false }],
    params: [],
  },
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
        key: 'output_format',
        label: 'Format',
        type: 'enum',
        required: false,
        default: 'png',
        options: [
          { label: 'PNG', value: 'png' },
          { label: 'JPEG', value: 'jpeg' },
          { label: 'WebP', value: 'webp' },
        ],
      },
      {
        key: 'background',
        label: 'Background',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: 'Transparent', value: 'transparent' },
          { label: 'Opaque', value: 'opaque' },
        ],
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
          { label: 'Claude Fable 5 (flagship)', value: 'claude-fable-5' },
          { label: 'Claude Opus 4.8', value: 'claude-opus-4-8' },
          { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
          { label: 'Claude Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
          { label: 'Claude Opus 4.7 (legacy)', value: 'claude-opus-4-7' },
          { label: 'Claude Opus 4.6 (legacy)', value: 'claude-opus-4-6' },
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
      {
        key: 'system',
        label: 'System Prompt',
        type: 'textarea',
        required: false,
        default: '',
        placeholder: 'System instructions...',
      },
      {
        key: 'top_p',
        label: 'Top P',
        type: 'float',
        required: false,
        min: 0,
        max: 1,
        step: 0.05,
        placeholder: 'Default',
      },
      {
        key: 'stop_sequences',
        label: 'Stop Sequences',
        type: 'string',
        required: false,
        placeholder: 'Comma-separated',
      },
      {
        key: 'extended_thinking',
        label: 'Extended Thinking',
        type: 'boolean',
        required: false,
        default: false,
        // Fable/Mythos 5 use always-on adaptive thinking — no extended-thinking param.
        visibleWhen: { model: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-7', 'claude-opus-4-6'] },
      },
      {
        key: 'thinkingBudget',
        label: 'Thinking Budget',
        type: 'integer',
        required: false,
        default: 10000,
        placeholder: 'Default (min 1024)',
        min: 1024,
        max: 200000,
        condition: 'extended_thinking',
        visibleWhen: { model: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-7', 'claude-opus-4-6'] },
      },
      {
        key: 'prompt_caching',
        label: 'Prompt Caching',
        type: 'boolean',
        required: false,
        default: false,
      },
    ],
  },

  'runway-video': {
    id: 'runway-video',
    displayName: 'Runway Video',
    category: 'video-gen',
    apiProvider: 'runway',
    apiEndpoint: '/v1/image_to_video',
    envKeyName: 'RUNWAY_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: false },
      { id: 'image', label: 'Image', dataType: 'Image', required: false, role: 'style' },
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
        default: 'gen4.5',
        options: [
          { label: 'Gen-4.5', value: 'gen4.5' },
          { label: 'Seedance 2.0', value: 'seedance2' },
          { label: 'Seedance 2.0 Fast', value: 'seedance2_fast' },
          { label: 'HappyHorse 1.0', value: 'happyhorse_1_0' },
          { label: 'Gen-4 Turbo', value: 'gen4_turbo' },
          { label: 'Gen-3a Turbo (legacy)', value: 'gen3a_turbo' },
          { label: 'Veo 3.1', value: 'veo3.1' },
          { label: 'Veo 3.1 Fast', value: 'veo3.1_fast' },
          { label: 'Veo 3', value: 'veo3' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration',
        type: 'integer',
        required: false,
        default: 5,
        min: 2,
        max: 10,
      },
      {
        key: 'ratio',
        label: 'Ratio',
        type: 'enum',
        required: false,
        default: '1280:720',
        options: [
          { label: '1280x720 (16:9)', value: '1280:720' },
          { label: '720x1280 (9:16)', value: '720:1280' },
          { label: '1104x832 (4:3)', value: '1104:832' },
          { label: '832x1104 (3:4)', value: '832:1104' },
          { label: '960x960 (1:1)', value: '960:960' },
          { label: '1584x672 (21:9)', value: '1584:672' },
        ],
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        placeholder: 'Random',
        min: 0,
        max: 4294967295,
      },
    ],
  },

  'runway-aleph': {
    id: 'runway-aleph',
    displayName: 'Runway Aleph',
    category: 'video-gen',
    apiProvider: 'runway',
    apiEndpoint: '/v1/video_to_video',
    envKeyName: 'RUNWAY_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: true },
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'reference', label: 'Reference Image', dataType: 'Image', required: false },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'gen4_aleph',
        options: [
          { label: 'Aleph 2.0', value: 'aleph2' },
          { label: 'Gen-4 Aleph', value: 'gen4_aleph' },
        ],
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        placeholder: 'Random',
        min: 0,
        max: 4294967295,
      },
    ],
  },

  'runway-image': {
    id: 'runway-image',
    displayName: 'Runway Image',
    category: 'image-gen',
    apiProvider: 'runway',
    apiEndpoint: '/v1/text_to_image',
    envKeyName: 'RUNWAY_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'images', label: 'Reference Images', dataType: 'Image', required: false, multiple: true, role: 'subject' },
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
        default: 'gen4_image',
        options: [
          { label: 'Gen-4 Image', value: 'gen4_image' },
          { label: 'Gen-4 Image Turbo', value: 'gen4_image_turbo' },
          { label: 'Nano Banana Pro (Gemini 3)', value: 'gemini_image3_pro' },
          { label: 'GPT Image 2', value: 'gpt_image_2' },
          { label: 'Gemini 2.5 Flash', value: 'gemini_2.5_flash' },
        ],
      },
      {
        key: 'ratio',
        label: 'Ratio',
        type: 'enum',
        required: false,
        default: '1360:768',
        options: [
          { label: '1360x768 (16:9)', value: '1360:768' },
          { label: '720x1280 (9:16)', value: '720:1280' },
          { label: '1024x1024 (1:1)', value: '1024:1024' },
          { label: '1080x1080', value: '1080:1080' },
          { label: '1168x880', value: '1168:880' },
          { label: '1440x1080', value: '1440:1080' },
          { label: '1080x1440', value: '1080:1440' },
          { label: '1920x1080', value: '1920:1080' },
          { label: '1080x1920', value: '1080:1920' },
          { label: '1808x768', value: '1808:768' },
          { label: '2112x912', value: '2112:912' },
        ],
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        placeholder: 'Random',
        min: 0,
        max: 4294967295,
      },
    ],
  },

  'runway-upscale': {
    id: 'runway-upscale',
    displayName: 'Runway Upscale',
    category: 'transform',
    apiProvider: 'runway',
    apiEndpoint: '/v1/image_upscale',
    envKeyName: 'RUNWAY_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'scaleFactor',
        label: 'Scale Factor',
        type: 'enum',
        required: false,
        default: 2,
        options: [
          { label: '2x', value: 2 },
          { label: '4x', value: 4 },
          { label: '8x', value: 8 },
          { label: '16x', value: 16 },
        ],
      },
      {
        key: 'flavor',
        label: 'Flavor',
        type: 'enum',
        required: false,
        default: 'photo',
        options: [
          { label: 'Photo', value: 'photo' },
          { label: 'Photo Denoiser', value: 'photo_denoiser' },
          { label: 'Sublime (illustration)', value: 'sublime' },
        ],
      },
      {
        key: 'sharpen',
        label: 'Sharpen',
        type: 'integer',
        required: false,
        min: 0,
        max: 100,
        placeholder: '0-100 (default none)',
      },
      {
        key: 'smartGrain',
        label: 'Smart Grain',
        type: 'integer',
        required: false,
        min: 0,
        max: 100,
        placeholder: '0-100 (default none)',
      },
      {
        key: 'ultraDetail',
        label: 'Ultra Detail',
        type: 'integer',
        required: false,
        min: 0,
        max: 100,
        placeholder: '0-100 (default none)',
      },
    ],
  },

  'runway-act-two': {
    id: 'runway-act-two',
    displayName: 'Runway Act-Two',
    category: 'video-gen',
    apiProvider: 'runway',
    apiEndpoint: '/v1/character_performance',
    envKeyName: 'RUNWAY_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'character_image', label: 'Character Image', dataType: 'Image', required: false, role: 'identity' },
      { id: 'character_video', label: 'Character Video', dataType: 'Video', required: false },
      { id: 'reference', label: 'Performance Video', dataType: 'Video', required: true },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'bodyControl',
        label: 'Body Control',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'expressionIntensity',
        label: 'Expression Intensity',
        type: 'integer',
        required: false,
        default: 3,
        min: 1,
        max: 5,
      },
      {
        key: 'ratio',
        label: 'Ratio',
        type: 'enum',
        required: false,
        default: '1280:720',
        options: [
          { label: '1280x720 (16:9)', value: '1280:720' },
          { label: '720x1280 (9:16)', value: '720:1280' },
          { label: '960x960 (1:1)', value: '960:960' },
          { label: '1104x832 (4:3)', value: '1104:832' },
          { label: '832x1104 (3:4)', value: '832:1104' },
          { label: '1584x672 (21:9)', value: '1584:672' },
        ],
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        placeholder: 'Random',
        min: 0,
        max: 4294967295,
      },
    ],
  },

  'runway-tts': {
    id: 'runway-tts',
    displayName: 'Runway TTS',
    category: 'audio-gen',
    apiProvider: 'runway',
    apiEndpoint: '/v1/text_to_speech',
    envKeyName: 'RUNWAY_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'text', label: 'Text', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: false },
    ],
    params: [
      {
        key: 'voiceId',
        label: 'Voice',
        type: 'enum',
        required: false,
        default: 'Maya',
        options: [
          { label: 'Maya', value: 'Maya' },
          { label: 'Arjun', value: 'Arjun' },
          { label: 'Serene', value: 'Serene' },
          { label: 'Bernard', value: 'Bernard' },
          { label: 'Billy', value: 'Billy' },
          { label: 'Mark', value: 'Mark' },
          { label: 'Clint', value: 'Clint' },
          { label: 'Mabel', value: 'Mabel' },
          { label: 'Chad', value: 'Chad' },
          { label: 'Leslie', value: 'Leslie' },
          { label: 'Eleanor', value: 'Eleanor' },
          { label: 'Elias', value: 'Elias' },
          { label: 'Elliot', value: 'Elliot' },
          { label: 'Brodie', value: 'Brodie' },
          { label: 'Sandra', value: 'Sandra' },
          { label: 'Kirk', value: 'Kirk' },
          { label: 'Kylie', value: 'Kylie' },
          { label: 'Lara', value: 'Lara' },
          { label: 'Lisa', value: 'Lisa' },
          { label: 'Maggie', value: 'Maggie' },
          { label: 'Jack', value: 'Jack' },
          { label: 'Katie', value: 'Katie' },
          { label: 'Noah', value: 'Noah' },
          { label: 'James', value: 'James' },
          { label: 'Rina', value: 'Rina' },
          { label: 'Ella', value: 'Ella' },
          { label: 'Frank', value: 'Frank' },
          { label: 'Rachel', value: 'Rachel' },
          { label: 'Tom', value: 'Tom' },
          { label: 'Benjamin', value: 'Benjamin' },
        ],
      },
    ],
  },

  'runway-sts': {
    id: 'runway-sts',
    displayName: 'Runway Speech-to-Speech',
    category: 'audio-gen',
    apiProvider: 'runway',
    apiEndpoint: '/v1/speech_to_speech',
    envKeyName: 'RUNWAY_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: false },
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    outputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: false },
    ],
    params: [
      {
        key: 'voiceId',
        label: 'Voice',
        type: 'enum',
        required: false,
        default: 'Maya',
        options: [
          { label: 'Maya', value: 'Maya' },
          { label: 'Arjun', value: 'Arjun' },
          { label: 'Serene', value: 'Serene' },
          { label: 'Bernard', value: 'Bernard' },
          { label: 'Billy', value: 'Billy' },
          { label: 'Mark', value: 'Mark' },
          { label: 'Clint', value: 'Clint' },
          { label: 'Mabel', value: 'Mabel' },
          { label: 'Chad', value: 'Chad' },
          { label: 'Leslie', value: 'Leslie' },
          { label: 'Eleanor', value: 'Eleanor' },
          { label: 'Maggie', value: 'Maggie' },
          { label: 'Jack', value: 'Jack' },
          { label: 'Noah', value: 'Noah' },
          { label: 'James', value: 'James' },
          { label: 'Ella', value: 'Ella' },
          { label: 'Frank', value: 'Frank' },
          { label: 'Rachel', value: 'Rachel' },
          { label: 'Tom', value: 'Tom' },
        ],
      },
      {
        key: 'removeBackgroundNoise',
        label: 'Remove Background Noise',
        type: 'boolean',
        required: false,
        default: false,
      },
    ],
  },

  'runway-dubbing': {
    id: 'runway-dubbing',
    displayName: 'Runway Voice Dubbing',
    category: 'audio-gen',
    apiProvider: 'runway',
    apiEndpoint: '/v1/voice_dubbing',
    envKeyName: 'RUNWAY_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: true },
    ],
    outputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: false },
    ],
    params: [
      {
        key: 'targetLang',
        label: 'Target Language',
        type: 'enum',
        required: true,
        default: 'es',
        options: [
          { label: 'English', value: 'en' },
          { label: 'Spanish', value: 'es' },
          { label: 'French', value: 'fr' },
          { label: 'German', value: 'de' },
          { label: 'Italian', value: 'it' },
          { label: 'Portuguese', value: 'pt' },
          { label: 'Japanese', value: 'ja' },
          { label: 'Korean', value: 'ko' },
          { label: 'Chinese', value: 'zh' },
          { label: 'Arabic', value: 'ar' },
          { label: 'Russian', value: 'ru' },
          { label: 'Hindi', value: 'hi' },
          { label: 'Dutch', value: 'nl' },
          { label: 'Turkish', value: 'tr' },
          { label: 'Polish', value: 'pl' },
          { label: 'Swedish', value: 'sv' },
          { label: 'Filipino', value: 'fil' },
          { label: 'Indonesian', value: 'id' },
          { label: 'Romanian', value: 'ro' },
          { label: 'Ukrainian', value: 'uk' },
          { label: 'Greek', value: 'el' },
          { label: 'Czech', value: 'cs' },
          { label: 'Danish', value: 'da' },
          { label: 'Finnish', value: 'fi' },
          { label: 'Bulgarian', value: 'bg' },
          { label: 'Croatian', value: 'hr' },
          { label: 'Slovak', value: 'sk' },
          { label: 'Tamil', value: 'ta' },
        ],
      },
      {
        key: 'disableVoiceCloning',
        label: 'Disable Voice Cloning',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'dropBackgroundAudio',
        label: 'Drop Background Audio',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'numSpeakers',
        label: 'Number of Speakers',
        type: 'integer',
        required: false,
        placeholder: 'Auto-detect',
        min: 1,
        max: 10,
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
          { label: 'v3 (Highest Quality)', value: 'eleven_v3' },
          { label: 'Multilingual v2', value: 'eleven_multilingual_v2' },
          { label: 'Turbo v2.5 (Low Latency)', value: 'eleven_turbo_v2_5' },
          { label: 'Flash v2.5 (Fastest)', value: 'eleven_flash_v2_5' },
          { label: 'Turbo v2', value: 'eleven_turbo_v2' },
          { label: 'Flash v2', value: 'eleven_flash_v2' },
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
      {
        key: 'similarity_boost',
        label: 'Similarity Boost',
        type: 'float',
        required: false,
        default: 0.75,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        key: 'style',
        label: 'Style',
        type: 'float',
        required: false,
        default: 0,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        key: 'use_speaker_boost',
        label: 'Speaker Boost',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'speed',
        label: 'Speed',
        type: 'float',
        required: false,
        default: 1.0,
        min: 0.7,
        max: 1.2,
        step: 0.05,
      },
      {
        key: 'output_format',
        label: 'Output Format',
        type: 'enum',
        required: false,
        default: 'mp3_44100_128',
        options: [
          { label: 'MP3 44.1kHz', value: 'mp3_44100_128' },
          { label: 'MP3 22kHz', value: 'mp3_22050_32' },
          { label: 'PCM 16kHz', value: 'pcm_16000' },
          { label: 'PCM 24kHz', value: 'pcm_24000' },
          { label: 'PCM 44.1kHz', value: 'pcm_44100' },
        ],
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

  'openai-stt': {
    id: 'openai-stt',
    displayName: 'OpenAI Whisper STT',
    category: 'audio-gen',
    apiProvider: 'openai',
    apiEndpoint: '/v1/audio/transcriptions',
    envKeyName: 'OPENAI_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: true },
    ],
    outputPorts: [
      { id: 'text', label: 'Text', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'whisper-1',
        options: [
          { label: 'Whisper 1', value: 'whisper-1' },
          { label: 'GPT-4o Transcribe', value: 'gpt-4o-transcribe' },
          { label: 'GPT-4o Mini Transcribe', value: 'gpt-4o-mini-transcribe' },
        ],
      },
      {
        key: 'language',
        label: 'Language',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto-detect', value: 'auto' },
          { label: 'English', value: 'en' },
          { label: 'Spanish', value: 'es' },
          { label: 'French', value: 'fr' },
          { label: 'German', value: 'de' },
          { label: 'Italian', value: 'it' },
          { label: 'Portuguese', value: 'pt' },
          { label: 'Japanese', value: 'ja' },
          { label: 'Korean', value: 'ko' },
          { label: 'Chinese', value: 'zh' },
          { label: 'Arabic', value: 'ar' },
          { label: 'Russian', value: 'ru' },
          { label: 'Hindi', value: 'hi' },
        ],
      },
      {
        key: 'response_format',
        label: 'Output Format',
        type: 'enum',
        required: false,
        default: 'text',
        options: [
          { label: 'Text', value: 'text' },
          { label: 'JSON', value: 'json' },
          { label: 'Verbose JSON', value: 'verbose_json' },
          { label: 'SRT Subtitles', value: 'srt' },
          { label: 'VTT Subtitles', value: 'vtt' },
        ],
      },
      {
        key: 'temperature',
        label: 'Temperature',
        type: 'float',
        required: false,
        default: 0,
        min: 0,
        max: 1,
        step: 0.1,
      },
      {
        key: 'prompt',
        label: 'Prompt',
        type: 'string',
        required: false,
        placeholder: 'Guide the model (optional)',
      },
    ],
  },

  'openai-translate': {
    id: 'openai-translate',
    displayName: 'OpenAI Audio Translate',
    category: 'audio-gen',
    apiProvider: 'openai',
    apiEndpoint: '/v1/audio/translations',
    envKeyName: 'OPENAI_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: true },
    ],
    outputPorts: [
      { id: 'text', label: 'English Text', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'response_format',
        label: 'Output Format',
        type: 'enum',
        required: false,
        default: 'text',
        options: [
          { label: 'Text', value: 'text' },
          { label: 'JSON', value: 'json' },
          { label: 'Verbose JSON', value: 'verbose_json' },
          { label: 'SRT Subtitles', value: 'srt' },
          { label: 'VTT Subtitles', value: 'vtt' },
        ],
      },
      {
        key: 'temperature',
        label: 'Temperature',
        type: 'float',
        required: false,
        default: 0,
        min: 0,
        max: 1,
        step: 0.1,
      },
      {
        key: 'prompt',
        label: 'Prompt',
        type: 'string',
        required: false,
        placeholder: 'Guide the model (must be in English)',
      },
    ],
  },

  'openai-tts': {
    id: 'openai-tts',
    displayName: 'OpenAI TTS',
    category: 'audio-gen',
    apiProvider: 'openai',
    apiEndpoint: '/v1/audio/speech',
    envKeyName: 'OPENAI_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'text', label: 'Text', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'tts-1',
        options: [
          { label: 'TTS-1', value: 'tts-1' },
          { label: 'TTS-1 HD', value: 'tts-1-hd' },
          { label: 'GPT-4o Mini TTS', value: 'gpt-4o-mini-tts' },
        ],
      },
      {
        key: 'voice',
        label: 'Voice',
        type: 'enum',
        required: false,
        default: 'alloy',
        options: [
          { label: 'Alloy', value: 'alloy' },
          { label: 'Ash', value: 'ash' },
          { label: 'Ballad', value: 'ballad' },
          { label: 'Cedar', value: 'cedar' },
          { label: 'Coral', value: 'coral' },
          { label: 'Echo', value: 'echo' },
          { label: 'Fable', value: 'fable' },
          { label: 'Marin', value: 'marin' },
          { label: 'Nova', value: 'nova' },
          { label: 'Onyx', value: 'onyx' },
          { label: 'Sage', value: 'sage' },
          { label: 'Shimmer', value: 'shimmer' },
          { label: 'Verse', value: 'verse' },
        ],
      },
      {
        key: 'speed',
        label: 'Speed',
        type: 'float',
        required: false,
        default: 1.0,
        min: 0.25,
        max: 4.0,
        step: 0.25,
      },
      {
        key: 'response_format',
        label: 'Format',
        type: 'enum',
        required: false,
        default: 'mp3',
        options: [
          { label: 'MP3', value: 'mp3' },
          { label: 'WAV', value: 'wav' },
          { label: 'FLAC', value: 'flac' },
          { label: 'Opus', value: 'opus' },
          { label: 'AAC', value: 'aac' },
          { label: 'PCM', value: 'pcm' },
        ],
      },
      {
        key: 'instructions',
        label: 'Voice Instructions',
        type: 'string',
        required: false,
        placeholder: 'e.g. "Speak slowly with warmth" (gpt-4o-mini-tts only)',
      },
    ],
  },

  'elevenlabs-sfx': {
    id: 'elevenlabs-sfx',
    displayName: 'ElevenLabs Sound Effects',
    category: 'audio-gen',
    apiProvider: 'elevenlabs',
    apiEndpoint: '/v1/sound-generation',
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
        key: 'duration_seconds',
        label: 'Duration (sec)',
        type: 'float',
        required: false,
        placeholder: 'Auto',
        min: 0.5,
        max: 30,
        step: 0.5,
      },
      {
        key: 'prompt_influence',
        label: 'Prompt Influence',
        type: 'float',
        required: false,
        default: 0.3,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        key: 'loop',
        label: 'Seamless Loop',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'output_format',
        label: 'Output Format',
        type: 'enum',
        required: false,
        default: 'mp3_44100_128',
        options: [
          { label: 'MP3 44.1kHz', value: 'mp3_44100_128' },
          { label: 'MP3 22kHz', value: 'mp3_22050_32' },
          { label: 'PCM 44.1kHz', value: 'pcm_44100' },
          { label: 'PCM 24kHz', value: 'pcm_24000' },
        ],
      },
    ],
  },

  'elevenlabs-sts': {
    id: 'elevenlabs-sts',
    displayName: 'ElevenLabs Speech-to-Speech',
    category: 'audio-gen',
    apiProvider: 'elevenlabs',
    apiEndpoint: '/v1/speech-to-speech/{voice_id}',
    envKeyName: 'ELEVENLABS_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: true },
    ],
    outputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: false },
    ],
    params: [
      {
        key: 'voice_id',
        label: 'Voice ID',
        type: 'string',
        required: false,
        default: '21m00Tcm4TlvDq8ikWAM',
        placeholder: 'Rachel (default)',
      },
      {
        key: 'model_id',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'eleven_english_sts_v2',
        options: [
          { label: 'English STS v2', value: 'eleven_english_sts_v2' },
          { label: 'Multilingual STS v2', value: 'eleven_multilingual_sts_v2' },
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
        key: 'similarity_boost',
        label: 'Similarity Boost',
        type: 'float',
        required: false,
        default: 0.75,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        key: 'remove_background_noise',
        label: 'Remove Background Noise',
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
      {
        key: 'output_format',
        label: 'Output Format',
        type: 'enum',
        required: false,
        default: 'mp3_44100_128',
        options: [
          { label: 'MP3 44.1kHz', value: 'mp3_44100_128' },
          { label: 'MP3 22kHz', value: 'mp3_22050_32' },
          { label: 'PCM 44.1kHz', value: 'pcm_44100' },
          { label: 'PCM 24kHz', value: 'pcm_24000' },
        ],
      },
    ],
  },

  'elevenlabs-isolation': {
    id: 'elevenlabs-isolation',
    displayName: 'ElevenLabs Audio Isolation',
    category: 'audio-gen',
    apiProvider: 'elevenlabs',
    apiEndpoint: '/v1/audio-isolation',
    envKeyName: 'ELEVENLABS_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: true },
    ],
    outputPorts: [
      { id: 'audio', label: 'Isolated Audio', dataType: 'Audio', required: false },
    ],
    params: [],
  },

  'elevenlabs-dubbing': {
    id: 'elevenlabs-dubbing',
    displayName: 'ElevenLabs Dubbing',
    category: 'audio-gen',
    apiProvider: 'elevenlabs',
    apiEndpoint: '/v1/dubbing',
    envKeyName: 'ELEVENLABS_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: true },
    ],
    outputPorts: [
      { id: 'audio', label: 'Dubbed Audio', dataType: 'Audio', required: false },
    ],
    params: [
      {
        key: 'target_lang',
        label: 'Target Language',
        type: 'enum',
        required: true,
        default: 'es',
        options: [
          { label: 'English', value: 'en' },
          { label: 'Spanish', value: 'es' },
          { label: 'French', value: 'fr' },
          { label: 'German', value: 'de' },
          { label: 'Italian', value: 'it' },
          { label: 'Portuguese', value: 'pt' },
          { label: 'Japanese', value: 'ja' },
          { label: 'Korean', value: 'ko' },
          { label: 'Chinese', value: 'zh' },
          { label: 'Arabic', value: 'ar' },
          { label: 'Russian', value: 'ru' },
          { label: 'Hindi', value: 'hi' },
          { label: 'Dutch', value: 'nl' },
          { label: 'Turkish', value: 'tr' },
          { label: 'Polish', value: 'pl' },
          { label: 'Swedish', value: 'sv' },
        ],
      },
      {
        key: 'source_lang',
        label: 'Source Language',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto-detect', value: 'auto' },
          { label: 'English', value: 'en' },
          { label: 'Spanish', value: 'es' },
          { label: 'French', value: 'fr' },
          { label: 'German', value: 'de' },
          { label: 'Japanese', value: 'ja' },
          { label: 'Chinese', value: 'zh' },
        ],
      },
      {
        key: 'num_speakers',
        label: 'Number of Speakers',
        type: 'integer',
        required: false,
        placeholder: 'Auto-detect',
        min: 0,
        max: 10,
      },
      {
        key: 'drop_background_audio',
        label: 'Drop Background Audio',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'disable_voice_cloning',
        label: 'Disable Voice Cloning',
        type: 'boolean',
        required: false,
        default: false,
      },
    ],
  },

  'elevenlabs-stt': {
    id: 'elevenlabs-stt',
    displayName: 'ElevenLabs STT',
    category: 'audio-gen',
    apiProvider: 'elevenlabs',
    apiEndpoint: '/v1/speech-to-text',
    envKeyName: 'ELEVENLABS_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: true },
    ],
    outputPorts: [
      { id: 'text', label: 'Text', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'model_id',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'scribe_v1',
        options: [
          { label: 'Scribe v1', value: 'scribe_v1' },
          { label: 'Scribe v2', value: 'scribe_v2' },
        ],
      },
      {
        key: 'language_code',
        label: 'Language',
        type: 'string',
        required: false,
        placeholder: 'Auto-detect (ISO code, e.g. en)',
      },
      {
        key: 'diarize',
        label: 'Diarize (label speakers)',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'num_speakers',
        label: 'Max Speakers',
        type: 'integer',
        required: false,
        placeholder: 'Auto',
        min: 1,
        max: 32,
      },
      {
        key: 'tag_audio_events',
        label: 'Tag Audio Events',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'transcript_format',
        label: 'Output Format',
        type: 'enum',
        required: false,
        default: 'text',
        options: [
          { label: 'Plain Text', value: 'text' },
          { label: 'SRT Subtitles', value: 'srt' },
          { label: 'VTT Subtitles', value: 'vtt' },
        ],
      },
    ],
  },

  'demucs': {
    id: 'demucs',
    displayName: 'Demucs (Stem Separation)',
    category: 'audio-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/demucs',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: true },
    ],
    outputPorts: [
      { id: 'vocals', label: 'Vocals', dataType: 'Audio', required: false },
      { id: 'drums', label: 'Drums', dataType: 'Audio', required: false },
      { id: 'bass', label: 'Bass', dataType: 'Audio', required: false },
      { id: 'other', label: 'Other', dataType: 'Audio', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'htdemucs_ft',
        options: [
          { label: 'HT-Demucs FT (best 4-stem)', value: 'htdemucs_ft' },
          { label: 'HT-Demucs', value: 'htdemucs' },
          { label: 'HDemucs MMI', value: 'hdemucs_mmi' },
          { label: 'MDX', value: 'mdx' },
          { label: 'MDX Extra', value: 'mdx_extra' },
        ],
      },
      {
        key: 'shifts',
        label: 'Quality (Shifts)',
        type: 'integer',
        required: false,
        default: 1,
        min: 1,
        max: 10,
      },
      {
        key: 'overlap',
        label: 'Overlap',
        type: 'float',
        required: false,
        default: 0.25,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        key: 'output_format',
        label: 'Output Format',
        type: 'enum',
        required: false,
        default: 'mp3',
        options: [
          { label: 'MP3', value: 'mp3' },
          { label: 'WAV', value: 'wav' },
        ],
      },
    ],
  },

  'mmaudio-v2': {
    id: 'mmaudio-v2',
    displayName: 'MMAudio V2 (Video Foley)',
    category: 'audio-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/mmaudio-v2',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: true },
      { id: 'prompt', label: 'Audio Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'video', label: 'Video (with audio)', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'negative_prompt',
        label: 'Negative Prompt',
        type: 'string',
        required: false,
        placeholder: 'e.g. music, talking, static',
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'integer',
        required: false,
        default: 8,
        min: 1,
        max: 30,
      },
      {
        key: 'num_steps',
        label: 'Steps',
        type: 'integer',
        required: false,
        default: 25,
        min: 10,
        max: 100,
      },
      {
        key: 'cfg_strength',
        label: 'Guidance (CFG)',
        type: 'float',
        required: false,
        default: 4.5,
        min: 1,
        max: 20,
        step: 0.5,
      },
      {
        key: 'mask_away_clip',
        label: 'Replace existing audio',
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

  'ace-step': {
    id: 'ace-step',
    displayName: 'ACE-Step (Music + Vocals)',
    category: 'audio-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/ace-step',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [],
    outputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: false },
    ],
    params: [
      {
        key: 'tags',
        label: 'Style Tags',
        type: 'string',
        required: true,
        placeholder: 'e.g. lofi hiphop, chill, jazzy piano, 90 BPM',
      },
      {
        key: 'lyrics',
        label: 'Lyrics',
        type: 'textarea',
        required: false,
        default: '[instrumental]',
        placeholder: '[Verse] lyrics, or [instrumental] for no vocals',
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'integer',
        required: false,
        default: 30,
        min: 5,
        max: 60,
      },
      {
        key: 'number_of_steps',
        label: 'Steps',
        type: 'integer',
        required: false,
        default: 27,
        min: 1,
        max: 200,
      },
      {
        key: 'guidance_scale',
        label: 'Guidance Scale',
        type: 'float',
        required: false,
        default: 15,
        min: 1,
        max: 30,
        step: 0.5,
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

  'stable-audio-25': {
    id: 'stable-audio-25',
    displayName: 'Stable Audio 2.5',
    category: 'audio-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/stable-audio-25/text-to-audio',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: false },
    ],
    params: [
      {
        key: 'seconds_total',
        label: 'Duration (seconds)',
        type: 'integer',
        required: false,
        default: 60,
        min: 1,
        max: 190,
      },
      {
        key: 'num_inference_steps',
        label: 'Steps',
        type: 'integer',
        required: false,
        default: 8,
        min: 1,
        max: 50,
      },
      {
        key: 'guidance_scale',
        label: 'Guidance Scale',
        type: 'float',
        required: false,
        default: 7.5,
        min: 0,
        max: 20,
        step: 0.5,
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

  'flux-1-1-ultra': {
    id: 'flux-1-1-ultra',
    displayName: 'FLUX 1.1 Ultra',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/flux-pro/v1.1-ultra',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'image', label: 'Image Guide', dataType: 'Image', required: false },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [],
    sharedParams: [
      {
        key: 'aspect_ratio',
        label: 'Aspect Ratio',
        type: 'enum',
        required: false,
        default: '16:9',
        options: [
          { label: '21:9', value: '21:9' },
          { label: '16:9', value: '16:9' },
          { label: '4:3', value: '4:3' },
          { label: '3:2', value: '3:2' },
          { label: '1:1', value: '1:1' },
          { label: '2:3', value: '2:3' },
          { label: '3:4', value: '3:4' },
          { label: '9:16', value: '9:16' },
          { label: '9:21', value: '9:21' },
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
    falParams: [
      {
        key: 'safety_tolerance',
        label: 'Safety Tolerance',
        type: 'enum',
        required: false,
        default: '2',
        options: [
          { label: '1 (Strict)', value: '1' },
          { label: '2', value: '2' },
          { label: '3', value: '3' },
          { label: '4', value: '4' },
          { label: '5', value: '5' },
          { label: '6 (Permissive)', value: '6' },
        ],
      },
      {
        key: 'enhance_prompt',
        label: 'Enhance Prompt',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'output_format',
        label: 'Format',
        type: 'enum',
        required: false,
        default: 'jpeg',
        options: [
          { label: 'JPEG', value: 'jpeg' },
          { label: 'PNG', value: 'png' },
        ],
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        placeholder: 'Random',
      },
      {
        key: 'image_prompt_strength',
        label: 'Image Influence',
        type: 'float',
        required: false,
        default: 0.1,
        min: 0,
        max: 1,
        step: 0.05,
      },
    ],
  },

  'text-input': {
    id: 'text-input',
    displayName: 'Text Input',
    category: 'utility',
    apiProvider: 'utility',
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
    apiProvider: 'utility',
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

  'document-input': {
    id: 'document-input',
    displayName: 'Document Input',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [],
    outputPorts: [
      { id: 'text', label: 'Text', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'filePath',
        label: 'Document (PDF / text)',
        type: 'file',
        required: true,
        default: '',
      },
    ],
  },

  'style-reference': {
    id: 'style-reference',
    displayName: 'Style Reference',
    category: 'utility',
    apiProvider: 'google',
    apiEndpoint: '/v1beta/models/gemini-2.5-flash:generateContent',
    envKeyName: 'GOOGLE_API_KEY',
    executionPattern: 'sync',
    inputPorts: [],
    outputPorts: [
      { id: 'image', label: 'Reference', dataType: 'Image', required: false },
      { id: 'style_description', label: 'Style', dataType: 'Text', required: false },
    ],
    params: [
      { key: 'filePath', label: 'Reference Image', type: 'file', required: true, default: '' },
      {
        key: 'mode',
        label: 'Description Mode',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto (Gemini)', value: 'auto' },
          { label: 'Manual', value: 'manual' },
          { label: 'Image only', value: 'passthrough' },
        ],
      },
      {
        key: 'manual_description',
        label: 'Description',
        type: 'textarea',
        required: false,
        default: '',
        placeholder: 'e.g. wabi-sabi minimalism, warm tungsten lighting, grainy 35mm film',
        visibleWhen: { mode: ['manual'] },
      },
      {
        key: 'focus',
        label: 'Focus',
        type: 'enum',
        required: false,
        default: 'all',
        visibleWhen: { mode: ['auto'] },
        options: [
          { label: 'All (palette + lighting + medium + mood)', value: 'all' },
          { label: 'Palette only', value: 'palette' },
          { label: 'Lighting only', value: 'lighting' },
          { label: 'Medium / texture only', value: 'medium' },
        ],
      },
      { key: 'strength', label: 'Strength', type: 'float', required: false, default: 0.7, min: 0, max: 1, step: 0.05 },
    ],
  },

  'video-edit': {
    id: 'video-edit',
    displayName: 'Video Edit',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'video_in', label: 'Source Video', dataType: 'Video', required: true },
    ],
    outputPorts: [
      { id: 'video', label: 'Edited Video', dataType: 'Video', required: false },
    ],
    params: [
      // Runtime editor state. These stay hidden from the generic inspector,
      // but must be declared so POST/PUT /api/graph/node can persist edits.
      { key: 'clips', label: 'Clips', type: 'string', required: false, hidden: true },
      { key: 'sourceDuration', label: 'Source Duration', type: 'float', required: false, hidden: true },
      { key: 'sourceFps', label: 'Source FPS', type: 'float', required: false, hidden: true },
      { key: 'sourceIsVfr', label: 'Source Is VFR', type: 'boolean', required: false, hidden: true },
    ],
  },

  'remotion-node': {
    id: 'remotion-node',
    displayName: 'Remotion Composition',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'sources', label: 'Track Sources', dataType: 'Any', required: false },
    ],
    outputPorts: [
      { id: 'video', label: 'Rendered Video', dataType: 'Video', required: false },
    ],
    params: [
      // Structured composition state is edited by the dedicated Remotion UI.
      { key: 'manifest', label: 'Manifest', type: 'string', required: false, hidden: true },
    ],
  },

  'cinema-color': {
    id: 'cinema-color',
    displayName: 'Cinema Color',
    category: 'cinematic',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      { key: 'palette', label: 'Palette', type: 'palette', required: false, default: [] },
      { key: 'strength', label: 'Strength', type: 'float', required: false, default: 0.7, min: 0, max: 1, step: 0.05 },
      {
        key: 'method',
        label: 'Method',
        type: 'enum',
        required: false,
        default: 'lab-transfer',
        options: [
          { label: 'Lab Transfer', value: 'lab-transfer' },
          { label: 'Reinhard', value: 'reinhard' },
          { label: 'Histogram', value: 'histogram' },
        ],
      },
      { key: 'source_image', label: 'Palette Source', type: 'file', required: false, default: '' },
    ],
  },

  'cinema-look': {
    id: 'cinema-look',
    displayName: 'Cinema Look',
    category: 'cinematic',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'preset',
        label: 'Preset',
        type: 'enum',
        required: false,
        default: 'custom',
        options: [
          { label: 'Kodak Portra', value: 'kodak-portra' },
          { label: 'Fuji 400H', value: 'fuji-400h' },
          { label: 'CineStill 800T', value: 'cinestill-800t' },
          { label: 'B&W Tri-X', value: 'bw-tri-x' },
          { label: 'Teal & Orange', value: 'teal-orange' },
          { label: 'Custom', value: 'custom' },
        ],
      },
      { key: 'grain', label: 'Grain', type: 'float', required: false, default: 0.2, min: 0, max: 1, step: 0.05, visibleWhen: { preset: ['custom'] } },
      { key: 'halation', label: 'Halation', type: 'float', required: false, default: 0.2, min: 0, max: 1, step: 0.05, visibleWhen: { preset: ['custom'] } },
      { key: 'vignette', label: 'Vignette', type: 'float', required: false, default: 0.25, min: 0, max: 1, step: 0.05, visibleWhen: { preset: ['custom'] } },
      { key: 'contrast', label: 'Contrast', type: 'float', required: false, default: 0, min: -1, max: 1, step: 0.05, visibleWhen: { preset: ['custom'] } },
      { key: 'saturation', label: 'Saturation', type: 'float', required: false, default: 0, min: -1, max: 1, step: 0.05, visibleWhen: { preset: ['custom'] } },
      { key: 'temperature', label: 'Temperature', type: 'float', required: false, default: 0, min: -1, max: 1, step: 0.05, visibleWhen: { preset: ['custom'] } },
      { key: 'lut', label: 'LUT (.cube)', type: 'file', required: false, default: '' },
    ],
  },

  'cinema-scene': {
    id: 'cinema-scene',
    displayName: 'Cinema Scene',
    category: 'cinematic',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'async-poll',
    capabilityNote: 'Camera Rig adds prompt guidance. Reference Set sends ordered images with role guidance. Neither provides a native camera or reference-strength control.',
    inputPorts: [
      { id: 'character_refs', label: 'Character Refs', dataType: 'Image', required: false, multiple: true, role: 'identity' },
      { id: 'character', label: 'Character', dataType: 'Character', required: false },
      { id: 'camera_rig', label: 'Camera Rig', dataType: 'CameraRig', required: false },
      { id: 'reference_set', label: 'Reference Set', dataType: 'ReferenceSet', required: false },
    ],
    // Output ports are dynamic — one Image port per shot, written at runtime from
    // the editor-managed scene spec. Starts empty (mirrors remotion-node).
    outputPorts: [],
    // The `scene` spec (a complex object: base model, aspect ratio, shots) is
    // authored via the Cinema Studio, not a generic param control. It's declared
    // here so the backend validator (_valid_param_keys) accepts it as a known key
    // — agents and the Studio both persist it via PUT/POST /api/graph/node — and
    // marked `hidden` so the Inspector never renders it as a broken editable
    // field. The handler (cinema_scene.py) reads params.get("scene") unchanged.
    params: [
      { key: 'scene', label: 'Scene', type: 'string', required: false, hidden: true },
    ],
  },

  'character': {
    id: 'character',
    displayName: 'Character',
    category: 'character',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    // No inputs — the identity asset is loaded from the project Character store
    // by id (params._characterId, a `_`-prefixed runtime ref, not a declared
    // model param), not wired in on a port.
    inputPorts: [],
    outputPorts: [
      { id: 'character', label: 'Character', dataType: 'Character', required: false },
    ],
    params: [
      {
        key: 'override_prompt',
        label: 'Override Prompt',
        type: 'textarea',
        required: false,
        default: '',
        placeholder: 'Optional per-shot direction: pose, expression, wardrobe, framing',
      },
      // Optional extra Image refs layered on top of the stored referenceViews.
      { key: 'override_refs', label: 'Override Refs', type: 'file', required: false, default: '' },
      // Empty string = inherit the Character's stored consistencyStrength.
      { key: 'strength_override', label: 'Strength Override', type: 'float', required: false, default: '', min: 0, max: 1, step: 0.05,
        disabledReason: 'Unavailable: current Character consumers use reference images and traits without a consistency-strength control. Your stored value is retained.' },
    ],
  },

  'nebula-moodboard': {
    id: 'nebula-moodboard',
    displayName: 'Moodboard',
    category: 'moodboard',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [],
    outputPorts: [
      { id: 'moodboard', label: 'Moodboard', dataType: 'Moodboard', required: false },
      { id: 'style_brief', label: 'Style Brief', dataType: 'Text', required: false },
      { id: 'negative_prompt', label: 'Negative Prompt', dataType: 'Text', required: false },
      { id: 'representative_images', label: 'Images', dataType: 'Array', required: false },
      { id: 'palette', label: 'Palette', dataType: 'Array', required: false },
    ],
    params: [
      { key: 'moodboard', label: 'Moodboard', type: 'string', required: false, hidden: true },
    ],
  },

  'preview': {
    id: 'preview',
    displayName: 'Preview',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      { id: 'input', label: 'Input', dataType: 'Any', required: true },
    ],
    outputPorts: [],
    params: [],
  },

  'camera-rig': {
    id: 'camera-rig',
    displayName: 'Camera Rig',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    // No inputs — every value is a numeric slider param, packed into the
    // CameraRigBundle emitted on the camera_rig output port.
    inputPorts: [],
    outputPorts: [
      { id: 'camera_rig', label: 'Camera Rig', dataType: 'CameraRig', required: false },
    ],
    params: [
      { key: 'height', label: 'Height (m)', type: 'float', required: false, default: 1.7, min: 0.1, max: 10, step: 0.1 },
      { key: 'pitch', label: 'Pitch (°)', type: 'float', required: false, default: 0, min: -90, max: 90, step: 1 },
      { key: 'yaw', label: 'Yaw (°)', type: 'float', required: false, default: 0, min: 0, max: 360, step: 1 },
      { key: 'roll', label: 'Roll (°)', type: 'float', required: false, default: 0, min: -45, max: 45, step: 1 },
      { key: 'focalLength', label: 'Focal Length (mm)', type: 'float', required: false, default: 35, min: 10, max: 200, step: 1 },
      { key: 'subjectDistance', label: 'Subject Distance (m)', type: 'float', required: false, default: 3, min: 0.5, max: 50, step: 0.1 },
      { key: 'focusDistance', label: 'Focus Distance (m)', type: 'float', required: false, default: 3, min: 0.5, max: 100, step: 0.1 },
      { key: 'subjectScreenX', label: 'Subject Screen X', type: 'float', required: false, default: 0.5, min: 0, max: 1, step: 0.01 },
      { key: 'subjectScreenY', label: 'Subject Screen Y', type: 'float', required: false, default: 0.5, min: 0, max: 1, step: 0.01 },
    ],
  },

  'camera-pose': {
    id: 'camera-pose',
    displayName: 'Camera Pose',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    capabilityNote: 'Authors a provider-neutral, versioned camera transform locally. No provider request is made.',
    inputPorts: [],
    outputPorts: [
      { id: 'pose', label: 'Camera Pose', dataType: 'CameraPose', required: false },
    ],
    params: [
      { key: 'pose_id', label: 'Pose ID', type: 'string', required: false, default: '', placeholder: 'Defaults to node ID' },
      { key: 'coordinate_system_id', label: 'Coordinate System ID', type: 'string', required: false, default: 'nebula-world' },
      { key: 'handedness', label: 'Handedness', type: 'enum', required: false, default: 'right', options: [
        { label: 'Right-handed', value: 'right' }, { label: 'Left-handed', value: 'left' },
      ] },
      { key: 'up_axis', label: 'Up Axis', type: 'enum', required: false, default: 'y', options: [
        { label: '+X', value: 'x' }, { label: '-X', value: '-x' }, { label: '+Y', value: 'y' },
        { label: '-Y', value: '-y' }, { label: '+Z', value: 'z' }, { label: '-Z', value: '-z' },
      ] },
      { key: 'forward_axis', label: 'Forward Axis', type: 'enum', required: false, default: '-z', options: [
        { label: '+X', value: 'x' }, { label: '-X', value: '-x' }, { label: '+Y', value: 'y' },
        { label: '-Y', value: '-y' }, { label: '+Z', value: 'z' }, { label: '-Z', value: '-z' },
      ] },
      { key: 'unit', label: 'Spatial Unit', type: 'enum', required: false, default: 'meters', options: [
        { label: 'Meters', value: 'meters' }, { label: 'Centimeters', value: 'centimeters' },
        { label: 'Millimeters', value: 'millimeters' }, { label: 'Custom', value: 'custom' },
      ] },
      { key: 'meters_per_unit', label: 'Meters per Custom Unit', type: 'float', required: false, default: 1, min: 0.000001, step: 0.001, visibleWhen: { unit: ['custom'] } },
      { key: 'origin_x', label: 'Origin X (m)', type: 'float', required: false, default: 0, step: 0.01 },
      { key: 'origin_y', label: 'Origin Y (m)', type: 'float', required: false, default: 0, step: 0.01 },
      { key: 'origin_z', label: 'Origin Z (m)', type: 'float', required: false, default: 0, step: 0.01 },
      { key: 'position_x', label: 'Position X', type: 'float', required: false, default: 0, step: 0.01 },
      { key: 'position_y', label: 'Position Y', type: 'float', required: false, default: 1.7, step: 0.01 },
      { key: 'position_z', label: 'Position Z', type: 'float', required: false, default: 0, step: 0.01 },
      { key: 'orientation_x', label: 'Quaternion X', type: 'float', required: false, default: 0, min: -1, max: 1, step: 0.01 },
      { key: 'orientation_y', label: 'Quaternion Y', type: 'float', required: false, default: 0, min: -1, max: 1, step: 0.01 },
      { key: 'orientation_z', label: 'Quaternion Z', type: 'float', required: false, default: 0, min: -1, max: 1, step: 0.01 },
      { key: 'orientation_w', label: 'Quaternion W', type: 'float', required: false, default: 1, min: -1, max: 1, step: 0.01 },
      { key: 'timestamp_seconds', label: 'Timestamp (s)', type: 'float', required: false, default: 0, min: 0, step: 0.01 },
      { key: 'include_intrinsics', label: 'Include Pinhole Intrinsics', type: 'boolean', required: false, default: true },
      { key: 'image_width', label: 'Image Width', type: 'integer', required: false, default: 1920, min: 1, max: 32768, visibleWhen: { include_intrinsics: [true] } },
      { key: 'image_height', label: 'Image Height', type: 'integer', required: false, default: 1080, min: 1, max: 32768, visibleWhen: { include_intrinsics: [true] } },
      { key: 'fx', label: 'Focal X', type: 'float', required: false, default: 1000, min: 0.000001, max: 10000000, step: 0.1, visibleWhen: { include_intrinsics: [true] } },
      { key: 'fy', label: 'Focal Y', type: 'float', required: false, default: 1000, min: 0.000001, max: 10000000, step: 0.1, visibleWhen: { include_intrinsics: [true] } },
      { key: 'cx', label: 'Principal X', type: 'float', required: false, default: 960, min: 0, max: 32768, step: 0.1, visibleWhen: { include_intrinsics: [true] } },
      { key: 'cy', label: 'Principal Y', type: 'float', required: false, default: 540, min: 0, max: 32768, step: 0.1, visibleWhen: { include_intrinsics: [true] } },
      { key: 'skew', label: 'Skew', type: 'float', required: false, default: 0, min: -10000000, max: 10000000, step: 0.01, visibleWhen: { include_intrinsics: [true] } },
    ],
  },

  'camera-path': {
    id: 'camera-path',
    displayName: 'Camera Path',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    capabilityNote: 'Combines timestamped Camera Pose values locally; timestamps and coordinate systems are validated.',
    inputPorts: [
      { id: 'poses', label: 'Camera Poses', dataType: 'CameraPose', required: true, multiple: true, maxConnections: 10000 },
    ],
    outputPorts: [
      { id: 'path', label: 'Camera Path', dataType: 'CameraPath', required: false },
    ],
    params: [
      { key: 'path_id', label: 'Path ID', type: 'string', required: false, default: '', placeholder: 'Defaults to node ID' },
      { key: 'interpolation', label: 'Interpolation', type: 'enum', required: false, default: 'linear', options: [
        { label: 'Linear', value: 'linear' }, { label: 'Step', value: 'step' }, { label: 'Catmull-Rom', value: 'catmull-rom' },
      ] },
      { key: 'closed', label: 'Closed Path', type: 'boolean', required: false, default: false },
    ],
  },

  'spatial-context': {
    id: 'spatial-context',
    displayName: 'Spatial Context',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    capabilityNote: 'Pairs local image outputs with Camera Pose anchors. Remote or signed asset URLs are rejected.',
    inputPorts: [
      { id: 'poses', label: 'Camera Poses', dataType: 'CameraPose', required: true, multiple: true, maxConnections: 4096 },
      { id: 'assets', label: 'Local Images', dataType: 'Image', required: true, multiple: true, maxConnections: 4096 },
    ],
    outputPorts: [
      { id: 'context', label: 'Spatial Context', dataType: 'SpatialContext', required: false },
    ],
    params: [
      { key: 'context_id', label: 'Context ID', type: 'string', required: false, default: '', placeholder: 'Defaults to node ID' },
      { key: 'role', label: 'Anchor Role', type: 'enum', required: false, default: 'reference', options: [
        { label: 'Reference', value: 'reference' }, { label: 'Observation', value: 'observation' }, { label: 'Target', value: 'target' },
      ] },
    ],
  },

  'sensor-rig': {
    id: 'sensor-rig',
    displayName: 'Sensor Rig',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    capabilityNote: 'Builds a local sensor-rig description from Camera Pose inputs; optical and non-optical intrinsics rules are enforced.',
    inputPorts: [
      { id: 'poses', label: 'Sensor Poses', dataType: 'CameraPose', required: true, multiple: true, maxConnections: 256 },
    ],
    outputPorts: [
      { id: 'rig', label: 'Sensor Rig', dataType: 'SensorRig', required: false },
    ],
    params: [
      { key: 'rig_id', label: 'Rig ID', type: 'string', required: false, default: '', placeholder: 'Defaults to node ID' },
      { key: 'modality', label: 'Sensor Modality', type: 'enum', required: false, default: 'rgb', options: [
        { label: 'RGB', value: 'rgb' }, { label: 'Depth', value: 'depth' }, { label: 'RGB + Depth', value: 'rgbd' },
        { label: 'LiDAR', value: 'lidar' }, { label: 'IMU', value: 'imu' },
      ] },
    ],
  },

  'spatial-value-validate': {
    id: 'spatial-value-validate',
    displayName: 'Spatial Value Validate',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    capabilityNote: 'Strictly validates a versioned spatial value locally. Legacy World v1 values are adapted to World v2 in memory only.',
    inputPorts: [
      { id: 'input', label: 'Spatial Value', dataType: 'Any', required: true },
    ],
    outputPorts: [
      { id: 'value', label: 'Validated Value', dataType: 'Any', required: false },
      { id: 'summary', label: 'Validation Summary', dataType: 'Text', required: false },
    ],
    params: [
      { key: 'expected_type', label: 'Expected Type', type: 'enum', required: true, default: 'CameraPose', options: [
        { label: 'Camera Pose', value: 'CameraPose' }, { label: 'Camera Path', value: 'CameraPath' },
        { label: 'Spatial Context', value: 'SpatialContext' }, { label: 'Depth Map', value: 'DepthMap' },
        { label: 'Depth Sequence', value: 'DepthSequence' }, { label: 'Point Cloud', value: 'PointCloud' },
        { label: 'Sensor Rig', value: 'SensorRig' }, { label: 'Sensor Stream', value: 'SensorStream' },
        { label: 'Spatial Session', value: 'SpatialSession' }, { label: 'World', value: 'World' },
      ] },
    ],
  },

  'reference-set': {
    id: 'reference-set',
    displayName: 'Reference Set',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    // Seven role-labeled Image inputs (one per semantic reference role). The
    // handler packs connected images into a ReferenceSetBundle tagged with
    // each port's role and priority, sorted by priority descending; zero excludes.
    inputPorts: [
      { id: 'style', label: 'Style', dataType: 'Image', required: false },
      { id: 'identity', label: 'Identity', dataType: 'Image', required: false },
      { id: 'composition', label: 'Composition', dataType: 'Image', required: false },
      { id: 'pose', label: 'Pose', dataType: 'Image', required: false },
      { id: 'lighting', label: 'Lighting', dataType: 'Image', required: false },
      { id: 'subject', label: 'Subject', dataType: 'Image', required: false },
      { id: 'background', label: 'Background', dataType: 'Image', required: false },
    ],
    outputPorts: [
      { id: 'reference_set', label: 'Reference Set', dataType: 'ReferenceSet', required: false },
    ],
    params: [
      { key: 'style_weight', label: 'Style Priority', type: 'float', required: false, default: 1.0, min: 0.0, max: 1.0, step: 0.05 },
      { key: 'identity_weight', label: 'Identity Priority', type: 'float', required: false, default: 1.0, min: 0.0, max: 1.0, step: 0.05 },
      { key: 'composition_weight', label: 'Composition Priority', type: 'float', required: false, default: 1.0, min: 0.0, max: 1.0, step: 0.05 },
      { key: 'pose_weight', label: 'Pose Priority', type: 'float', required: false, default: 1.0, min: 0.0, max: 1.0, step: 0.05 },
      { key: 'lighting_weight', label: 'Lighting Priority', type: 'float', required: false, default: 1.0, min: 0.0, max: 1.0, step: 0.05 },
      { key: 'subject_weight', label: 'Subject Priority', type: 'float', required: false, default: 1.0, min: 0.0, max: 1.0, step: 0.05 },
      { key: 'background_weight', label: 'Background Priority', type: 'float', required: false, default: 1.0, min: 0.0, max: 1.0, step: 0.05 },
    ],
  },

  'combine-text': {
    id: 'combine-text',
    displayName: 'Combine Text',
    category: 'utility',
    apiProvider: 'utility',
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
    apiProvider: 'utility',
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
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      { id: 'input', label: 'Input', dataType: 'Any', required: true },
    ],
    outputPorts: [
      { id: 'output', label: 'Output', dataType: 'Any', required: false },
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
      {
        key: 'response_format',
        label: 'Response Format',
        type: 'enum',
        required: false,
        default: 'text',
        options: [
          { label: 'Text', value: 'text' },
          { label: 'JSON', value: 'json_object' },
        ],
      },
      {
        key: 'prompt_caching',
        label: 'Prompt Caching',
        type: 'boolean',
        required: false,
        default: false,
      },
    ],
  },

  'nous-portal-universal': {
    id: 'nous-portal-universal',
    displayName: 'Nous Portal',
    category: 'universal',
    apiProvider: 'nous',
    apiEndpoint: 'https://inference-api.nousresearch.com/v1/chat/completions',
    // No env-key field — auth is OAuth, stored in ~/.hermes/auth.json after
    // `hermes auth`. The backend reads it; the frontend doesn't need a key.
    envKeyName: [],
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
        type: 'string',
        required: true,
        default: '',
        placeholder: 'Loading models…',
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
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: false },
      { id: 'mesh', label: 'Mesh', dataType: 'Mesh', required: false },
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

  // dalle-3-generate removed 2026-06: OpenAI shut down dall-e-2/dall-e-3 on 2026-05-12.
  // gpt-image-1 / gpt-image-1.5 / gpt-image-2 nodes are the replacements.

  'gpt-4o-chat': {
    id: 'gpt-4o-chat',
    displayName: 'OpenAI Chat',
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
        default: 'gpt-5.4',
        options: [
          { label: 'GPT-5.5 (flagship)', value: 'gpt-5.5' },
          { label: 'GPT-5.4', value: 'gpt-5.4' },
          { label: 'GPT-5.4 Mini', value: 'gpt-5.4-mini' },
          { label: 'GPT-5.4 Nano', value: 'gpt-5.4-nano' },
          { label: 'GPT-4o (legacy)', value: 'gpt-4o' },
          { label: 'GPT-4o Mini (legacy)', value: 'gpt-4o-mini' },
          { label: 'GPT-4.1 (legacy)', value: 'gpt-4.1' },
          { label: 'GPT-4.1 Mini (legacy)', value: 'gpt-4.1-mini' },
          { label: 'GPT-4.1 Nano (legacy, sunsets 2026-10-23)', value: 'gpt-4.1-nano' },
        ],
      },
      {
        key: 'reasoning_effort',
        label: 'Reasoning Effort',
        type: 'enum',
        required: false,
        default: 'medium',
        options: [
          { label: 'None', value: 'none' },
          { label: 'Low', value: 'low' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
          { label: 'X-High', value: 'xhigh' },
        ],
        visibleWhen: { model: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano'] },
      },
      {
        key: 'max_completion_tokens',
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
        visibleWhen: { model: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano'] },
      },
      {
        key: 'top_p',
        label: 'Top P',
        type: 'float',
        required: false,
        min: 0,
        max: 1,
        step: 0.05,
        placeholder: 'Default',
        visibleWhen: { model: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano'] },
      },
      {
        key: 'frequency_penalty',
        label: 'Frequency Penalty',
        type: 'float',
        required: false,
        default: 0,
        min: -2,
        max: 2,
        step: 0.1,
        visibleWhen: { model: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano'] },
      },
      {
        key: 'presence_penalty',
        label: 'Presence Penalty',
        type: 'float',
        required: false,
        default: 0,
        min: -2,
        max: 2,
        step: 0.1,
        visibleWhen: { model: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano'] },
      },
      {
        key: 'response_format',
        label: 'Response Format',
        type: 'enum',
        required: false,
        default: 'text',
        options: [
          { label: 'Text', value: 'text' },
          { label: 'JSON', value: 'json_object' },
        ],
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
        default: 'gemini-3.5-flash',
        options: [
          { label: 'Gemini 3.5 Flash', value: 'gemini-3.5-flash' },
          { label: 'Gemini 3.1 Pro (preview)', value: 'gemini-3.1-pro-preview' },
          { label: 'Gemini 3 Flash (preview)', value: 'gemini-3-flash-preview' },
          { label: 'Gemini 3.1 Flash-Lite', value: 'gemini-3.1-flash-lite' },
          { label: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro' },
          { label: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash' },
          { label: 'Gemini 2.5 Flash-Lite', value: 'gemini-2.5-flash-lite' },
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
        key: 'system',
        label: 'System Prompt',
        type: 'textarea',
        required: false,
        default: '',
        placeholder: 'System instructions...',
      },
      {
        key: 'thinkingLevel',
        label: 'Thinking Level',
        type: 'enum',
        required: false,
        default: '',
        visibleWhen: { model: ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite'] },
        options: [
          { label: 'Default', value: '' },
          { label: 'Minimal', value: 'minimal' },
          { label: 'Low', value: 'low' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
        ],
      },
      {
        key: 'thinkingBudget',
        label: 'Thinking Budget',
        type: 'integer',
        required: false,
        visibleWhen: { model: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'] },
        placeholder: 'Token budget for thinking',
        min: 0,
        max: 65536,
      },
      {
        key: 'top_p',
        label: 'Top P',
        type: 'float',
        required: false,
        min: 0,
        max: 1,
        step: 0.05,
        placeholder: 'Default',
      },
      {
        key: 'top_k',
        label: 'Top K',
        type: 'integer',
        required: false,
        placeholder: '64',
      },
      {
        key: 'stop_sequences',
        label: 'Stop Sequences',
        type: 'string',
        required: false,
        placeholder: 'Comma-separated',
      },
      {
        key: 'response_format',
        label: 'Response Format',
        type: 'enum',
        required: false,
        default: 'text/plain',
        options: [
          { label: 'Text', value: 'text/plain' },
          { label: 'JSON', value: 'application/json' },
        ],
      },
    ],
  },

  'imagen-4-generate': {
    id: 'imagen-4-generate',
    displayName: 'Imagen 4',
    category: 'image-gen',
    apiProvider: 'google',
    apiEndpoint: '/v1beta/models/{model}:predict',
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
        key: 'imageSize',
        label: 'Image Size',
        type: 'enum',
        required: false,
        default: '1K',
        visibleWhen: { model: ['imagen-4.0-generate-001', 'imagen-4.0-ultra-generate-001'] },
        options: [
          { label: '1K', value: '1K' },
          { label: '2K', value: '2K' },
        ],
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
      { id: 'image', label: 'Image', dataType: 'Image', required: true, role: 'subject' },
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: false },
      { id: 'tail_image', label: 'End Frame', dataType: 'Image', required: false },
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
        key: 'negative_prompt',
        label: 'Negative Prompt',
        type: 'string',
        required: false,
        default: 'blur, distort, and low quality',
      },
      {
        key: 'cfg_scale',
        label: 'CFG Scale',
        type: 'float',
        required: false,
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.1,
      },
    ],
  },

  'sora-2': {
    id: 'sora-2',
    displayName: "Sora 2 (sunsets Sep '26)",
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
      { id: 'images', label: 'Images', dataType: 'Image', required: false, multiple: true, role: 'identity' },
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
        default: 'gemini-3.1-flash-image',
        options: [
          { label: 'Nano Banana 2 (3.1 Flash)', value: 'gemini-3.1-flash-image' },
          { label: 'Nano Banana 2 Lite (3.1 Flash-Lite)', value: 'gemini-3.1-flash-lite-image' },
          { label: 'Nano Banana Pro (3 Pro)', value: 'gemini-3-pro-image' },
          { label: 'Nano Banana (2.5 Flash)', value: 'gemini-2.5-flash-image' },
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
          { label: '3:2', value: '3:2' },
          { label: '2:3', value: '2:3' },
          { label: '5:4', value: '5:4' },
          { label: '4:5', value: '4:5' },
          { label: '21:9', value: '21:9' },
          { label: '1:4', value: '1:4', visibleWhen: { model: ['gemini-3.1-flash-image'] } },
          { label: '4:1', value: '4:1', visibleWhen: { model: ['gemini-3.1-flash-image'] } },
          { label: '1:8', value: '1:8', visibleWhen: { model: ['gemini-3.1-flash-image'] } },
          { label: '8:1', value: '8:1', visibleWhen: { model: ['gemini-3.1-flash-image'] } },
        ],
      },
      {
        key: 'imageSize',
        label: 'Image Size',
        type: 'enum',
        required: false,
        default: '1K',
        visibleWhen: { model: ['gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image'] },
        options: [
          { label: '512', value: '512', visibleWhen: { model: ['gemini-3.1-flash-image'] } },
          { label: '1K', value: '1K' },
          { label: '2K', value: '2K', visibleWhen: { model: ['gemini-3.1-flash-image', 'gemini-3-pro-image'] } },
          { label: '4K', value: '4K', visibleWhen: { model: ['gemini-3.1-flash-image', 'gemini-3-pro-image'] } },
        ],
      },
    ],
  },

  'nano-banana-fal': {
    id: 'nano-banana-fal',
    displayName: 'Nano Banana (FAL)',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/nano-banana-2',
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
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'nano-banana-2',
        options: [
          { label: 'Nano Banana 2', value: 'nano-banana-2' },
          { label: 'Nano Banana Pro', value: 'nano-banana-pro' },
          { label: 'Nano Banana (2.5 Flash)', value: 'nano-banana' },
          { label: 'Gemini 2.5 Flash Image', value: 'gemini-25-flash-image' },
          { label: 'Gemini 3 Pro Image', value: 'gemini-3-pro-image' },
        ],
      },
      {
        key: 'aspect_ratio',
        label: 'Aspect Ratio',
        type: 'enum',
        required: false,
        default: '1:1',
        options: [
          { label: 'Auto', value: 'auto', visibleWhen: { model: ['nano-banana-2', 'nano-banana-pro'] } },
          { label: '1:1', value: '1:1' },
          { label: '16:9', value: '16:9' },
          { label: '9:16', value: '9:16' },
          { label: '4:3', value: '4:3' },
          { label: '3:4', value: '3:4' },
          { label: '3:2', value: '3:2' },
          { label: '2:3', value: '2:3' },
          { label: '5:4', value: '5:4' },
          { label: '4:5', value: '4:5' },
          { label: '21:9', value: '21:9' },
          { label: '1:4', value: '1:4', visibleWhen: { model: ['nano-banana-2'] } },
          { label: '4:1', value: '4:1', visibleWhen: { model: ['nano-banana-2'] } },
          { label: '1:8', value: '1:8', visibleWhen: { model: ['nano-banana-2'] } },
          { label: '8:1', value: '8:1', visibleWhen: { model: ['nano-banana-2'] } },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '1K',
        visibleWhen: { model: ['nano-banana-2', 'nano-banana-pro'] },
        options: [
          { label: '0.5K', value: '0.5K', visibleWhen: { model: ['nano-banana-2'] } },
          { label: '1K', value: '1K' },
          { label: '2K', value: '2K' },
          { label: '4K', value: '4K' },
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
        key: 'output_format',
        label: 'Format',
        type: 'enum',
        required: false,
        default: 'png',
        options: [
          { label: 'PNG', value: 'png' },
          { label: 'JPEG', value: 'jpeg' },
          { label: 'WebP', value: 'webp' },
        ],
      },
      {
        key: 'thinking_level',
        label: 'Thinking Level',
        type: 'enum',
        required: false,
        default: '',
        visibleWhen: { model: ['nano-banana-2'] },
        options: [
          { label: 'Off', value: '' },
          { label: 'Minimal', value: 'minimal' },
          { label: 'High', value: 'high' },
        ],
      },
      {
        key: 'enable_web_search',
        label: 'Web Search',
        type: 'boolean',
        required: false,
        default: false,
        visibleWhen: { model: ['nano-banana-2', 'nano-banana-pro'] },
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

  'nano-banana-fal-edit': {
    id: 'nano-banana-fal-edit',
    displayName: 'Nano Banana Edit (FAL)',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/nano-banana-2/edit',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'images', label: 'Reference Images', dataType: 'Image', required: true, multiple: true, role: 'identity' },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'nano-banana-2',
        options: [
          { label: 'Nano Banana 2', value: 'nano-banana-2' },
          { label: 'Nano Banana Pro', value: 'nano-banana-pro' },
          { label: 'Nano Banana (2.5 Flash)', value: 'nano-banana' },
          { label: 'Gemini 2.5 Flash Image', value: 'gemini-25-flash-image' },
          { label: 'Gemini 3 Pro Image', value: 'gemini-3-pro-image' },
        ],
      },
      {
        key: 'aspect_ratio',
        label: 'Aspect Ratio',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto', visibleWhen: { model: ['nano-banana-2', 'nano-banana-pro'] } },
          { label: '1:1', value: '1:1' },
          { label: '16:9', value: '16:9' },
          { label: '9:16', value: '9:16' },
          { label: '4:3', value: '4:3' },
          { label: '3:4', value: '3:4' },
          { label: '3:2', value: '3:2' },
          { label: '2:3', value: '2:3' },
          { label: '5:4', value: '5:4' },
          { label: '4:5', value: '4:5' },
          { label: '21:9', value: '21:9' },
          { label: '1:4', value: '1:4', visibleWhen: { model: ['nano-banana-2'] } },
          { label: '4:1', value: '4:1', visibleWhen: { model: ['nano-banana-2'] } },
          { label: '1:8', value: '1:8', visibleWhen: { model: ['nano-banana-2'] } },
          { label: '8:1', value: '8:1', visibleWhen: { model: ['nano-banana-2'] } },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '1K',
        visibleWhen: { model: ['nano-banana-2', 'nano-banana-pro'] },
        options: [
          { label: '0.5K', value: '0.5K', visibleWhen: { model: ['nano-banana-2'] } },
          { label: '1K', value: '1K' },
          { label: '2K', value: '2K' },
          { label: '4K', value: '4K' },
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
        key: 'output_format',
        label: 'Format',
        type: 'enum',
        required: false,
        default: 'png',
        options: [
          { label: 'PNG', value: 'png' },
          { label: 'JPEG', value: 'jpeg' },
          { label: 'WebP', value: 'webp' },
        ],
      },
      {
        key: 'thinking_level',
        label: 'Thinking Level',
        type: 'enum',
        required: false,
        default: '',
        visibleWhen: { model: ['nano-banana-2'] },
        options: [
          { label: 'Off', value: '' },
          { label: 'Minimal', value: 'minimal' },
          { label: 'High', value: 'high' },
        ],
      },
      {
        key: 'enable_web_search',
        label: 'Web Search',
        type: 'boolean',
        required: false,
        default: false,
        visibleWhen: { model: ['nano-banana-2', 'nano-banana-pro'] },
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

  'lyria-3': {
    id: 'lyria-3',
    displayName: 'Lyria 3',
    category: 'audio-gen',
    apiProvider: 'google',
    apiEndpoint: '/v1beta/models/{model}:generateContent',
    envKeyName: 'GOOGLE_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'images', label: 'Images', dataType: 'Image', required: false, multiple: true },
    ],
    outputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: false },
      { id: 'text', label: 'Lyrics', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: true,
        default: 'lyria-3-clip-preview',
        options: [
          { label: 'Lyria 3 Clip (30s)', value: 'lyria-3-clip-preview' },
          { label: 'Lyria 3 Pro (full song)', value: 'lyria-3-pro-preview' },
        ],
      },
      {
        key: 'outputFormat',
        label: 'Output Format',
        type: 'enum',
        required: false,
        default: 'mp3',
        visibleWhen: { model: ['lyria-3-pro-preview'] },
        options: [
          { label: 'MP3', value: 'mp3' },
          { label: 'WAV', value: 'wav' },
        ],
      },
    ],
  },

  'gemini-tts': {
    id: 'gemini-tts',
    displayName: 'Gemini TTS',
    category: 'audio-gen',
    apiProvider: 'google',
    apiEndpoint: '/v1beta/models/{model}:generateContent',
    envKeyName: 'GOOGLE_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'text', label: 'Text', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'gemini-2.5-flash-preview-tts',
        options: [
          { label: '3.1 Flash TTS (preview)', value: 'gemini-3.1-flash-tts-preview' },
          { label: '2.5 Flash TTS', value: 'gemini-2.5-flash-preview-tts' },
          { label: '2.5 Pro TTS', value: 'gemini-2.5-pro-preview-tts' },
        ],
      },
      {
        key: 'voiceName',
        label: 'Voice',
        type: 'enum',
        required: false,
        default: 'Kore',
        options: [
          { label: 'Zephyr — Bright', value: 'Zephyr' },
          { label: 'Puck — Upbeat', value: 'Puck' },
          { label: 'Charon — Informative', value: 'Charon' },
          { label: 'Kore — Firm', value: 'Kore' },
          { label: 'Fenrir — Excitable', value: 'Fenrir' },
          { label: 'Leda — Youthful', value: 'Leda' },
          { label: 'Orus — Firm', value: 'Orus' },
          { label: 'Aoede — Breezy', value: 'Aoede' },
          { label: 'Callirrhoe — Easy-going', value: 'Callirrhoe' },
          { label: 'Autonoe — Bright', value: 'Autonoe' },
          { label: 'Enceladus — Breathy', value: 'Enceladus' },
          { label: 'Iapetus — Clear', value: 'Iapetus' },
          { label: 'Umbriel — Easy-going', value: 'Umbriel' },
          { label: 'Algieba — Smooth', value: 'Algieba' },
          { label: 'Despina — Smooth', value: 'Despina' },
          { label: 'Erinome — Clear', value: 'Erinome' },
          { label: 'Algenib — Gravelly', value: 'Algenib' },
          { label: 'Rasalgethi — Informative', value: 'Rasalgethi' },
          { label: 'Laomedeia — Upbeat', value: 'Laomedeia' },
          { label: 'Achernar — Soft', value: 'Achernar' },
          { label: 'Alnilam — Firm', value: 'Alnilam' },
          { label: 'Schedar — Even', value: 'Schedar' },
          { label: 'Gacrux — Mature', value: 'Gacrux' },
          { label: 'Pulcherrima — Forward', value: 'Pulcherrima' },
          { label: 'Achird — Friendly', value: 'Achird' },
          { label: 'Zubenelgenubi — Casual', value: 'Zubenelgenubi' },
          { label: 'Vindemiatrix — Gentle', value: 'Vindemiatrix' },
          { label: 'Sadachbia — Lively', value: 'Sadachbia' },
          { label: 'Sadaltager — Knowledgeable', value: 'Sadaltager' },
          { label: 'Sulafat — Warm', value: 'Sulafat' },
        ],
      },
    ],
  },

  'gemini-embeddings': {
    id: 'gemini-embeddings',
    displayName: 'Gemini Embeddings',
    category: 'utility',
    apiProvider: 'google',
    apiEndpoint: '/v1beta/models/{model}:embedContent',
    envKeyName: 'GOOGLE_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'text', label: 'Text', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'embedding', label: 'Embedding', dataType: 'Text', required: false },
      { id: 'dimensions', label: 'Dimensions', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'gemini-embedding-001',
        options: [
          { label: 'Embedding 001 (text)', value: 'gemini-embedding-001' },
          { label: 'Embedding 2 (multimodal)', value: 'gemini-embedding-2-preview' },
        ],
      },
      {
        key: 'taskType',
        label: 'Task Type',
        type: 'enum',
        required: false,
        default: 'SEMANTIC_SIMILARITY',
        options: [
          { label: 'Semantic Similarity', value: 'SEMANTIC_SIMILARITY' },
          { label: 'Retrieval Query', value: 'RETRIEVAL_QUERY' },
          { label: 'Retrieval Document', value: 'RETRIEVAL_DOCUMENT' },
          { label: 'Classification', value: 'CLASSIFICATION' },
          { label: 'Clustering', value: 'CLUSTERING' },
          { label: 'Code Retrieval', value: 'CODE_RETRIEVAL_QUERY' },
          { label: 'Question Answering', value: 'QUESTION_ANSWERING' },
          { label: 'Fact Verification', value: 'FACT_VERIFICATION' },
        ],
      },
      {
        key: 'outputDimensionality',
        label: 'Dimensions',
        type: 'enum',
        required: false,
        default: '768',
        options: [
          { label: '768', value: '768' },
          { label: '1536', value: '1536' },
          { label: '3072', value: '3072' },
        ],
      },
    ],
  },

  'gemini-omni-flash': {
    id: 'gemini-omni-flash',
    displayName: 'Gemini Omni Flash',
    category: 'video-gen',
    apiProvider: 'google',
    apiEndpoint: 'gemini-omni-flash-preview',
    envKeyName: 'GOOGLE_API_KEY',
    executionPattern: 'async-poll',
    capabilityNote: 'Stateful prompts edit the existing clip in place. Gemini Omni cannot extend duration; use Veo 3.1 for video extension.',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'images', label: 'Reference Images', dataType: 'Image', required: false, multiple: true },
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
      { id: 'previous_interaction_id', label: 'Previous Interaction', dataType: 'Text', required: false },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
      { id: 'interaction_id', label: 'Interaction ID', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'task',
        label: 'Task',
        type: 'enum',
        required: false,
        default: '',
        options: [
          { label: 'Auto (infer)', value: '' },
          { label: 'Text to Video', value: 'text_to_video' },
          { label: 'Image to Video', value: 'image_to_video' },
          { label: 'Reference to Video', value: 'reference_to_video' },
          { label: 'Edit', value: 'edit' },
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
        key: 'delivery',
        label: 'Delivery',
        type: 'enum',
        required: false,
        default: 'uri',
        options: [
          { label: 'URI (recommended)', value: 'uri' },
          { label: 'Inline', value: 'inline' },
        ],
      },
      {
        key: 'previous_interaction_id',
        label: 'Previous Interaction',
        type: 'string',
        required: false,
        placeholder: 'Paste an ID or connect the Previous Interaction input',
      },
    ],
  },

  'veo-3': {
    id: 'veo-3',
    displayName: 'Veo 3.1',
    category: 'video-gen',
    apiProvider: 'google',
    apiEndpoint: 'veo-3.1-generate-preview',
    envKeyName: ['GOOGLE_API_KEY', 'FAL_KEY'],
    executionPattern: 'async-poll',
    directKeyName: 'GOOGLE_API_KEY',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'image', label: 'First Frame', dataType: 'Image', required: false, role: 'subject' },
      { id: 'last_frame', label: 'Last Frame', dataType: 'Image', required: false },
      { id: 'video', label: 'Extend Video', dataType: 'Video', required: false },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
      { id: 'source_uri', label: 'Source URI', dataType: 'Video', required: false },
    ],
    params: [],
    sharedParams: [
      {
        key: 'aspectRatio',
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
        default: '8',
        options: [
          { label: '4 seconds', value: '4', visibleWhen: { model: ['veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview', 'veo-3.1-lite-generate-preview', 'veo-3.0-generate-001', 'veo-3.0-fast-generate-001'] } },
          { label: '5 seconds', value: '5', visibleWhen: { model: ['veo-2.0-generate-001'] } },
          { label: '6 seconds', value: '6' },
          { label: '8 seconds', value: '8' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '720p',
        visibleWhen: { model: ['veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview', 'veo-3.1-lite-generate-preview', 'veo-3.0-generate-001', 'veo-3.0-fast-generate-001'] },
        options: [
          { label: '720p', value: '720p' },
          { label: '1080p', value: '1080p' },
          { label: '4K', value: '4k', visibleWhen: { model: ['veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview', 'veo-3.0-generate-001', 'veo-3.0-fast-generate-001'] } },
        ],
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
    directParams: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'veo-3.1-generate-preview',
        options: [
          { label: 'Veo 3.1', value: 'veo-3.1-generate-preview' },
          { label: 'Veo 3.1 Fast', value: 'veo-3.1-fast-generate-preview' },
          { label: 'Veo 3.1 Lite', value: 'veo-3.1-lite-generate-preview' },
          { label: 'Veo 3', value: 'veo-3.0-generate-001' },
          { label: 'Veo 3 Fast', value: 'veo-3.0-fast-generate-001' },
          { label: 'Veo 2', value: 'veo-2.0-generate-001' },
        ],
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        placeholder: 'Random',
        visibleWhen: { model: ['veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview', 'veo-3.1-lite-generate-preview', 'veo-3.0-generate-001', 'veo-3.0-fast-generate-001'] },
      },
    ],
    falParams: [
      {
        key: 'negative_prompt',
        label: 'Negative Prompt',
        type: 'string',
        required: false,
        placeholder: 'What to avoid',
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        placeholder: 'Random',
      },
      {
        key: 'safety_tolerance',
        label: 'Safety Tolerance',
        type: 'enum',
        required: false,
        default: '4',
        options: [
          { label: '1 (Strict)', value: '1' },
          { label: '2', value: '2' },
          { label: '3', value: '3' },
          { label: '4', value: '4' },
          { label: '5', value: '5' },
          { label: '6 (Permissive)', value: '6' },
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
    executionPattern: 'async-poll',
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
        default: 'landscape_4_3',
        options: [
          { label: 'Square HD (1024×1024)', value: 'square_hd' },
          { label: 'Square (512×512)', value: 'square' },
          { label: 'Landscape 4:3', value: 'landscape_4_3' },
          { label: 'Landscape 16:9', value: 'landscape_16_9' },
          { label: 'Portrait 4:3', value: 'portrait_4_3' },
          { label: 'Portrait 16:9', value: 'portrait_16_9' },
        ],
      },
      {
        key: 'num_inference_steps',
        label: 'Steps',
        type: 'integer',
        required: false,
        default: 4,
        min: 1,
        max: 4,
      },
      {
        key: 'guidance_scale',
        label: 'Guidance Scale',
        type: 'float',
        required: false,
        default: 3.5,
        min: 1.0,
        max: 5.0,
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
        key: 'output_format',
        label: 'Format',
        type: 'enum',
        required: false,
        default: 'jpeg',
        options: [
          { label: 'JPEG', value: 'jpeg' },
          { label: 'PNG', value: 'png' },
          { label: 'WebP', value: 'webp' },
        ],
      },
      {
        key: 'acceleration',
        label: 'Acceleration',
        type: 'enum',
        required: false,
        default: 'none',
        options: [
          { label: 'None', value: 'none' },
          { label: 'Regular', value: 'regular' },
          { label: 'High', value: 'high' },
        ],
      },
      {
        key: 'enable_safety_checker',
        label: 'Safety Checker',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        min: 0,
        max: 2147483647,
      },
    ],
  },

  'flux-fill-inpaint': {
    id: 'flux-fill-inpaint',
    displayName: 'FLUX Fill (Inpaint)',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/flux-pro/v1/fill',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'image', label: 'Base Image', dataType: 'Image', required: true },
      { id: 'mask', label: 'Mask (white = edit)', dataType: 'Image', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      { key: 'num_images', label: 'Count', type: 'integer', required: false, default: 1, min: 1, max: 4 },
      {
        key: 'output_format',
        label: 'Format',
        type: 'enum',
        required: false,
        default: 'jpeg',
        options: [
          { label: 'JPEG', value: 'jpeg' },
          { label: 'PNG', value: 'png' },
        ],
      },
      { key: 'enhance_prompt', label: 'Enhance Prompt', type: 'boolean', required: false, default: false },
      { key: 'seed', label: 'Seed', type: 'integer', required: false, placeholder: 'Random' },
    ],
  },

  'fast-sdxl': {
    id: 'fast-sdxl',
    displayName: 'Fast SDXL',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/fast-sdxl',
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
        key: 'num_inference_steps',
        label: 'Steps',
        type: 'integer',
        required: false,
        default: 25,
        min: 1,
        max: 50,
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
      {
        key: 'expand_prompt',
        label: 'Expand Prompt',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'loras',
        label: 'LoRAs (JSON)',
        type: 'textarea',
        required: false,
        default: '',
        placeholder: '[{"path":"https://...safetensors","scale":1.0}]',
      },
      {
        key: 'embeddings',
        label: 'Embeddings (JSON)',
        type: 'textarea',
        required: false,
        default: '',
        placeholder: '[{"path":"https://...","tokens":["<s0>"]}]',
      },
      {
        key: 'format',
        label: 'Format',
        type: 'enum',
        required: false,
        default: 'jpeg',
        options: [
          { label: 'JPEG', value: 'jpeg' },
          { label: 'PNG', value: 'png' },
        ],
      },
      {
        key: 'enable_safety_checker',
        label: 'Safety Checker',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'safety_checker_version',
        label: 'Safety Checker Version',
        type: 'enum',
        required: false,
        default: 'v1',
        options: [
          { label: 'v1 (Default)', value: 'v1' },
          { label: 'v2 (ViT)', value: 'v2' },
        ],
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        min: 0,
        max: 4294967295,
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
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: false },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: '2.6',
        options: [
          { label: 'WAN 2.6', value: '2.6' },
          { label: 'WAN 2.7', value: '2.7' },
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
          { label: '15 seconds', value: 15 },
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
          { label: '4:3', value: '4:3' },
          { label: '3:4', value: '3:4' },
        ],
      },
      {
        key: 'negative_prompt',
        label: 'Negative Prompt',
        type: 'string',
        required: false,
        placeholder: 'What to avoid',
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        placeholder: 'Random',
      },
      {
        key: 'generate_audio',
        label: 'Generate Audio',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'enable_prompt_expansion',
        label: 'Prompt Expansion',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'multi_shots',
        label: 'Multi-Shot',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'enable_safety_checker',
        label: 'Safety Checker',
        type: 'boolean',
        required: false,
        default: true,
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
          { label: '16:9', value: '16:9' },
          { label: '9:16', value: '9:16' },
          { label: '4:3', value: '4:3' },
          { label: '3:4', value: '3:4' },
          { label: '21:9', value: '21:9' },
          { label: '9:21', value: '9:21' },
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
        key: 'loop',
        label: 'Seamless Loop',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '540p',
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
      {
        key: 'fps',
        label: 'FPS',
        type: 'enum',
        required: false,
        default: '25',
        options: [
          { label: '25', value: '25' },
          { label: '50', value: '50' },
        ],
      },
      {
        key: 'generate_audio',
        label: 'Generate Audio',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
  },

  'worldlabs-environment': {
    id: 'worldlabs-environment',
    displayName: 'World Labs Environment',
    category: '3d-gen',
    apiProvider: 'worldlabs',
    apiEndpoint: '/marble/v1/worlds:generate',
    envKeyName: 'WORLDLABS_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt / Guidance', dataType: 'Text', required: false },
      { id: 'images', label: 'Image(s)', dataType: 'Image', required: false, multiple: true, role: 'composition' },
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    outputPorts: [
      { id: 'world', label: 'World', dataType: 'World', required: false },
      { id: 'panorama', label: 'Panorama', dataType: 'Image', required: false },
      { id: 'collider', label: 'Collider', dataType: 'Mesh', required: false },
      { id: 'thumbnail', label: 'Thumbnail', dataType: 'Image', required: false },
      { id: 'caption', label: 'Caption', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Marble Model',
        type: 'enum',
        required: false,
        default: 'marble-1.1',
        options: [
          { label: 'Marble 1.0 Draft', value: 'marble-1.0-draft' },
          { label: 'Marble 1.0', value: 'marble-1.0' },
          { label: 'Marble 1.1', value: 'marble-1.1' },
          { label: 'Marble 1.1 Plus', value: 'marble-1.1-plus' },
        ],
      },
      {
        key: 'display_name',
        label: 'World Name',
        type: 'string',
        required: false,
        default: '',
        placeholder: 'Optional name (64 characters max)',
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        default: '',
        min: 0,
        max: 4294967295,
        placeholder: 'Random',
      },
      {
        key: 'is_pano',
        label: 'Single Image Is Panorama',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto Detect', value: 'auto' },
          { label: 'Yes', value: 'true' },
          { label: 'No', value: 'false' },
        ],
      },
      {
        key: 'reconstruct_images',
        label: 'Reconstruct Image Set',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'azimuths',
        label: 'Image Azimuths',
        type: 'string',
        required: false,
        default: '',
        placeholder: 'Optional, e.g. 0, 90, 180, 270',
      },
      {
        key: 'disable_recaption',
        label: 'Use Prompt Verbatim',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'tags',
        label: 'Tags',
        type: 'string',
        required: false,
        default: '',
        placeholder: 'Optional comma-separated tags',
      },
      {
        key: 'resume_operation_id',
        label: 'Resume Operation ID',
        type: 'string',
        required: false,
        default: '',
        placeholder: 'Recover an accepted generation without starting another',
      },
      {
        key: 'existing_world_id',
        label: 'Existing World ID',
        type: 'string',
        required: false,
        default: '',
        placeholder: 'Fetch an existing Marble world without generating another',
      },
    ],
  },

  'worldlabs-world-export': {
    id: 'worldlabs-world-export',
    displayName: 'World Labs Export',
    category: 'transform',
    apiProvider: 'worldlabs',
    apiEndpoint: '/marble/v1/worlds/{world_id}:export',
    envKeyName: 'WORLDLABS_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'world', label: 'World', dataType: 'World', required: true },
    ],
    outputPorts: [
      { id: 'file', label: 'Exported 3D File', dataType: 'Mesh', required: false },
      { id: 'format', label: 'Format', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'format',
        label: 'Export Format',
        type: 'enum',
        required: false,
        default: 'ply',
        options: [
          { label: 'Gaussian Splat (PLY)', value: 'ply' },
          { label: 'High-Quality Mesh (GLB)', value: 'glb' },
        ],
      },
      {
        key: 'resolution',
        label: 'PLY Resolution',
        type: 'enum',
        required: false,
        default: 'full_res',
        visibleWhen: { format: ['ply'] },
        options: [
          { label: 'Full Resolution', value: 'full_res' },
          { label: '500K', value: '500k' },
          { label: '150K', value: '150k' },
          { label: '100K', value: '100k' },
        ],
      },
      {
        key: 'mesh_variant',
        label: 'GLB Mesh Variant',
        type: 'enum',
        required: false,
        default: 'textured',
        visibleWhen: { format: ['glb'] },
        options: [
          { label: 'Textured', value: 'textured' },
          { label: 'Vertex Colored', value: 'vertex_colored' },
        ],
      },
      {
        key: 'resume_operation_id',
        label: 'Resume Export Operation ID',
        type: 'string',
        required: false,
        default: '',
        placeholder: 'Recover an accepted export without starting another',
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
    directKeyName: 'MESHY_API_KEY',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'mesh', label: 'Mesh', dataType: 'Mesh', required: false },
    ],
    params: [],
    sharedParams: [
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
        key: 'model_type',
        label: 'Mesh Type',
        type: 'enum',
        required: false,
        default: 'standard',
        options: [
          { label: 'Standard', value: 'standard' },
          { label: 'Low Poly', value: 'lowpoly' },
        ],
      },
      {
        key: 'should_remesh',
        label: 'Remesh',
        type: 'boolean',
        required: false,
        default: false,
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
        min: 100,
        max: 300000,
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
    ],
    directParams: [
      {
        key: 'ai_model',
        label: 'AI Model',
        type: 'enum',
        required: false,
        default: 'latest',
        options: [
          { label: 'Latest (Meshy 6)', value: 'latest' },
          { label: 'Meshy 6', value: 'meshy-6' },
          { label: 'Meshy 5', value: 'meshy-5' },
        ],
      },
      {
        key: 'hd_texture',
        label: 'HD Texture (4K)',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'remove_lighting',
        label: 'Remove Lighting',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'target_formats',
        label: 'Output Formats',
        type: 'string',
        required: false,
        default: 'glb',
        placeholder: 'glb,fbx,obj,usdz',
      },
    ],
    falParams: [
      {
        key: 'texture_prompt',
        label: 'Texture Prompt',
        type: 'string',
        required: false,
        placeholder: 'Guide the texturing process',
      },
      {
        key: 'enable_prompt_expansion',
        label: 'Enhance Prompt',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'enable_safety_checker',
        label: 'Safety Checker',
        type: 'boolean',
        required: false,
        default: true,
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
    directKeyName: 'MESHY_API_KEY',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
    ],
    outputPorts: [
      { id: 'mesh', label: 'Mesh', dataType: 'Mesh', required: false },
    ],
    params: [],
    sharedParams: [
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
        min: 100,
        max: 300000,
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
        key: 'should_remesh',
        label: 'Remesh',
        type: 'boolean',
        required: false,
        default: false,
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
    ],
    directParams: [
      {
        key: 'ai_model',
        label: 'AI Model',
        type: 'enum',
        required: false,
        default: 'latest',
        options: [
          { label: 'Latest (Meshy 6)', value: 'latest' },
          { label: 'Meshy 6', value: 'meshy-6' },
          { label: 'Meshy 5', value: 'meshy-5' },
        ],
      },
      {
        key: 'model_type',
        label: 'Mesh Type',
        type: 'enum',
        required: false,
        default: 'standard',
        options: [
          { label: 'Standard', value: 'standard' },
          { label: 'Low Poly', value: 'lowpoly' },
        ],
      },
      {
        key: 'hd_texture',
        label: 'HD Texture (4K)',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'image_enhancement',
        label: 'Image Enhancement',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'remove_lighting',
        label: 'Remove Lighting',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'target_formats',
        label: 'Output Formats',
        type: 'string',
        required: false,
        default: 'glb',
        placeholder: 'glb,fbx,obj,usdz',
      },
    ],
    falParams: [
      {
        key: 'texture_prompt',
        label: 'Texture Prompt',
        type: 'string',
        required: false,
        placeholder: 'Guide the texturing process',
      },
      {
        key: 'enable_safety_checker',
        label: 'Safety Checker',
        type: 'boolean',
        required: false,
        default: true,
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

  'meshy-multi-image-to-3d': {
    id: 'meshy-multi-image-to-3d',
    displayName: 'Meshy Multi-Image-to-3D',
    category: '3d-gen',
    apiProvider: 'meshy',
    apiEndpoint: '/openapi/v1/multi-image-to-3d',
    envKeyName: 'MESHY_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'images', label: 'Images (1-4)', dataType: 'Image', required: true, multiple: true },
    ],
    outputPorts: [
      { id: 'mesh', label: 'Mesh', dataType: 'Mesh', required: false },
    ],
    params: [
      {
        key: 'ai_model',
        label: 'AI Model',
        type: 'enum',
        required: false,
        default: 'latest',
        options: [
          { label: 'Latest (Meshy 6)', value: 'latest' },
          { label: 'Meshy 6', value: 'meshy-6' },
          { label: 'Meshy 5', value: 'meshy-5' },
        ],
      },
      {
        key: 'should_remesh',
        label: 'Remesh',
        type: 'boolean',
        required: false,
        default: false,
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
        min: 100,
        max: 300000,
      },
      {
        key: 'symmetry_mode',
        label: 'Symmetry (deprecated)',
        type: 'enum',
        required: false,
        default: 'auto',
        hidden: true,
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
        key: 'hd_texture',
        label: 'HD Texture (4K)',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'image_enhancement',
        label: 'Image Enhancement',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'remove_lighting',
        label: 'Remove Lighting',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
  },

  'meshy-retexture': {
    id: 'meshy-retexture',
    displayName: 'Meshy Retexture',
    category: '3d-gen',
    apiProvider: 'meshy',
    apiEndpoint: '/openapi/v1/retexture',
    envKeyName: 'MESHY_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'model_url', label: 'Model URL', dataType: 'Text', required: true },
      { id: 'prompt', label: 'Style Prompt', dataType: 'Text', required: false },
    ],
    outputPorts: [
      { id: 'mesh', label: 'Mesh', dataType: 'Mesh', required: false },
    ],
    params: [
      {
        key: 'ai_model',
        label: 'AI Model',
        type: 'enum',
        required: false,
        default: 'latest',
        options: [
          { label: 'Latest (Meshy 6)', value: 'latest' },
          { label: 'Meshy 6', value: 'meshy-6' },
          { label: 'Meshy 5', value: 'meshy-5' },
        ],
      },
      {
        key: 'enable_original_uv',
        label: 'Keep Original UV',
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
        key: 'remove_lighting',
        label: 'Remove Lighting',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
  },

  'meshy-rigging': {
    id: 'meshy-rigging',
    displayName: 'Meshy Auto-Rig',
    category: '3d-gen',
    apiProvider: 'meshy',
    apiEndpoint: '/openapi/v1/rigging',
    envKeyName: 'MESHY_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'model_url', label: 'Model URL', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'mesh', label: 'Rigged Mesh', dataType: 'Mesh', required: false },
      { id: 'task_id', label: 'Rig Task ID', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'height_meters',
        label: 'Height (meters)',
        type: 'float',
        required: false,
        default: 1.7,
        min: 0.1,
        max: 5.0,
        step: 0.1,
      },
    ],
  },

  'meshy-animate': {
    id: 'meshy-animate',
    displayName: 'Meshy Animate',
    category: '3d-gen',
    apiProvider: 'meshy',
    apiEndpoint: '/openapi/v1/animations',
    envKeyName: 'MESHY_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'rig_task_id', label: 'Rig Task ID', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'mesh', label: 'Animated Mesh', dataType: 'Mesh', required: false },
    ],
    params: [
      {
        key: 'action_id',
        label: 'Animation',
        type: 'enum',
        required: true,
        default: '92',
        options: [
          { label: 'Idle', value: '1' },
          { label: 'Walking', value: '2' },
          { label: 'Running', value: '3' },
          { label: 'Jumping', value: '7' },
          { label: 'Dancing', value: '10' },
          { label: 'Waving', value: '15' },
          { label: 'Sitting', value: '20' },
          { label: 'Clapping', value: '25' },
          { label: 'Punching', value: '30' },
          { label: 'Kicking', value: '35' },
          { label: 'Sword Swing', value: '92' },
        ],
      },
      {
        key: 'fps',
        label: 'Output FPS',
        type: 'enum',
        required: false,
        default: '',
        options: [
          { label: 'Default (30)', value: '' },
          { label: '24 fps', value: '24' },
          { label: '25 fps', value: '25' },
          { label: '30 fps', value: '30' },
          { label: '60 fps', value: '60' },
        ],
      },
    ],
  },

  'meshy-remesh': {
    id: 'meshy-remesh',
    displayName: 'Meshy Remesh',
    category: '3d-gen',
    apiProvider: 'meshy',
    apiEndpoint: '/openapi/v1/remesh',
    envKeyName: 'MESHY_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'model_url', label: 'Model URL', dataType: 'Text', required: true },
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
        min: 100,
        max: 300000,
      },
      {
        key: 'target_formats',
        label: 'Output Formats',
        type: 'string',
        required: false,
        default: 'glb',
        placeholder: 'glb,fbx,obj,usdz,blend,stl',
      },
      {
        key: 'resize_height',
        label: 'Resize Height (m)',
        type: 'float',
        required: false,
        default: 0,
        min: 0,
        max: 100,
        step: 0.1,
        placeholder: '0 = no resize',
      },
      {
        key: 'convert_format_only',
        label: 'Convert Format Only',
        type: 'boolean',
        required: false,
        default: false,
      },
    ],
  },

  'meshy-text-to-image': {
    id: 'meshy-text-to-image',
    displayName: 'Meshy Text-to-Image',
    category: 'image-gen',
    apiProvider: 'meshy',
    apiEndpoint: '/openapi/v1/text-to-image',
    envKeyName: 'MESHY_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'ai_model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'nano-banana',
        options: [
          { label: 'Nano Banana', value: 'nano-banana' },
          { label: 'Nano Banana 2', value: 'nano-banana-2' },
          { label: 'Nano Banana Pro', value: 'nano-banana-pro' },
          { label: 'GPT Image 2', value: 'gpt-image-2' },
        ],
      },
      {
        key: 'generate_multi_view',
        label: 'Multi-View',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'aspect_ratio',
        label: 'Aspect Ratio',
        type: 'enum',
        required: false,
        default: '1:1',
        visibleWhen: { generate_multi_view: [false] },
        options: [
          { label: '1:1', value: '1:1' },
          { label: '16:9', value: '16:9' },
          { label: '9:16', value: '9:16' },
          { label: '4:3', value: '4:3' },
          { label: '3:4', value: '3:4' },
        ],
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
    ],
  },

  'meshy-image-to-image': {
    id: 'meshy-image-to-image',
    displayName: 'Meshy Image-to-Image',
    category: 'image-gen',
    apiProvider: 'meshy',
    apiEndpoint: '/openapi/v1/image-to-image',
    envKeyName: 'MESHY_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'images', label: 'Reference Images', dataType: 'Image', required: true, multiple: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'ai_model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'nano-banana',
        options: [
          { label: 'Nano Banana', value: 'nano-banana' },
          { label: 'Nano Banana 2', value: 'nano-banana-2' },
          { label: 'Nano Banana Pro', value: 'nano-banana-pro' },
          { label: 'GPT Image 2', value: 'gpt-image-2' },
        ],
      },
      {
        key: 'generate_multi_view',
        label: 'Multi-View',
        type: 'boolean',
        required: false,
        default: false,
      },
    ],
  },

  'meshy-3d-print': {
    id: 'meshy-3d-print',
    displayName: 'Meshy 3D Print',
    category: '3d-gen',
    apiProvider: 'meshy',
    apiEndpoint: '/openapi/v1/print/multi-color',
    envKeyName: 'MESHY_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'task_id', label: 'Task ID', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'mesh', label: 'Print File', dataType: 'Mesh', required: false },
    ],
    params: [
      {
        key: 'max_colors',
        label: 'Max Colors',
        type: 'integer',
        required: false,
        default: 4,
        min: 1,
        max: 16,
      },
      {
        key: 'max_depth',
        label: 'Color Depth',
        type: 'integer',
        required: false,
        default: 4,
        min: 3,
        max: 6,
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

  'gpt-image-1-edit': {
    id: 'gpt-image-1-edit',
    displayName: 'GPT Image 1 Edit',
    category: 'image-gen',
    apiProvider: 'openai',
    apiEndpoint: '/v1/images/edits',
    envKeyName: 'OPENAI_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'mask', label: 'Mask', dataType: 'Mask', required: false },
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
        key: 'n',
        label: 'Count',
        type: 'integer',
        required: false,
        default: 1,
        min: 1,
        max: 10,
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
        key: 'output_format',
        label: 'Format',
        type: 'enum',
        required: false,
        default: 'png',
        options: [
          { label: 'PNG', value: 'png' },
          { label: 'JPEG', value: 'jpeg' },
          { label: 'WebP', value: 'webp' },
        ],
      },
      {
        key: 'background',
        label: 'Background',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: 'Transparent', value: 'transparent' },
          { label: 'Opaque', value: 'opaque' },
        ],
      },
    ],
  },

  'remove-background': {
    id: 'remove-background',
    displayName: 'Remove Background',
    category: 'transform',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/imageutils/rembg',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'crop_to_bbox',
        label: 'Crop to Subject',
        type: 'boolean',
        required: false,
        default: false,
      },
    ],
  },

  'recraft-v4-raster': {
    id: 'recraft-v4-raster',
    displayName: 'Recraft V4',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/recraft/v4/text-to-image',
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
        key: 'image_size',
        label: 'Size',
        type: 'enum',
        required: false,
        default: 'square_hd',
        options: [
          { label: 'Square HD', value: 'square_hd' },
          { label: 'Square', value: 'square' },
          { label: 'Portrait 4:3', value: 'portrait_4_3' },
          { label: 'Portrait 16:9', value: 'portrait_16_9' },
          { label: 'Landscape 4:3', value: 'landscape_4_3' },
          { label: 'Landscape 16:9', value: 'landscape_16_9' },
        ],
      },
      {
        key: 'style_id',
        label: 'Style ID',
        type: 'string',
        required: false,
        placeholder: 'Custom style UUID (Recraft style reference)',
      },
      {
        key: 'colors',
        label: 'Color Palette',
        type: 'string',
        required: false,
        placeholder: '[{"r":255,"g":0,"b":0},{"r":0,"g":255,"b":0}]',
      },
      {
        key: 'background_color',
        label: 'Background Color',
        type: 'string',
        required: false,
        placeholder: '{"r":255,"g":255,"b":255}',
      },
      {
        key: 'enable_safety_checker',
        label: 'Safety Checker',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
  },

  'recraft-v4-svg': {
    id: 'recraft-v4-svg',
    displayName: 'Recraft V4 SVG',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/recraft/v4/text-to-vector',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'svg', label: 'SVG', dataType: 'SVG', required: false },
    ],
    params: [
      {
        key: 'image_size',
        label: 'Size',
        type: 'enum',
        required: false,
        default: 'square_hd',
        options: [
          { label: 'Square HD', value: 'square_hd' },
          { label: 'Square', value: 'square' },
          { label: 'Portrait 4:3', value: 'portrait_4_3' },
          { label: 'Portrait 16:9', value: 'portrait_16_9' },
          { label: 'Landscape 4:3', value: 'landscape_4_3' },
          { label: 'Landscape 16:9', value: 'landscape_16_9' },
        ],
      },
      {
        key: 'style_id',
        label: 'Style ID',
        type: 'string',
        required: false,
        placeholder: 'Custom style UUID (Recraft style reference)',
      },
      {
        key: 'colors',
        label: 'Color Palette',
        type: 'string',
        required: false,
        placeholder: '[{"r":255,"g":0,"b":0},{"r":0,"g":255,"b":0}]',
      },
      {
        key: 'background_color',
        label: 'Background Color',
        type: 'string',
        required: false,
        placeholder: '{"r":255,"g":255,"b":255}',
      },
      {
        key: 'enable_safety_checker',
        label: 'Safety Checker',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
  },

  'quiver-arrow-generate': {
    id: 'quiver-arrow-generate',
    displayName: 'Quiver Arrow Generate',
    category: 'image-gen',
    apiProvider: 'quiver',
    apiEndpoint: '/v1/svgs/generations',
    envKeyName: 'QUIVER_API_KEY',
    executionPattern: 'stream',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      // maxConnections:16 is the arrow-1.1-max ceiling; arrow-1 and arrow-1.1 only allow 4 refs at runtime — the backend returns 400 if exceeded.
      { id: 'references', label: 'References', dataType: 'Image', required: false, multiple: true, maxConnections: 16 },
    ],
    outputPorts: [
      { id: 'svg', label: 'SVG', dataType: 'SVG', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'arrow-1.1',
        options: [
          { label: 'Arrow 1.1 (20 credits)', value: 'arrow-1.1' },
          { label: 'Arrow 1.1 max (25 credits)', value: 'arrow-1.1-max' },
          { label: 'Arrow 1 (30 credits, legacy)', value: 'arrow-1' },
        ],
      },
      { key: 'n', label: 'Outputs', type: 'integer', required: false, default: 1, min: 1, max: 16 },
      {
        key: 'instructions',
        label: 'Instructions',
        type: 'textarea',
        required: false,
        placeholder: 'Optional style/formatting guidance (e.g. "thin uniform stroke, no fill")',
      },
      { key: 'temperature', label: 'Temperature', type: 'float', required: false, default: 1.0, min: 0, max: 2, step: 0.1 },
      { key: 'top_p', label: 'Top P', type: 'float', required: false, default: 1.0, min: 0, max: 1, step: 0.05 },
      { key: 'presence_penalty', label: 'Presence Penalty', type: 'float', required: false, default: 0.0, min: -2, max: 2, step: 0.1 },
      { key: 'max_output_tokens', label: 'Max Output Tokens', type: 'integer', required: false, default: 16384, min: 1, max: 131072 },
    ],
  },

  'quiver-arrow-vectorize': {
    id: 'quiver-arrow-vectorize',
    displayName: 'Quiver Arrow Vectorize',
    category: 'image-gen',
    apiProvider: 'quiver',
    apiEndpoint: '/v1/svgs/vectorizations',
    envKeyName: 'QUIVER_API_KEY',
    executionPattern: 'stream',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
    ],
    outputPorts: [
      { id: 'svg', label: 'SVG', dataType: 'SVG', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'arrow-1.1',
        options: [
          { label: 'Arrow 1.1 (15 credits)', value: 'arrow-1.1' },
          { label: 'Arrow 1.1 max (20 credits)', value: 'arrow-1.1-max' },
          { label: 'Arrow 1 (30 credits, legacy)', value: 'arrow-1' },
        ],
      },
      { key: 'auto_crop', label: 'Auto-crop to subject', type: 'boolean', required: false, default: false },
      { key: 'target_size', label: 'Target Size (px)', type: 'integer', required: false, default: 1024, min: 128, max: 4096 },
      { key: 'temperature', label: 'Temperature', type: 'float', required: false, default: 1.0, min: 0, max: 2, step: 0.1 },
      { key: 'top_p', label: 'Top P', type: 'float', required: false, default: 1.0, min: 0, max: 1, step: 0.05 },
      { key: 'presence_penalty', label: 'Presence Penalty', type: 'float', required: false, default: 0.0, min: -2, max: 2, step: 0.1 },
      { key: 'max_output_tokens', label: 'Max Output Tokens', type: 'integer', required: false, default: 16384, min: 1, max: 131072 },
    ],
  },

  'minimax-t2v': {
    id: 'minimax-t2v',
    displayName: 'MiniMax T2V',
    category: 'video-gen',
    apiProvider: 'minimax',
    apiEndpoint: 'https://api.minimaxi.com/v1/video_generation',
    envKeyName: 'MINIMAX_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'MiniMax-Hailuo-2.3',
        options: [
          { label: 'Hailuo 2.3', value: 'MiniMax-Hailuo-2.3' },
          { label: 'Hailuo 2.3 Fast', value: 'MiniMax-Hailuo-2.3-Fast' },
          { label: 'Hailuo 02 (legacy)', value: 'MiniMax-Hailuo-02' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration',
        type: 'enum',
        required: false,
        default: 6,
        options: [
          { label: '6 seconds', value: 6 },
          { label: '10 seconds', value: 10 },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '768P',
        options: [
          { label: '768P', value: '768P' },
          { label: '1080P', value: '1080P' },
        ],
      },
    ],
  },

  'minimax-i2v': {
    id: 'minimax-i2v',
    displayName: 'MiniMax I2V',
    category: 'video-gen',
    apiProvider: 'minimax',
    apiEndpoint: 'https://api.minimaxi.com/v1/video_generation',
    envKeyName: 'MINIMAX_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'first_frame_image', label: 'First Frame', dataType: 'Image', required: true, role: 'subject' },
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'MiniMax-Hailuo-2.3',
        options: [
          { label: 'Hailuo 2.3', value: 'MiniMax-Hailuo-2.3' },
          { label: 'Hailuo 2.3 Fast', value: 'MiniMax-Hailuo-2.3-Fast' },
          { label: 'Hailuo 02 (legacy)', value: 'MiniMax-Hailuo-02' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration',
        type: 'enum',
        required: false,
        default: 6,
        options: [
          { label: '6 seconds', value: 6 },
          { label: '10 seconds', value: 10 },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '768P',
        options: [
          { label: '768P', value: '768P' },
          { label: '1080P', value: '1080P' },
        ],
      },
    ],
  },

  'minimax-s2v': {
    id: 'minimax-s2v',
    displayName: 'MiniMax S2V',
    category: 'video-gen',
    apiProvider: 'minimax',
    apiEndpoint: 'https://api.minimaxi.com/v1/video_generation',
    envKeyName: 'MINIMAX_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'subject_reference', label: 'Character Image', dataType: 'Image', required: true, role: 'identity' },
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'S2V-01',
        options: [
          { label: 'S2V-01', value: 'S2V-01' },
        ],
      },
    ],
  },

  'kling-v3': {
    id: 'kling-v3',
    displayName: 'Kling V3',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/kling-video/v3/standard/text-to-video',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'image', label: 'Start Image', dataType: 'Image', required: false, role: 'subject' },
      { id: 'end_image', label: 'End Image', dataType: 'Image', required: false },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'standard',
        options: [
          { label: 'Standard', value: 'standard' },
          { label: 'Pro', value: 'pro' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration',
        type: 'enum',
        required: false,
        default: '5',
        options: [
          { label: '3 seconds', value: '3' },
          { label: '5 seconds', value: '5' },
          { label: '10 seconds', value: '10' },
          { label: '15 seconds', value: '15' },
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
      {
        key: 'negative_prompt',
        label: 'Negative Prompt',
        type: 'string',
        required: false,
        default: 'blur, distort, and low quality',
      },
      {
        key: 'shot_type',
        label: 'Shot Type',
        type: 'enum',
        required: false,
        default: 'customize',
        options: [
          { label: 'Customize', value: 'customize' },
          { label: 'Intelligent (auto)', value: 'intelligent' },
        ],
      },
      {
        key: 'multi_prompt',
        label: 'Multi-Shot (JSON)',
        type: 'textarea',
        required: false,
        default: '',
        placeholder: '[{"prompt":"shot 1","duration":3},{"prompt":"shot 2","duration":4}]',
      },
      {
        key: 'generate_audio',
        label: 'Generate Audio',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'cfg_scale',
        label: 'CFG Scale',
        type: 'float',
        required: false,
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.1,
      },
    ],
  },

  'luma-ray2-i2v': {
    id: 'luma-ray2-i2v',
    displayName: 'Luma Ray 2 I2V',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/luma-dream-machine/ray-2/image-to-video',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
      { id: 'end_image', label: 'End Image', dataType: 'Image', required: false },
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: false },
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
          { label: '4:3', value: '4:3' },
          { label: '3:4', value: '3:4' },
          { label: '21:9', value: '21:9' },
          { label: '9:21', value: '9:21' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '540p',
        options: [
          { label: '540p', value: '540p' },
          { label: '720p (2x cost)', value: '720p' },
          { label: '1080p (4x cost)', value: '1080p' },
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
        key: 'loop',
        label: 'Seamless Loop',
        type: 'boolean',
        required: false,
        default: false,
      },
    ],
  },

  'wan-2-6-i2v': {
    id: 'wan-2-6-i2v',
    displayName: 'Wan 2.6 I2V',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'wan/v2.6/image-to-video',
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
        default: 5,
        options: [
          { label: '5 seconds', value: 5 },
          { label: '10 seconds', value: 10 },
          { label: '15 seconds', value: 15 },
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
          { label: '4:3', value: '4:3' },
          { label: '3:4', value: '3:4' },
        ],
      },
      {
        key: 'negative_prompt',
        label: 'Negative Prompt',
        type: 'string',
        required: false,
        placeholder: 'What to avoid',
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        placeholder: 'Random',
      },
      {
        key: 'generate_audio',
        label: 'Generate Audio',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'enable_prompt_expansion',
        label: 'Prompt Expansion',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'multi_shots',
        label: 'Multi-Shot',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'enable_safety_checker',
        label: 'Safety Checker',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
  },
  'video-input': {
    id: 'video-input',
    displayName: 'Video Input',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
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
  'audio-input': {
    id: 'audio-input',
    displayName: 'Audio Input',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [],
    outputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: false },
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
  'sticky-note': {
    id: 'sticky-note',
    displayName: 'Sticky Note',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [],
    outputPorts: [],
    params: [
      {
        key: 'content',
        label: 'Note',
        type: 'textarea',
        required: false,
        default: '',
        placeholder: 'Add a note...',
      },
      {
        key: 'color',
        label: 'Color',
        type: 'enum',
        required: false,
        default: 'yellow',
        options: [
          { label: 'Yellow', value: 'yellow' },
          { label: 'Blue', value: 'blue' },
          { label: 'Green', value: 'green' },
          { label: 'Pink', value: 'pink' },
          { label: 'Grey', value: 'grey' },
        ],
      },
    ],
  },
  'luma-ray2-flash-modify': {
    id: 'luma-ray2-flash-modify',
    displayName: 'Luma Ray 2 Flash Modify',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/luma-dream-machine/ray-2-flash/modify',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: true },
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: false },
      { id: 'image', label: 'Reference Image', dataType: 'Image', required: false, role: 'style' },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'mode',
        label: 'Modification Mode',
        type: 'enum',
        required: false,
        default: 'flex_1',
        options: [
          { label: 'Adhere 1 (least)', value: 'adhere_1' },
          { label: 'Adhere 2', value: 'adhere_2' },
          { label: 'Adhere 3', value: 'adhere_3' },
          { label: 'Flex 1', value: 'flex_1' },
          { label: 'Flex 2', value: 'flex_2' },
          { label: 'Flex 3', value: 'flex_3' },
          { label: 'Reimagine 1', value: 'reimagine_1' },
          { label: 'Reimagine 2', value: 'reimagine_2' },
          { label: 'Reimagine 3 (most)', value: 'reimagine_3' },
        ],
      },
    ],
  },
  'wan-2-6-r2v': {
    id: 'wan-2-6-r2v',
    displayName: 'Wan 2.6 R2V',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'wan/v2.6/reference-to-video',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'video1', label: 'Video 1', dataType: 'Video', required: true },
      { id: 'video2', label: 'Video 2', dataType: 'Video', required: false },
      { id: 'video3', label: 'Video 3', dataType: 'Video', required: false },
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
        default: 5,
        options: [
          { label: '5 seconds', value: 5 },
          { label: '10 seconds', value: 10 },
        ],
      },
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
          { label: '1:1', value: '1:1' },
          { label: '4:3', value: '4:3' },
          { label: '3:4', value: '3:4' },
        ],
      },
      {
        key: 'negative_prompt',
        label: 'Negative Prompt',
        type: 'string',
        required: false,
        placeholder: 'What to avoid',
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        placeholder: 'Random',
      },
      {
        key: 'enable_prompt_expansion',
        label: 'Prompt Expansion',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'multi_shots',
        label: 'Multi-Shot',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'enable_safety_checker',
        label: 'Safety Checker',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
  },
  'pixverse-v4-5': {
    id: 'pixverse-v4-5',
    displayName: 'PixVerse V4.5',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/pixverse/v4.5/text-to-video',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
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
        default: 5,
        options: [
          { label: '5 seconds', value: 5 },
          { label: '8 seconds', value: 8 },
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
          { label: '4:3', value: '4:3' },
          { label: '1:1', value: '1:1' },
          { label: '3:4', value: '3:4' },
          { label: '9:16', value: '9:16' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '720p',
        options: [
          { label: '360p', value: '360p' },
          { label: '540p', value: '540p' },
          { label: '720p', value: '720p' },
          { label: '1080p', value: '1080p' },
        ],
      },
      {
        key: 'style',
        label: 'Style',
        type: 'enum',
        required: false,
        options: [
          { label: 'None', value: '' },
          { label: 'Anime', value: 'anime' },
          { label: '3D Animation', value: '3d_animation' },
          { label: 'Clay', value: 'clay' },
          { label: 'Comic', value: 'comic' },
          { label: 'Cyberpunk', value: 'cyberpunk' },
        ],
      },
      {
        key: 'negative_prompt',
        label: 'Negative Prompt',
        type: 'string',
        required: false,
        placeholder: 'What to avoid',
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
  'seedance-v1-5': {
    id: 'seedance-v1-5',
    displayName: 'Seedance V1.5 Pro (I2V)',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/bytedance/seedance/v1.5/pro/image-to-video',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'image', label: 'Image', dataType: 'Image', required: true, role: 'subject' },
      { id: 'end_image', label: 'End Image', dataType: 'Image', required: false },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: '1.5',
        options: [
          { label: 'Seedance 1.5 Pro', value: '1.5' },
          { label: 'Seedance 1.0 Pro', value: '1.0' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration',
        type: 'enum',
        required: false,
        default: '5',
        options: [
          { label: '4 seconds', value: '4' },
          { label: '5 seconds', value: '5' },
          { label: '6 seconds', value: '6' },
          { label: '7 seconds', value: '7' },
          { label: '8 seconds', value: '8' },
          { label: '9 seconds', value: '9' },
          { label: '10 seconds', value: '10' },
          { label: '11 seconds', value: '11' },
          { label: '12 seconds', value: '12' },
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
          { label: '21:9', value: '21:9' },
          { label: '4:3', value: '4:3' },
          { label: '3:4', value: '3:4' },
          { label: 'Auto', value: 'auto' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '720p',
        options: [
          { label: '480p', value: '480p' },
          { label: '720p', value: '720p' },
          { label: '1080p', value: '1080p' },
        ],
      },
      {
        key: 'generate_audio',
        label: 'Generate Audio',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'camera_fixed',
        label: 'Camera Fixed',
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
  'kling-o3': {
    id: 'kling-o3',
    displayName: 'Kling Omni 3',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/kling-video/o3/standard/image-to-video',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true, role: 'subject' },
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: false },
      { id: 'end_image', label: 'End Frame', dataType: 'Image', required: false },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'standard',
        options: [
          { label: 'Standard', value: 'standard' },
          { label: 'Pro', value: 'pro' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration',
        type: 'enum',
        required: false,
        default: '5',
        options: [
          { label: '3 seconds', value: '3' },
          { label: '5 seconds', value: '5' },
          { label: '10 seconds', value: '10' },
          { label: '15 seconds', value: '15' },
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
      {
        key: 'generate_audio',
        label: 'Generate Audio',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'negative_prompt',
        label: 'Negative Prompt',
        type: 'string',
        required: false,
        default: 'blur, distort, and low quality',
      },
      {
        key: 'cfg_scale',
        label: 'CFG Scale',
        type: 'float',
        required: false,
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.1,
      },
      {
        key: 'shot_type',
        label: 'Shot Type',
        type: 'enum',
        required: false,
        default: 'customize',
        options: [
          { label: 'Customize', value: 'customize' },
          { label: 'Intelligent (auto)', value: 'intelligent' },
        ],
      },
    ],
  },
  'ltx-2-3': {
    id: 'ltx-2-3',
    displayName: 'LTX 2.3',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/ltx-2.3/image-to-video',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'end_image', label: 'End Image', dataType: 'Image', required: false },
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: false },
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
      {
        key: 'aspect_ratio',
        label: 'Aspect Ratio',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '16:9', value: '16:9' },
          { label: '9:16', value: '9:16' },
        ],
      },
      {
        key: 'fps',
        label: 'FPS',
        type: 'enum',
        required: false,
        default: '25',
        options: [
          { label: '24', value: '24' },
          { label: '25', value: '25' },
          { label: '48', value: '48' },
          { label: '50', value: '50' },
        ],
      },
      {
        key: 'generate_audio',
        label: 'Generate Audio',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
  },

  'frame-extractor': {
    id: 'frame-extractor',
    displayName: 'Frame Extractor',
    category: 'transform',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'enum',
        required: false,
        default: 'first_frame',
        options: [
          { label: 'First Frame', value: 'first_frame' },
          { label: 'Last Frame', value: 'last_frame' },
          { label: 'Middle Frame', value: 'middle_frame' },
          { label: 'At Timestamp', value: 'timestamp' },
        ],
      },
      {
        key: 'timestamp',
        label: 'Timestamp (s)',
        type: 'float',
        required: false,
        default: 0,
        min: 0,
        step: 0.1,
        placeholder: '0.0',
      },
    ],
  },

  'array-builder': {
    id: 'array-builder',
    displayName: 'Array Builder',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      { id: 'item1', label: 'Item 1', dataType: 'Any', required: true },
      { id: 'item2', label: 'Item 2', dataType: 'Any', required: false },
      { id: 'item3', label: 'Item 3', dataType: 'Any', required: false },
      { id: 'item4', label: 'Item 4', dataType: 'Any', required: false },
      { id: 'item5', label: 'Item 5', dataType: 'Any', required: false },
      { id: 'item6', label: 'Item 6', dataType: 'Any', required: false },
      { id: 'item7', label: 'Item 7', dataType: 'Any', required: false },
      { id: 'item8', label: 'Item 8', dataType: 'Any', required: false },
    ],
    outputPorts: [
      { id: 'array', label: 'Array', dataType: 'Array', required: false },
    ],
    params: [],
  },

  'array-selector': {
    id: 'array-selector',
    displayName: 'Array Selector',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      { id: 'array', label: 'Array', dataType: 'Array', required: true },
    ],
    outputPorts: [
      { id: 'item', label: 'Item', dataType: 'Any', required: false },
    ],
    params: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'enum',
        required: false,
        default: 'first',
        options: [
          { label: 'First', value: 'first' },
          { label: 'Last', value: 'last' },
          { label: 'Random', value: 'random' },
          { label: 'By Index', value: 'index' },
        ],
      },
      {
        key: 'index',
        label: 'Index',
        type: 'integer',
        required: false,
        default: 0,
        min: 0,
      },
    ],
  },

  'image-compare': {
    id: 'image-compare',
    displayName: 'Image Compare',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      { id: 'imageA', label: 'Image A', dataType: 'Image', required: true },
      { id: 'imageB', label: 'Image B', dataType: 'Image', required: true },
    ],
    outputPorts: [],
    params: [],
  },

  'grok-imagine-video': {
    id: 'grok-imagine-video',
    displayName: 'Grok Imagine Video',
    category: 'video-gen',
    apiProvider: 'xai',
    apiEndpoint: 'https://api.x.ai/v1/videos/generations',
    envKeyName: 'XAI_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'duration',
        label: 'Duration',
        type: 'integer',
        required: false,
        default: 5,
        min: 1,
        max: 15,
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
          { label: '4:3', value: '4:3' },
          { label: '3:4', value: '3:4' },
          { label: '3:2', value: '3:2' },
          { label: '2:3', value: '2:3' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '480p',
        options: [
          { label: '480p', value: '480p' },
          { label: '720p', value: '720p' },
        ],
      },
    ],
  },

  'higgsfield': {
    id: 'higgsfield',
    displayName: 'Higgsfield',
    category: 'video-gen',
    apiProvider: 'higgsfield',
    apiEndpoint: 'https://platform.higgsfield.ai/higgsfield-ai/dop/standard',
    envKeyName: 'HIGGSFIELD_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'higgsfield-ai/dop/standard',
        options: [
          { label: 'DoP Standard (T2V + I2V)', value: 'higgsfield-ai/dop/standard' },
          { label: 'DoP Preview', value: 'higgsfield-ai/dop/preview' },
          { label: 'Kling v2.1 Pro (I2V)', value: 'kling-video/v2.1/pro/image-to-video' },
          { label: 'Seedance v1 Pro (I2V)', value: 'bytedance/seedance/v1/pro/image-to-video' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration',
        type: 'integer',
        required: false,
        default: 5,
        min: 1,
        max: 15,
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

  'seedance-2-t2v': {
    id: 'seedance-2-t2v',
    displayName: 'Seedance 2.0 Text-to-Video',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'bytedance/seedance-2.0/text-to-video',
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
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '21:9', value: '21:9' },
          { label: '16:9', value: '16:9' },
          { label: '4:3', value: '4:3' },
          { label: '1:1', value: '1:1' },
          { label: '3:4', value: '3:4' },
          { label: '9:16', value: '9:16' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '4s', value: '4' },
          { label: '5s', value: '5' },
          { label: '6s', value: '6' },
          { label: '8s', value: '8' },
          { label: '10s', value: '10' },
          { label: '12s', value: '12' },
          { label: '15s', value: '15' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '720p',
        options: [
          { label: '480p', value: '480p' },
          { label: '720p', value: '720p' },
          { label: '1080p', value: '1080p' },
        ],
      },
      {
        key: 'generate_audio',
        label: 'Generate Audio',
        type: 'boolean',
        required: false,
        default: true,
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

  'seedance-2-i2v': {
    id: 'seedance-2-i2v',
    displayName: 'Seedance 2.0 I2V',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'bytedance/seedance-2.0/image-to-video',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true, role: 'subject' },
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'end_image', label: 'End Frame', dataType: 'Image', required: false },
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
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '21:9', value: '21:9' },
          { label: '16:9', value: '16:9' },
          { label: '4:3', value: '4:3' },
          { label: '1:1', value: '1:1' },
          { label: '3:4', value: '3:4' },
          { label: '9:16', value: '9:16' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '4s', value: '4' },
          { label: '5s', value: '5' },
          { label: '6s', value: '6' },
          { label: '8s', value: '8' },
          { label: '10s', value: '10' },
          { label: '12s', value: '12' },
          { label: '15s', value: '15' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '720p',
        options: [
          { label: '480p', value: '480p' },
          { label: '720p', value: '720p' },
          { label: '1080p', value: '1080p' },
        ],
      },
      {
        key: 'generate_audio',
        label: 'Generate Audio',
        type: 'boolean',
        required: false,
        default: true,
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

  'seedance-2-r2v': {
    id: 'seedance-2-r2v',
    displayName: 'Seedance 2.0 R2V',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'bytedance/seedance-2.0/reference-to-video',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'images', label: 'Reference Images', dataType: 'Image', required: true, multiple: true, role: 'identity' },
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
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '21:9', value: '21:9' },
          { label: '16:9', value: '16:9' },
          { label: '9:16', value: '9:16' },
          { label: '4:3', value: '4:3' },
          { label: '1:1', value: '1:1' },
          { label: '3:4', value: '3:4' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '4s', value: '4' },
          { label: '6s', value: '6' },
          { label: '8s', value: '8' },
          { label: '10s', value: '10' },
          { label: '15s', value: '15' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '720p',
        options: [
          { label: '480p', value: '480p' },
          { label: '720p', value: '720p' },
          { label: '1080p', value: '1080p' },
        ],
      },
      {
        key: 'generate_audio',
        label: 'Generate Audio',
        type: 'boolean',
        required: false,
        default: true,
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

  'seedance-2-fast-t2v': {
    id: 'seedance-2-fast-t2v',
    displayName: 'Seedance 2.0 Fast T2V',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'bytedance/seedance-2.0/fast/text-to-video',
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
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '21:9', value: '21:9' },
          { label: '16:9', value: '16:9' },
          { label: '4:3', value: '4:3' },
          { label: '1:1', value: '1:1' },
          { label: '3:4', value: '3:4' },
          { label: '9:16', value: '9:16' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '4s', value: '4' },
          { label: '5s', value: '5' },
          { label: '6s', value: '6' },
          { label: '8s', value: '8' },
          { label: '10s', value: '10' },
          { label: '12s', value: '12' },
          { label: '15s', value: '15' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '720p',
        options: [
          { label: '480p', value: '480p' },
          { label: '720p', value: '720p' },
        ],
      },
      {
        key: 'generate_audio',
        label: 'Generate Audio',
        type: 'boolean',
        required: false,
        default: true,
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

  'seedance-2-fast-i2v': {
    id: 'seedance-2-fast-i2v',
    displayName: 'Seedance 2.0 Fast I2V',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'bytedance/seedance-2.0/fast/image-to-video',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'end_image', label: 'End Frame', dataType: 'Image', required: false },
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
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '21:9', value: '21:9' },
          { label: '16:9', value: '16:9' },
          { label: '4:3', value: '4:3' },
          { label: '1:1', value: '1:1' },
          { label: '3:4', value: '3:4' },
          { label: '9:16', value: '9:16' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '4s', value: '4' },
          { label: '5s', value: '5' },
          { label: '6s', value: '6' },
          { label: '8s', value: '8' },
          { label: '10s', value: '10' },
          { label: '12s', value: '12' },
          { label: '15s', value: '15' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '720p',
        options: [
          { label: '480p', value: '480p' },
          { label: '720p', value: '720p' },
        ],
      },
      {
        key: 'generate_audio',
        label: 'Generate Audio',
        type: 'boolean',
        required: false,
        default: true,
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

  'flux-kontext': {
    id: 'flux-kontext',
    displayName: 'FLUX Kontext',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/flux-pro/kontext',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'image', label: 'Image', dataType: 'Image', required: true, role: 'subject' },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'base',
        options: [
          { label: 'Kontext', value: 'base' },
          { label: 'Kontext Max', value: 'max' },
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
          { label: '3:2', value: '3:2' },
          { label: '2:3', value: '2:3' },
          { label: '21:9', value: '21:9' },
          { label: '9:21', value: '9:21' },
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
        default: 3.5,
        min: 1,
        max: 20,
        step: 0.5,
      },
      {
        key: 'enhance_prompt',
        label: 'Enhance Prompt',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'output_format',
        label: 'Format',
        type: 'enum',
        required: false,
        default: 'jpeg',
        options: [
          { label: 'JPEG', value: 'jpeg' },
          { label: 'PNG', value: 'png' },
        ],
      },
      {
        key: 'safety_tolerance',
        label: 'Safety',
        type: 'enum',
        required: false,
        default: '2',
        options: [
          { label: '1 (Strict)', value: '1' },
          { label: '2', value: '2' },
          { label: '3', value: '3' },
          { label: '4', value: '4' },
          { label: '5', value: '5' },
          { label: '6 (Permissive)', value: '6' },
        ],
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

  'flux-2-pro': {
    id: 'flux-2-pro',
    displayName: 'FLUX 2 Pro',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/flux-2-pro',
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
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'pro',
        options: [
          { label: 'FLUX 2 Pro', value: 'pro' },
          { label: 'FLUX 2 Max', value: 'max' },
          { label: 'FLUX 2 Flash', value: 'flash' },
        ],
      },
      {
        key: 'image_size',
        label: 'Size',
        type: 'enum',
        required: false,
        default: 'landscape_4_3',
        options: [
          { label: 'Square HD', value: 'square_hd' },
          { label: 'Square', value: 'square' },
          { label: 'Portrait 4:3', value: 'portrait_4_3' },
          { label: 'Portrait 16:9', value: 'portrait_16_9' },
          { label: 'Landscape 4:3', value: 'landscape_4_3' },
          { label: 'Landscape 16:9', value: 'landscape_16_9' },
        ],
      },
      {
        key: 'output_format',
        label: 'Format',
        type: 'enum',
        required: false,
        default: 'jpeg',
        options: [
          { label: 'JPEG', value: 'jpeg' },
          { label: 'PNG', value: 'png' },
        ],
      },
      {
        key: 'safety_tolerance',
        label: 'Safety',
        type: 'enum',
        required: false,
        default: '2',
        options: [
          { label: '1 (Strict)', value: '1' },
          { label: '2', value: '2' },
          { label: '3', value: '3' },
          { label: '4', value: '4' },
          { label: '5 (Permissive)', value: '5' },
        ],
      },
      {
        key: 'enable_safety_checker',
        label: 'Safety Checker',
        type: 'boolean',
        required: false,
        default: true,
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

  'gpt-image-1-5': {
    id: 'gpt-image-1-5',
    displayName: 'GPT Image 1.5',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/gpt-image-1.5',
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
        key: 'image_size',
        label: 'Size',
        type: 'enum',
        required: false,
        default: '1024x1024',
        options: [
          { label: '1024x1024', value: '1024x1024' },
          { label: '1536x1024', value: '1536x1024' },
          { label: '1024x1536', value: '1024x1536' },
        ],
      },
      {
        key: 'quality',
        label: 'Quality',
        type: 'enum',
        required: false,
        default: 'high',
        options: [
          { label: 'Low', value: 'low' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
        ],
      },
      {
        key: 'background',
        label: 'Background',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: 'Transparent', value: 'transparent' },
          { label: 'Opaque', value: 'opaque' },
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
        key: 'output_format',
        label: 'Format',
        type: 'enum',
        required: false,
        default: 'png',
        options: [
          { label: 'PNG', value: 'png' },
          { label: 'JPEG', value: 'jpeg' },
          { label: 'WebP', value: 'webp' },
        ],
      },
    ],
  },

  'gpt-image-1-5-edit': {
    id: 'gpt-image-1-5-edit',
    displayName: 'GPT Image 1.5 Edit',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/gpt-image-1.5/edit',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'images', label: 'Reference Images', dataType: 'Image', required: true, multiple: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'image_size',
        label: 'Size',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '1024x1024', value: '1024x1024' },
          { label: '1536x1024', value: '1536x1024' },
          { label: '1024x1536', value: '1024x1536' },
        ],
      },
      {
        key: 'quality',
        label: 'Quality',
        type: 'enum',
        required: false,
        default: 'high',
        options: [
          { label: 'Low', value: 'low' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
        ],
      },
      {
        key: 'input_fidelity',
        label: 'Input Fidelity',
        type: 'enum',
        required: false,
        default: 'high',
        options: [
          { label: 'Low', value: 'low' },
          { label: 'High', value: 'high' },
        ],
      },
      {
        key: 'background',
        label: 'Background',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: 'Transparent', value: 'transparent' },
          { label: 'Opaque', value: 'opaque' },
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
        key: 'output_format',
        label: 'Format',
        type: 'enum',
        required: false,
        default: 'png',
        options: [
          { label: 'PNG', value: 'png' },
          { label: 'JPEG', value: 'jpeg' },
          { label: 'WebP', value: 'webp' },
        ],
      },
    ],
  },

  'gpt-image-2-generate': {
    id: 'gpt-image-2-generate',
    displayName: 'GPT Image 2',
    category: 'image-gen',
    apiProvider: 'openai',
    apiEndpoint: '/v1/images/generations',
    envKeyName: 'OPENAI_API_KEY',
    executionPattern: 'stream',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'size',
        label: 'Size',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '1024x1024', value: '1024x1024' },
          { label: '1536x1024', value: '1536x1024' },
          { label: '1024x1536', value: '1024x1536' },
          { label: '2048x2048', value: '2048x2048' },
          { label: '2048x1152', value: '2048x1152' },
          { label: '3840x2160 (4K landscape)', value: '3840x2160' },
          { label: '2160x3840 (4K portrait)', value: '2160x3840' },
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
        key: 'output_format',
        label: 'Format',
        type: 'enum',
        required: false,
        default: 'png',
        options: [
          { label: 'PNG', value: 'png' },
          { label: 'JPEG', value: 'jpeg' },
          { label: 'WebP', value: 'webp' },
        ],
      },
      {
        key: 'output_compression',
        label: 'Compression',
        type: 'integer',
        required: false,
        default: 90,
        min: 0,
        max: 100,
      },
      {
        key: 'moderation',
        label: 'Moderation',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: 'Low', value: 'low' },
        ],
      },
    ],
  },

  'gpt-image-2-edit': {
    id: 'gpt-image-2-edit',
    displayName: 'GPT Image 2 Edit',
    category: 'image-gen',
    apiProvider: 'openai',
    apiEndpoint: '/v1/images/edits',
    envKeyName: 'OPENAI_API_KEY',
    executionPattern: 'stream',
    inputPorts: [
      { id: 'images', label: 'Images', dataType: 'Image', required: true, multiple: true },
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'mask', label: 'Mask', dataType: 'Mask', required: false },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'size',
        label: 'Size',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '1024x1024', value: '1024x1024' },
          { label: '1536x1024', value: '1536x1024' },
          { label: '1024x1536', value: '1024x1536' },
          { label: '2048x2048', value: '2048x2048' },
          { label: '2048x1152', value: '2048x1152' },
          { label: '3840x2160 (4K landscape)', value: '3840x2160' },
          { label: '2160x3840 (4K portrait)', value: '2160x3840' },
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
        key: 'output_format',
        label: 'Format',
        type: 'enum',
        required: false,
        default: 'png',
        options: [
          { label: 'PNG', value: 'png' },
          { label: 'JPEG', value: 'jpeg' },
          { label: 'WebP', value: 'webp' },
        ],
      },
      {
        key: 'output_compression',
        label: 'Compression',
        type: 'integer',
        required: false,
        default: 90,
        min: 0,
        max: 100,
      },
      {
        key: 'moderation',
        label: 'Moderation',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: 'Low', value: 'low' },
        ],
      },
    ],
  },

  'gpt-image-2-5-generate': {
    id: 'gpt-image-2-5-generate',
    displayName: 'GPT Image 2.5',
    category: 'image-gen',
    apiProvider: 'openai',
    apiEndpoint: '/v1/images/generations',
    envKeyName: 'OPENAI_API_KEY',
    executionPattern: 'stream',
    inputPorts: [
      {
        id: 'prompt',
        label: 'Prompt',
        dataType: 'Text',
        required: true,
      },
    ],
    outputPorts: [
      {
        id: 'image',
        label: 'Image',
        dataType: 'Image',
        required: false,
      },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'gpt-image-2.5-flare',
        options: [
          { label: 'Flare · fast', value: 'gpt-image-2.5-flare' },
          { label: 'Sunburst · most precise', value: 'gpt-image-2.5-sunburst' },
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
          { label: '1024x1024', value: '1024x1024' },
          { label: '1536x1024', value: '1536x1024' },
          { label: '1024x1536', value: '1024x1536' },
          { label: '2048x2048', value: '2048x2048' },
          { label: '2048x1152', value: '2048x1152' },
          { label: '2560x1440', value: '2560x1440' },
          { label: '3840x2160 (4K landscape, experimental)', value: '3840x2160' },
          { label: '2160x3840 (4K portrait, experimental)', value: '2160x3840' },
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
          { label: 'Extra high', value: 'xhigh' },
          { label: 'Max', value: 'max' },
        ],
      },
      {
        key: 'background',
        label: 'Background',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: 'Opaque', value: 'opaque' },
          { label: 'Transparent (PNG/WebP)', value: 'transparent' },
        ],
      },
      {
        key: 'output_format',
        label: 'Format',
        type: 'enum',
        required: false,
        default: 'png',
        options: [
          { label: 'PNG', value: 'png' },
          { label: 'JPEG', value: 'jpeg' },
          { label: 'WebP', value: 'webp' },
        ],
      },
      {
        key: 'output_compression',
        label: 'Compression',
        type: 'integer',
        required: false,
        default: 90,
        min: 0,
        max: 100,
      },
      {
        key: 'moderation',
        label: 'Moderation',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: 'Low', value: 'low' },
        ],
      },
    ],
  },

  'gpt-image-2-5-edit': {
    id: 'gpt-image-2-5-edit',
    displayName: 'GPT Image 2.5 Edit',
    category: 'image-gen',
    apiProvider: 'openai',
    apiEndpoint: '/v1/images/edits',
    envKeyName: 'OPENAI_API_KEY',
    executionPattern: 'stream',
    inputPorts: [
      {
        id: 'images',
        label: 'Images',
        dataType: 'Image',
        required: true,
        multiple: true,
      },
      {
        id: 'prompt',
        label: 'Prompt',
        dataType: 'Text',
        required: true,
      },
      {
        id: 'mask',
        label: 'Mask',
        dataType: 'Mask',
        required: false,
      },
    ],
    outputPorts: [
      {
        id: 'image',
        label: 'Image',
        dataType: 'Image',
        required: false,
      },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'gpt-image-2.5-flare',
        options: [
          { label: 'Flare · fast', value: 'gpt-image-2.5-flare' },
          { label: 'Sunburst · most precise', value: 'gpt-image-2.5-sunburst' },
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
          { label: '1024x1024', value: '1024x1024' },
          { label: '1536x1024', value: '1536x1024' },
          { label: '1024x1536', value: '1024x1536' },
          { label: '2048x2048', value: '2048x2048' },
          { label: '2048x1152', value: '2048x1152' },
          { label: '2560x1440', value: '2560x1440' },
          { label: '3840x2160 (4K landscape, experimental)', value: '3840x2160' },
          { label: '2160x3840 (4K portrait, experimental)', value: '2160x3840' },
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
          { label: 'Extra high', value: 'xhigh' },
          { label: 'Max', value: 'max' },
        ],
      },
      {
        key: 'background',
        label: 'Background',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: 'Opaque', value: 'opaque' },
          { label: 'Transparent (PNG/WebP)', value: 'transparent' },
        ],
      },
      {
        key: 'output_format',
        label: 'Format',
        type: 'enum',
        required: false,
        default: 'png',
        options: [
          { label: 'PNG', value: 'png' },
          { label: 'JPEG', value: 'jpeg' },
          { label: 'WebP', value: 'webp' },
        ],
      },
      {
        key: 'output_compression',
        label: 'Compression',
        type: 'integer',
        required: false,
        default: 90,
        min: 0,
        max: 100,
      },
      {
        key: 'moderation',
        label: 'Moderation',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: 'Low', value: 'low' },
        ],
      },
    ],
  },

  'gpt-image-2-fal-generate': {
    id: 'gpt-image-2-fal-generate',
    displayName: 'GPT Image 2 (FAL)',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'openai/gpt-image-2',
    envKeyName: 'FAL_KEY',
    executionPattern: 'stream',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'image_size',
        label: 'Size',
        type: 'enum',
        required: false,
        default: 'landscape_4_3',
        options: [
          { label: 'Square HD (1024x1024)', value: 'square_hd' },
          { label: 'Square (512x512)', value: 'square' },
          { label: 'Portrait 4:3 (768x1024)', value: 'portrait_4_3' },
          { label: 'Portrait 16:9 (576x1024)', value: 'portrait_16_9' },
          { label: 'Landscape 4:3 (1024x768)', value: 'landscape_4_3' },
          { label: 'Landscape 16:9 (1024x576)', value: 'landscape_16_9' },
        ],
      },
      {
        key: 'quality',
        label: 'Quality',
        type: 'enum',
        required: false,
        default: 'high',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: 'Low', value: 'low' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
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
        key: 'output_format',
        label: 'Format',
        type: 'enum',
        required: false,
        default: 'png',
        options: [
          { label: 'PNG', value: 'png' },
          { label: 'JPEG', value: 'jpeg' },
          { label: 'WebP', value: 'webp' },
        ],
      },
      {
        key: 'partial_images',
        label: 'Preview Frames',
        type: 'integer',
        required: false,
        default: 2,
        min: 0,
        max: 3,
      },
    ],
  },

  'gpt-image-2-fal-edit': {
    id: 'gpt-image-2-fal-edit',
    displayName: 'GPT Image 2 Edit (FAL)',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'openai/gpt-image-2/edit',
    envKeyName: 'FAL_KEY',
    executionPattern: 'stream',
    inputPorts: [
      { id: 'images', label: 'Reference Images', dataType: 'Image', required: true, multiple: true },
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'image_size',
        label: 'Size',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: 'Square HD (1024x1024)', value: 'square_hd' },
          { label: 'Square (512x512)', value: 'square' },
          { label: 'Portrait 4:3 (768x1024)', value: 'portrait_4_3' },
          { label: 'Portrait 16:9 (576x1024)', value: 'portrait_16_9' },
          { label: 'Landscape 4:3 (1024x768)', value: 'landscape_4_3' },
          { label: 'Landscape 16:9 (1024x576)', value: 'landscape_16_9' },
        ],
      },
      {
        key: 'quality',
        label: 'Quality',
        type: 'enum',
        required: false,
        default: 'high',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: 'Low', value: 'low' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
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
        key: 'output_format',
        label: 'Format',
        type: 'enum',
        required: false,
        default: 'png',
        options: [
          { label: 'PNG', value: 'png' },
          { label: 'JPEG', value: 'jpeg' },
          { label: 'WebP', value: 'webp' },
        ],
      },
      {
        key: 'partial_images',
        label: 'Preview Frames',
        type: 'integer',
        required: false,
        default: 2,
        min: 0,
        max: 3,
      },
    ],
  },

  'krea-2-generate': {
    id: 'krea-2-generate',
    displayName: 'Krea 2',
    category: 'image-gen',
    apiProvider: 'krea',
    apiEndpoint: '/generate/image/krea/krea-2/{variant}',
    envKeyName: 'KREA_API_TOKEN',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'style_images', label: 'Style Images', dataType: 'Image', required: false, multiple: true, maxConnections: 10, role: 'style' },
      { id: 'image_style_references', label: 'Image Style Refs', dataType: 'Any', required: false, multiple: true, maxConnections: 10 },
      { id: 'styles', label: 'Styles', dataType: 'Any', required: false, multiple: true },
      { id: 'moodboard', label: 'Moodboard', dataType: 'Any', required: false, maxConnections: 1 },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
      { id: 'job', label: 'Job', dataType: 'Any', required: false },
    ],
    params: [
      {
        key: '_kreaAuth',
        label: 'Krea connection',
        type: 'enum',
        required: false,
        options: [
          {
            value: 'api-token',
            label: 'API token · API balance',
          },
          {
            value: 'mcp',
            label: 'Krea account · workspace compute',
          },
        ],
        default: 'api-token',
      },
      {
        key: 'variant',
        label: 'Variant',
        type: 'enum',
        required: false,
        default: 'medium',
        options: [
          { label: 'Medium', value: 'medium' },
          { label: 'Large', value: 'large' },
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
          { label: '4:3', value: '4:3' },
          { label: '3:2', value: '3:2' },
          { label: '16:9', value: '16:9' },
          { label: '2.35:1', value: '2.35:1' },
          { label: '4:5', value: '4:5' },
          { label: '2:3', value: '2:3' },
          { label: '9:16', value: '9:16' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '1K',
        options: [
          { label: '1K', value: '1K' },
        ],
      },
      {
        key: 'creativity',
        label: 'Creativity',
        type: 'enum',
        required: false,
        default: 'medium',
        options: [
          { label: 'Raw', value: 'raw' },
          { label: 'Low', value: 'low' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
        ],
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        min: 0,
        max: 2147483647,
        placeholder: 'Random',
      },
      {
        key: 'style_reference_strength',
        label: 'Style Ref Strength',
        type: 'float',
        required: false,
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        key: 'style_id',
        label: 'Style ID',
        type: 'string',
        required: false,
        placeholder: 'Existing Krea style ID',
      },
      {
        key: 'style_strength',
        label: 'Style Strength',
        type: 'float',
        required: false,
        default: 1,
        min: -2,
        max: 2,
        step: 0.1,
      },
      {
        key: 'moodboard_id',
        label: 'Moodboard ID',
        type: 'string',
        required: false,
        placeholder: 'Existing Krea moodboard ID',
      },
      {
        key: 'moodboard_strength',
        label: 'Moodboard Strength',
        type: 'float',
        required: false,
        default: 0.23,
        min: 0,
        max: 1,
        step: 0.01,
      },
    ],
    docUrl: 'docs/model-providers/krea/krea-2.md',
  },

  'krea-image-style-reference': {
    id: 'krea-image-style-reference',
    displayName: 'Krea Image Style Ref',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true, role: 'style' },
    ],
    outputPorts: [
      { id: 'image_style_reference', label: 'Image Style Ref', dataType: 'Any', required: false },
    ],
    params: [
      {
        key: 'strength',
        label: 'Strength',
        type: 'float',
        required: false,
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
      },
    ],
    docUrl: 'docs/model-providers/krea/krea-2.md',
  },

  'krea-style': {
    id: 'krea-style',
    displayName: 'Krea Style',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [],
    outputPorts: [
      { id: 'style', label: 'Style', dataType: 'Any', required: false },
      { id: 'style_id', label: 'Style ID', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'style_id',
        label: 'Style ID',
        type: 'string',
        required: true,
        placeholder: 'Krea style ID',
      },
      {
        key: 'strength',
        label: 'Strength',
        type: 'float',
        required: false,
        default: 1,
        min: -2,
        max: 2,
        step: 0.1,
      },
    ],
    docUrl: 'docs/model-providers/krea/krea-2.md',
  },

  'krea-moodboard': {
    id: 'krea-moodboard',
    displayName: 'Krea Moodboard',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [],
    outputPorts: [
      { id: 'moodboard', label: 'Moodboard', dataType: 'Any', required: false },
      { id: 'moodboard_id', label: 'Moodboard ID', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'moodboard_id',
        label: 'Moodboard ID',
        type: 'string',
        required: true,
        placeholder: 'Krea moodboard ID',
      },
      {
        key: 'strength',
        label: 'Strength',
        type: 'float',
        required: false,
        default: 0.23,
        min: 0,
        max: 1,
        step: 0.01,
      },
    ],
    docUrl: 'docs/model-providers/krea/krea-2.md',
  },

  'krea-style-search': {
    id: 'krea-style-search',
    displayName: 'Krea Style Search',
    category: 'analyzer',
    apiProvider: 'krea',
    apiEndpoint: '/styles',
    envKeyName: 'KREA_API_TOKEN',
    executionPattern: 'sync',
    inputPorts: [],
    outputPorts: [
      { id: 'styles', label: 'Styles', dataType: 'Array', required: false },
      { id: 'text', label: 'Summary', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: '_kreaAuth',
        label: 'Krea connection',
        type: 'enum',
        required: false,
        options: [
          {
            value: 'api-token',
            label: 'API token · API balance',
          },
          {
            value: 'mcp',
            label: 'Krea account · workspace compute',
          },
        ],
        default: 'api-token',
      },
      {
        key: 'filter',
        label: 'Filter',
        type: 'enum',
        required: false,
        default: 'all',
        options: [
          { label: 'All', value: 'all' },
          { label: 'User', value: 'user' },
          { label: 'Community', value: 'community' },
          { label: 'Krea', value: 'krea' },
          { label: 'Shared', value: 'shared' },
          { label: 'Public', value: 'public' },
          { label: 'Gallery', value: 'gallery' },
        ],
      },
      {
        key: 'model',
        label: 'Model',
        type: 'string',
        required: false,
        placeholder: 'flux_dev, qwen, z-image, wan',
      },
      {
        key: 'ids',
        label: 'IDs',
        type: 'string',
        required: false,
        placeholder: 'Comma-separated style IDs',
      },
      {
        key: 'user',
        label: 'User',
        type: 'string',
        required: false,
      },
      {
        key: 'liked',
        label: 'Liked Only',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'limit',
        label: 'Limit',
        type: 'integer',
        required: false,
        default: 25,
        min: 1,
        max: 1000,
      },
      {
        key: 'cursor',
        label: 'Cursor',
        type: 'string',
        required: false,
      },
    ],
    docUrl: 'docs/model-providers/krea/krea-2.md',
  },

  'krea-style-train': {
    id: 'krea-style-train',
    displayName: 'Krea Style Train',
    category: 'image-gen',
    apiProvider: 'krea',
    apiEndpoint: '/styles/train',
    envKeyName: 'KREA_API_TOKEN',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'images', label: 'Training Images', dataType: 'Image', required: true, multiple: true },
    ],
    outputPorts: [
      { id: 'style', label: 'Style', dataType: 'Any', required: false },
      { id: 'style_id', label: 'Style ID', dataType: 'Text', required: false },
      { id: 'job', label: 'Job', dataType: 'Any', required: false },
    ],
    params: [
      {
        key: '_kreaAuth',
        label: 'Krea connection',
        type: 'enum',
        required: false,
        options: [
          {
            value: 'api-token',
            label: 'API token · API balance',
          },
          {
            value: 'mcp',
            label: 'Krea account · workspace compute',
          },
        ],
        default: 'api-token',
      },
      {
        key: 'name',
        label: 'Name',
        type: 'string',
        required: true,
        placeholder: 'Style name',
      },
      {
        key: 'model',
        label: 'Training Model',
        type: 'enum',
        required: false,
        default: 'flux_dev',
        options: [
          { label: 'FLUX Dev', value: 'flux_dev' },
          { label: 'FLUX Schnell', value: 'flux_schnell' },
          { label: 'Wan', value: 'wan' },
          { label: 'Wan 2.2', value: 'wan22' },
          { label: 'Qwen', value: 'qwen' },
          { label: 'Z-Image', value: 'z-image' },
          { label: 'Krea 2', value: 'k2' },
          { label: 'Krea 2 Large', value: 'k2-large' },
          { label: 'Krea 1 (Krea account)', value: 'k1' },
          { label: 'LTX 2.3 22B (Krea account)', value: 'ltx-23-22b' },
        ],
      },
      {
        key: 'training_type',
        label: 'Type',
        type: 'enum',
        required: false,
        default: 'Style',
        options: [
          { label: 'Style', value: 'Style' },
          { label: 'Object', value: 'Object' },
          { label: 'Character', value: 'Character' },
          { label: 'Default', value: 'Default' },
        ],
      },
      {
        key: 'trigger_word',
        label: 'Trigger Word',
        type: 'string',
        required: false,
      },
      {
        key: 'max_train_steps',
        label: 'Max Steps',
        type: 'integer',
        required: false,
        min: 1,
        max: 2000,
      },
      {
        key: 'learning_rate',
        label: 'Learning Rate',
        type: 'float',
        required: false,
        visibleWhen: { model: ['flux_dev', 'flux_schnell', 'wan', 'wan22'] },
      },
      {
        key: 'batch_size',
        label: 'Batch Size',
        type: 'integer',
        required: false,
        min: 1,
        visibleWhen: { model: ['flux_dev', 'flux_schnell', 'wan', 'wan22'] },
      },
      {
        key: 'generation_strength',
        label: 'Output Strength',
        type: 'float',
        required: false,
        default: 1,
        min: -2,
        max: 2,
        step: 0.1,
      },
      {
        key: 'share_with_workspace',
        label: 'Share Workspace',
        type: 'boolean',
        required: false,
        default: false,
      },
    ],
    docUrl: 'docs/model-providers/krea/krea-2.md',
  },

  'krea-moodboard-search': {
    id: 'krea-moodboard-search',
    displayName: 'Krea Moodboards',
    category: 'analyzer',
    apiProvider: 'krea',
    apiEndpoint: 'mcp:list_moodboards',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [],
    outputPorts: [
      {
        id: 'moodboard',
        label: 'Moodboard',
        dataType: 'Any',
        required: false,
      },
      {
        id: 'moodboard_id',
        label: 'Moodboard ID',
        dataType: 'Text',
        required: false,
      },
      {
        id: 'moodboards',
        label: 'Moodboards',
        dataType: 'Array',
        required: false,
      },
      {
        id: 'text',
        label: 'Summary',
        dataType: 'Text',
        required: false,
      },
    ],
    params: [
      {
        key: '_kreaAuth',
        label: 'Krea connection',
        type: 'enum',
        required: false,
        options: [
          {
            value: 'mcp',
            label: 'Krea account · workspace compute',
          },
        ],
        default: 'mcp',
      },
      {
        key: 'name',
        label: 'Name contains',
        type: 'string',
        required: false,
        placeholder: 'Any moodboard',
      },
      {
        key: 'strength',
        label: 'Strength',
        type: 'float',
        required: false,
        default: 0.23,
        min: 0,
        max: 1,
        step: 0.01,
      },
    ],
    docUrl: 'docs/model-providers/krea/krea-2.md',
  },

  'krea-moodboard-create': {
    id: 'krea-moodboard-create',
    displayName: 'Krea Moodboard Create',
    category: 'analyzer',
    apiProvider: 'krea',
    apiEndpoint: 'mcp:create_moodboard',
    envKeyName: [],
    executionPattern: 'async-poll',
    inputPorts: [
      {
        id: 'images',
        label: 'Images',
        dataType: 'Image',
        required: true,
        multiple: true,
      },
    ],
    outputPorts: [
      {
        id: 'moodboard',
        label: 'Moodboard',
        dataType: 'Any',
        required: false,
      },
      {
        id: 'moodboard_id',
        label: 'Moodboard ID',
        dataType: 'Text',
        required: false,
      },
      {
        id: 'job',
        label: 'Job',
        dataType: 'Any',
        required: false,
      },
    ],
    params: [
      {
        key: '_kreaAuth',
        label: 'Krea connection',
        type: 'enum',
        required: false,
        options: [
          {
            value: 'mcp',
            label: 'Krea account · workspace compute',
          },
        ],
        default: 'mcp',
      },
      {
        key: 'name',
        label: 'Name',
        type: 'string',
        required: false,
        placeholder: 'Moodboard name',
      },
      {
        key: 'strength',
        label: 'Strength',
        type: 'float',
        required: false,
        default: 0.23,
        min: 0,
        max: 1,
        step: 0.01,
      },
    ],
    docUrl: 'docs/model-providers/krea/krea-2.md',
  },

  'krea-library-manage': {
    id: 'krea-library-manage',
    displayName: 'Krea Library Manage',
    category: 'analyzer',
    apiProvider: 'krea',
    apiEndpoint: '/styles/{id}',
    envKeyName: 'KREA_API_TOKEN',
    executionPattern: 'sync',
    inputPorts: [
      {
        id: 'id',
        label: 'Style or Moodboard',
        dataType: 'Any',
        required: false,
      },
    ],
    outputPorts: [
      {
        id: 'id',
        label: 'ID',
        dataType: 'Text',
        required: false,
      },
      {
        id: 'result',
        label: 'Result',
        dataType: 'Any',
        required: false,
      },
      {
        id: 'text',
        label: 'Summary',
        dataType: 'Text',
        required: false,
      },
    ],
    params: [
      {
        key: '_kreaAuth',
        label: 'Krea connection',
        type: 'enum',
        required: false,
        options: [
          {
            value: 'api-token',
            label: 'API token · API balance',
          },
          {
            value: 'mcp',
            label: 'Krea account · workspace compute',
          },
        ],
        default: 'api-token',
      },
      {
        key: 'action',
        label: 'Action',
        type: 'enum',
        required: true,
        default: 'rename-style',
        options: [
          {
            label: 'Rename style',
            value: 'rename-style',
          },
          {
            label: 'Delete style',
            value: 'delete-style',
          },
          {
            label: 'Rename moodboard',
            value: 'rename-moodboard',
          },
          {
            label: 'Delete moodboard',
            value: 'delete-moodboard',
          },
        ],
      },
      {
        key: 'item_id',
        label: 'ID',
        type: 'string',
        required: false,
        placeholder: 'Or wire a style / moodboard',
      },
      {
        key: 'new_name',
        label: 'New name',
        type: 'string',
        required: false,
        visibleWhen: {
          action: [
            'rename-style',
            'rename-moodboard',
          ],
        },
      },
      {
        key: 'confirm_delete',
        label: 'Confirm delete',
        type: 'string',
        required: false,
        placeholder: 'Type the ID again',
        visibleWhen: {
          action: [
            'delete-style',
            'delete-moodboard',
          ],
        },
      },
    ],
    docUrl: 'docs/model-providers/krea/krea-2.md',
  },

  'krea-3d-export': {
    id: 'krea-3d-export',
    displayName: 'Krea 3D Export',
    category: 'transform',
    apiProvider: 'krea',
    apiEndpoint: '/export/3d',
    envKeyName: 'KREA_API_TOKEN',
    executionPattern: 'sync',
    inputPorts: [
      {
        id: 'job',
        label: 'Krea 3D Job',
        dataType: 'Any',
        required: false,
      },
    ],
    outputPorts: [
      {
        id: 'mesh',
        label: 'Mesh',
        dataType: 'Mesh',
        required: false,
      },
      {
        id: 'file',
        label: 'Model File',
        dataType: 'Text',
        required: false,
      },
      {
        id: 'files',
        label: 'Files',
        dataType: 'Array',
        required: false,
      },
      {
        id: 'archive',
        label: 'ZIP',
        dataType: 'Text',
        required: false,
      },
    ],
    params: [
      {
        key: 'file_format',
        label: 'Format',
        type: 'enum',
        required: true,
        default: 'obj',
        options: [
          {
            label: 'OBJ',
            value: 'obj',
          },
          {
            label: 'FBX',
            value: 'fbx',
          },
          {
            label: 'STL',
            value: 'stl',
          },
          {
            label: 'PLY',
            value: 'ply',
          },
        ],
      },
      {
        key: 'job_id',
        label: 'Job ID',
        type: 'string',
        required: false,
        placeholder: 'Or wire a Krea 3D job',
      },
      {
        key: 'node_app_key',
        label: 'Node app output key',
        type: 'string',
        required: false,
        placeholder: 'Only for node app jobs',
      },
    ],
    docUrl: 'docs/model-providers/krea/krea-gateway.md#3d-export',
  },

  'krea-job-history': {
    id: 'krea-job-history',
    displayName: 'Krea Job History',
    category: 'analyzer',
    apiProvider: 'krea',
    apiEndpoint: '/jobs',
    envKeyName: 'KREA_API_TOKEN',
    executionPattern: 'sync',
    inputPorts: [
      {
        id: 'job',
        label: 'Job',
        dataType: 'Any',
        required: false,
      },
    ],
    outputPorts: [
      {
        id: 'jobs',
        label: 'Jobs',
        dataType: 'Array',
        required: false,
      },
      {
        id: 'job',
        label: 'Job',
        dataType: 'Any',
        required: false,
      },
      {
        id: 'media',
        label: 'Media',
        dataType: 'Array',
        required: false,
      },
      {
        id: 'image',
        label: 'Image',
        dataType: 'Image',
        required: false,
      },
      {
        id: 'video',
        label: 'Video',
        dataType: 'Video',
        required: false,
      },
      {
        id: 'audio',
        label: 'Audio',
        dataType: 'Audio',
        required: false,
      },
      {
        id: 'mesh',
        label: 'Mesh',
        dataType: 'Mesh',
        required: false,
      },
      {
        id: 'text',
        label: 'Summary',
        dataType: 'Text',
        required: false,
      },
    ],
    params: [
      {
        key: '_kreaAuth',
        label: 'Krea connection',
        type: 'enum',
        required: false,
        options: [
          {
            value: 'api-token',
            label: 'API token · API balance',
          },
          {
            value: 'mcp',
            label: 'Krea account · workspace compute',
          },
        ],
        default: 'api-token',
      },
      {
        key: 'job_id',
        label: 'Job ID',
        type: 'string',
        required: false,
        placeholder: 'Blank lists recent jobs (API token)',
      },
      {
        key: 'status',
        label: 'Status',
        type: 'enum',
        required: false,
        default: 'any',
        options: [
          {
            label: 'Any',
            value: 'any',
          },
          {
            label: 'Completed',
            value: 'completed',
          },
          {
            label: 'Failed',
            value: 'failed',
          },
          {
            label: 'Cancelled',
            value: 'cancelled',
          },
          {
            label: 'Processing',
            value: 'processing',
          },
          {
            label: 'Queued',
            value: 'queued',
          },
        ],
      },
      {
        key: 'types',
        label: 'Job types',
        type: 'string',
        required: false,
        placeholder: 'e.g. flux,k1,externalImage',
      },
      {
        key: 'limit',
        label: 'Limit',
        type: 'integer',
        required: false,
        default: 20,
        min: 1,
        max: 1000,
      },
      {
        key: 'cursor',
        label: 'Before',
        type: 'string',
        required: false,
        placeholder: 'ISO time cursor',
      },
      {
        key: 'download',
        label: 'Save media',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'download_limit',
        label: 'Save up to (jobs)',
        type: 'integer',
        required: false,
        default: 10,
        min: 1,
        max: 100,
        visibleWhen: {
          download: [
            true,
          ],
        },
      },
    ],
    docUrl: 'docs/model-providers/krea/krea-workspace.md',
  },

  'krea-node-app': {
    id: 'krea-node-app',
    displayName: 'Krea Node App',
    category: 'universal',
    apiProvider: 'krea',
    apiEndpoint: '/node-apps/{id}/execute',
    envKeyName: 'KREA_API_TOKEN',
    executionPattern: 'async-poll',
    inputPorts: [
      {
        id: 'images',
        label: 'Images',
        dataType: 'Image',
        required: false,
        multiple: true,
      },
      {
        id: 'text',
        label: 'Text',
        dataType: 'Text',
        required: false,
      },
      {
        id: 'inputs',
        label: 'Inputs',
        dataType: 'Any',
        required: false,
      },
    ],
    outputPorts: [
      {
        id: 'outputs',
        label: 'Outputs',
        dataType: 'Any',
        required: false,
      },
      {
        id: 'media',
        label: 'Media',
        dataType: 'Array',
        required: false,
      },
      {
        id: 'image',
        label: 'Image',
        dataType: 'Image',
        required: false,
      },
      {
        id: 'video',
        label: 'Video',
        dataType: 'Video',
        required: false,
      },
      {
        id: 'audio',
        label: 'Audio',
        dataType: 'Audio',
        required: false,
      },
      {
        id: 'mesh',
        label: 'Mesh',
        dataType: 'Mesh',
        required: false,
      },
      {
        id: 'jobs',
        label: 'Jobs',
        dataType: 'Array',
        required: false,
      },
    ],
    params: [
      {
        key: '_kreaAuth',
        label: 'Krea connection',
        type: 'enum',
        required: false,
        options: [
          {
            value: 'api-token',
            label: 'API token · API balance',
          },
          {
            value: 'mcp',
            label: 'Krea account · workspace compute',
          },
        ],
        default: 'api-token',
      },
      {
        key: 'node_app_version_id',
        label: 'Node app version ID',
        type: 'string',
        required: true,
        placeholder: 'From Krea or the agent\'s get_node_apps',
      },
      {
        key: 'input',
        label: 'Input (JSON)',
        type: 'textarea',
        required: false,
        placeholder: '{"idea": "..."}',
      },
    ],
    docUrl: 'docs/model-providers/krea/krea-workspace.md',
  },

  'krea-files': {
    id: 'krea-files',
    displayName: 'Krea Files',
    category: 'analyzer',
    apiProvider: 'krea',
    apiEndpoint: 'mcp:list_files',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [],
    outputPorts: [
      {
        id: 'files',
        label: 'Files',
        dataType: 'Array',
        required: false,
      },
      {
        id: 'media',
        label: 'Media',
        dataType: 'Array',
        required: false,
      },
      {
        id: 'image',
        label: 'Image',
        dataType: 'Image',
        required: false,
      },
      {
        id: 'video',
        label: 'Video',
        dataType: 'Video',
        required: false,
      },
      {
        id: 'audio',
        label: 'Audio',
        dataType: 'Audio',
        required: false,
      },
      {
        id: 'mesh',
        label: 'Mesh',
        dataType: 'Mesh',
        required: false,
      },
      {
        id: 'text',
        label: 'Text',
        dataType: 'Text',
        required: false,
      },
      {
        id: 'summary',
        label: 'Summary',
        dataType: 'Text',
        required: false,
      },
    ],
    params: [
      {
        key: '_kreaAuth',
        label: 'Krea connection',
        type: 'enum',
        required: false,
        options: [
          {
            value: 'mcp',
            label: 'Krea account · workspace compute',
          },
        ],
        default: 'mcp',
      },
      {
        key: 'scope',
        label: 'Scope',
        type: 'enum',
        required: false,
        default: 'user',
        options: [
          {
            label: 'My files',
            value: 'user',
          },
          {
            label: 'Workspace',
            value: 'workspace',
          },
        ],
      },
      {
        key: 'file_type',
        label: 'Type',
        type: 'enum',
        required: false,
        default: 'file',
        options: [
          {
            label: 'Files',
            value: 'file',
          },
          {
            label: 'Assets',
            value: 'asset',
          },
          {
            label: 'Folders',
            value: 'folder',
          },
          {
            label: 'Moodboards',
            value: 'moodboard',
          },
          {
            label: 'Styles',
            value: 'style',
          },
          {
            label: 'Sessions',
            value: 'session',
          },
          {
            label: 'Collections',
            value: 'collection',
          },
          {
            label: 'Anything',
            value: 'any',
          },
        ],
      },
      {
        key: 'filename',
        label: 'Name contains',
        type: 'string',
        required: false,
      },
      {
        key: 'tags',
        label: 'Tags (all of)',
        type: 'string',
        required: false,
        placeholder: 'comma,separated',
      },
      {
        key: 'folder_uri',
        label: 'Folder',
        type: 'string',
        required: false,
        placeholder: 'folder:<uuid>',
      },
      {
        key: 'limit',
        label: 'Limit',
        type: 'integer',
        required: false,
        default: 25,
        min: 1,
        max: 200,
      },
      {
        key: 'download',
        label: 'Bring contents in',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
    docUrl: 'docs/model-providers/krea/krea-workspace.md',
  },

  'krea-files-save': {
    id: 'krea-files-save',
    displayName: 'Save to Krea Files',
    category: 'analyzer',
    apiProvider: 'krea',
    apiEndpoint: 'mcp:write_files_upload',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      {
        id: 'media',
        label: 'Media',
        dataType: 'Any',
        required: false,
        multiple: true,
      },
      {
        id: 'text',
        label: 'Text',
        dataType: 'Text',
        required: false,
      },
    ],
    outputPorts: [
      {
        id: 'uris',
        label: 'Krea Files',
        dataType: 'Array',
        required: false,
      },
      {
        id: 'text',
        label: 'Summary',
        dataType: 'Text',
        required: false,
      },
    ],
    params: [
      {
        key: '_kreaAuth',
        label: 'Krea connection',
        type: 'enum',
        required: false,
        options: [
          {
            value: 'mcp',
            label: 'Krea account · workspace compute',
          },
        ],
        default: 'mcp',
      },
      {
        key: 'name',
        label: 'Name',
        type: 'string',
        required: false,
        placeholder: 'Keeps the file name when blank',
      },
      {
        key: 'folder',
        label: 'Folder',
        type: 'string',
        required: false,
        placeholder: 'Created if missing',
      },
      {
        key: 'scope',
        label: 'Scope',
        type: 'enum',
        required: false,
        default: 'user',
        options: [
          {
            label: 'My files',
            value: 'user',
          },
          {
            label: 'Workspace',
            value: 'workspace',
          },
        ],
      },
      {
        key: 'tags',
        label: 'Tags',
        type: 'string',
        required: false,
        placeholder: 'comma,separated',
      },
    ],
    docUrl: 'docs/model-providers/krea/krea-workspace.md',
  },

  'krea-nodes-workflow': {
    id: 'krea-nodes-workflow',
    displayName: 'Krea Nodes Workflow',
    category: 'analyzer',
    apiProvider: 'krea',
    apiEndpoint: 'mcp:create_node_workflow',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      {
        id: 'workflow',
        label: 'Workflow spec',
        dataType: 'Any',
        required: false,
      },
    ],
    outputPorts: [
      {
        id: 'workflow',
        label: 'Workflow',
        dataType: 'Any',
        required: false,
      },
      {
        id: 'url',
        label: 'Link',
        dataType: 'Text',
        required: false,
      },
      {
        id: 'text',
        label: 'Summary',
        dataType: 'Text',
        required: false,
      },
    ],
    params: [
      {
        key: '_kreaAuth',
        label: 'Krea connection',
        type: 'enum',
        required: false,
        options: [
          {
            value: 'mcp',
            label: 'Krea account · workspace compute',
          },
        ],
        default: 'mcp',
      },
      {
        key: 'action',
        label: 'Action',
        type: 'enum',
        required: true,
        default: 'create',
        options: [
          {
            label: 'Create in Krea Nodes',
            value: 'create',
          },
          {
            label: 'Read a workflow',
            value: 'read',
          },
          {
            label: 'Edit a workflow',
            value: 'update',
          },
        ],
      },
      {
        key: 'name',
        label: 'Name',
        type: 'string',
        required: false,
        visibleWhen: {
          action: [
            'create',
          ],
        },
      },
      {
        key: 'spec',
        label: 'Nodes and edges (JSON)',
        type: 'textarea',
        required: false,
        placeholder: '{"nodes": [...], "edges": [...]}',
        visibleWhen: {
          action: [
            'create',
          ],
        },
      },
      {
        key: 'workflow_id',
        label: 'Workflow ID or link',
        type: 'string',
        required: false,
        visibleWhen: {
          action: [
            'read',
            'update',
          ],
        },
      },
      {
        key: 'read_mode',
        label: 'Detail',
        type: 'enum',
        required: false,
        default: 'list',
        options: [
          {
            label: 'Summary',
            value: 'summary',
          },
          {
            label: 'Nodes',
            value: 'list',
          },
          {
            label: 'Full',
            value: 'detail',
          },
        ],
        visibleWhen: {
          action: [
            'read',
          ],
        },
      },
      {
        key: 'operations',
        label: 'Operations (JSON)',
        type: 'textarea',
        required: false,
        visibleWhen: {
          action: [
            'update',
          ],
        },
      },
    ],
    docUrl: 'docs/model-providers/krea/krea-workspace.md',
  },

  'krea-agent': {
    id: 'krea-agent',
    displayName: 'Krea Agent',
    category: 'universal',
    apiProvider: 'krea',
    apiEndpoint: 'mcp:send_agent_message',
    envKeyName: [],
    executionPattern: 'async-poll',
    inputPorts: [
      {
        id: 'prompt',
        label: 'Prompt',
        dataType: 'Text',
        required: false,
      },
      {
        id: 'attachments',
        label: 'Attachments',
        dataType: 'Image',
        required: false,
        multiple: true,
        maxConnections: 20,
      },
      {
        id: 'session',
        label: 'Continue session',
        dataType: 'Any',
        required: false,
      },
    ],
    outputPorts: [
      {
        id: 'media',
        label: 'Media',
        dataType: 'Array',
        required: false,
      },
      {
        id: 'image',
        label: 'Image',
        dataType: 'Image',
        required: false,
      },
      {
        id: 'video',
        label: 'Video',
        dataType: 'Video',
        required: false,
      },
      {
        id: 'audio',
        label: 'Audio',
        dataType: 'Audio',
        required: false,
      },
      {
        id: 'mesh',
        label: 'Mesh',
        dataType: 'Mesh',
        required: false,
      },
      {
        id: 'text',
        label: 'Reply',
        dataType: 'Text',
        required: false,
      },
      {
        id: 'session',
        label: 'Session',
        dataType: 'Any',
        required: false,
      },
      {
        id: 'url',
        label: 'Session link',
        dataType: 'Text',
        required: false,
      },
    ],
    params: [
      {
        key: '_kreaAuth',
        label: 'Krea connection',
        type: 'enum',
        required: false,
        options: [
          {
            value: 'mcp',
            label: 'Krea account · workspace compute',
          },
        ],
        default: 'mcp',
      },
      {
        key: 'prompt',
        label: 'Prompt',
        type: 'textarea',
        required: false,
      },
      {
        key: 'name',
        label: 'Session name',
        type: 'string',
        required: false,
      },
      {
        key: 'session_id',
        label: 'Session ID',
        type: 'string',
        required: false,
        placeholder: 'Continue an existing session',
      },
      {
        key: 'effort',
        label: 'Effort',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          {
            label: 'Auto',
            value: 'auto',
          },
          {
            label: 'Fast',
            value: 'fast',
          },
          {
            label: 'Default',
            value: 'default',
          },
          {
            label: 'High',
            value: 'high',
          },
          {
            label: 'Extra high',
            value: 'xhigh',
          },
        ],
      },
      {
        key: 'model',
        label: 'Model',
        type: 'string',
        required: false,
        placeholder: 'Auto; must be in your plan',
      },
      {
        key: 'wait_seconds',
        label: 'Wait up to (s)',
        type: 'integer',
        required: false,
        default: 900,
        min: 30,
        max: 3600,
      },
    ],
    docUrl: 'docs/model-providers/krea/krea-workspace.md',
  },

  'krea-desktop': {
    id: 'krea-desktop',
    displayName: 'Krea Desktop Apps',
    category: 'analyzer',
    apiProvider: 'krea',
    apiEndpoint: 'mcp:call_desktop_tool',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      {
        id: 'job',
        label: 'Krea job',
        dataType: 'Any',
        required: false,
      },
    ],
    outputPorts: [
      {
        id: 'result',
        label: 'Result',
        dataType: 'Any',
        required: false,
      },
      {
        id: 'image',
        label: 'Frame',
        dataType: 'Image',
        required: false,
      },
      {
        id: 'text',
        label: 'Summary',
        dataType: 'Text',
        required: false,
      },
    ],
    params: [
      {
        key: '_kreaAuth',
        label: 'Krea connection',
        type: 'enum',
        required: false,
        options: [
          {
            value: 'mcp',
            label: 'Krea account · workspace compute',
          },
        ],
        default: 'mcp',
      },
      {
        key: 'action',
        label: 'Action',
        type: 'enum',
        required: true,
        default: 'list-apps',
        options: [
          {
            label: 'List connected apps',
            value: 'list-apps',
          },
          {
            label: 'List an app\'s tools',
            value: 'list-tools',
          },
          {
            label: 'Run a tool',
            value: 'call-tool',
          },
        ],
      },
      {
        key: 'app_id',
        label: 'App ID',
        type: 'string',
        required: false,
        visibleWhen: {
          action: [
            'list-tools',
            'call-tool',
          ],
        },
      },
      {
        key: 'tool',
        label: 'Tool',
        type: 'string',
        required: false,
        placeholder: 'e.g. ae.addLayer',
        visibleWhen: {
          action: [
            'call-tool',
          ],
        },
      },
      {
        key: 'input',
        label: 'Tool input (JSON)',
        type: 'textarea',
        required: false,
        visibleWhen: {
          action: [
            'call-tool',
          ],
        },
      },
      {
        key: 'output_index',
        label: 'Job output index',
        type: 'integer',
        required: false,
        default: 0,
        min: 0,
        visibleWhen: {
          action: [
            'call-tool',
          ],
        },
      },
    ],
    docUrl: 'docs/model-providers/krea/krea-workspace.md',
  },

  'krea-usage': {
    id: 'krea-usage',
    displayName: 'Krea Usage',
    category: 'analyzer',
    apiProvider: 'krea',
    apiEndpoint: '/usage',
    envKeyName: 'KREA_USAGE_KEY',
    executionPattern: 'sync',
    inputPorts: [],
    outputPorts: [
      {
        id: 'jobs',
        label: 'Jobs',
        dataType: 'Array',
        required: false,
      },
      {
        id: 'total',
        label: 'Compute units',
        dataType: 'Text',
        required: false,
      },
      {
        id: 'text',
        label: 'Summary',
        dataType: 'Text',
        required: false,
      },
    ],
    params: [
      {
        key: 'start_date',
        label: 'From',
        type: 'string',
        required: false,
        placeholder: '2026-10-01 (default: 7 days ago)',
      },
      {
        key: 'end_date',
        label: 'To',
        type: 'string',
        required: false,
        placeholder: 'Default: now',
      },
    ],
    docUrl: 'docs/model-providers/krea/krea-workspace.md',
  },

  'clarity-upscaler': {
    id: 'clarity-upscaler',
    displayName: 'Clarity Upscaler',
    category: 'transform',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/clarity-upscaler',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'prompt',
        label: 'Enhancement Prompt',
        type: 'string',
        required: false,
        default: 'masterpiece, best quality, highres',
      },
      {
        key: 'upscale_factor',
        label: 'Upscale Factor',
        type: 'float',
        required: false,
        default: 2,
        min: 1,
        max: 4,
        step: 0.5,
      },
      {
        key: 'creativity',
        label: 'Creativity (added detail)',
        type: 'float',
        required: false,
        default: 0.35,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        key: 'resemblance',
        label: 'Resemblance (fidelity)',
        type: 'float',
        required: false,
        default: 0.6,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        key: 'num_inference_steps',
        label: 'Steps',
        type: 'integer',
        required: false,
        default: 18,
        min: 10,
        max: 50,
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

  'seedvr-video-upscale': {
    id: 'seedvr-video-upscale',
    displayName: 'SeedVR2 Video Upscale',
    category: 'transform',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/seedvr/upscale/video',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: true },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'upscale_mode',
        label: 'Mode',
        type: 'enum',
        required: false,
        default: 'factor',
        options: [
          { label: 'Factor (multiplier)', value: 'factor' },
          { label: 'Target resolution', value: 'target' },
        ],
      },
      {
        key: 'upscale_factor',
        label: 'Upscale Factor',
        type: 'float',
        required: false,
        default: 2,
        min: 1,
        max: 4,
        step: 0.5,
      },
      {
        key: 'target_resolution',
        label: 'Target Resolution',
        type: 'enum',
        required: false,
        default: '1080p',
        options: [
          { label: '720p', value: '720p' },
          { label: '1080p', value: '1080p' },
          { label: '1440p', value: '1440p' },
          { label: '2160p (4K)', value: '2160p' },
        ],
      },
      {
        key: 'noise_scale',
        label: 'Noise Scale',
        type: 'float',
        required: false,
        default: 0.1,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        key: 'output_quality',
        label: 'Output Quality',
        type: 'enum',
        required: false,
        default: 'high',
        options: [
          { label: 'Low', value: 'low' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
          { label: 'Maximum', value: 'maximum' },
        ],
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

  'seedvr2-upscale': {
    id: 'seedvr2-upscale',
    displayName: 'SeedVR2 Upscale',
    category: 'transform',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/seedvr/upscale/image',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Upscaled Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'upscale_mode',
        label: 'Mode',
        type: 'enum',
        required: false,
        default: 'factor',
        options: [
          { label: 'Factor', value: 'factor' },
          { label: 'Target Resolution', value: 'target' },
        ],
      },
      {
        key: 'upscale_factor',
        label: 'Factor',
        type: 'float',
        required: false,
        default: 2,
        min: 1,
        max: 4,
        step: 0.5,
        visibleWhen: { upscale_mode: ['factor'] },
      },
      {
        key: 'target_resolution',
        label: 'Target Resolution',
        type: 'enum',
        required: false,
        default: '1080p',
        visibleWhen: { upscale_mode: ['target'] },
        options: [
          { label: '720p', value: '720p' },
          { label: '1080p', value: '1080p' },
          { label: '1440p', value: '1440p' },
          { label: '2160p (4K)', value: '2160p' },
        ],
      },
      {
        key: 'noise_scale',
        label: 'Noise Scale',
        type: 'float',
        required: false,
        default: 0.1,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        key: 'output_format',
        label: 'Format',
        type: 'enum',
        required: false,
        default: 'jpg',
        options: [
          { label: 'JPG', value: 'jpg' },
          { label: 'PNG', value: 'png' },
          { label: 'WebP', value: 'webp' },
        ],
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

  'seedream-4-5': {
    id: 'seedream-4-5',
    displayName: 'Seedream 4.5',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/bytedance/seedream/v4.5/text-to-image',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'images', label: 'References', dataType: 'Image', required: false, multiple: true, maxConnections: 10 },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: '4.5',
        options: [
          { label: 'Seedream 4.5', value: '4.5' },
          { label: 'Seedream 5.0 Lite', value: '5.0-lite' },
        ],
      },
      {
        key: 'image_size',
        label: 'Size',
        type: 'enum',
        required: false,
        default: 'square_hd',
        options: [
          { label: 'Square HD (2048x2048)', value: 'square_hd' },
          { label: 'Square (512x512)', value: 'square' },
          { label: 'Portrait 4:3', value: 'portrait_4_3' },
          { label: 'Portrait 16:9', value: 'portrait_16_9' },
          { label: 'Landscape 4:3', value: 'landscape_4_3' },
          { label: 'Landscape 16:9', value: 'landscape_16_9' },
          { label: 'Auto 2K', value: 'auto_2K' },
          { label: 'Auto 4K', value: 'auto_4K' },
          { label: 'Auto 3K', value: 'auto_3K', visibleWhen: { model: ['5.0-lite'] } },
        ],
      },
      {
        key: 'num_images',
        label: 'Generations',
        type: 'integer',
        required: false,
        default: 1,
        min: 1,
        max: 6,
      },
      {
        key: 'max_images',
        label: 'Images per Generation',
        type: 'integer',
        required: false,
        default: 1,
        min: 1,
        max: 6,
      },
      {
        key: 'enable_safety_checker',
        label: 'Safety Checker',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'seed',
        visibleWhen: { model: ['4.5'] },
        label: 'Seed',
        type: 'integer',
        required: false,
        placeholder: 'Random',
      },
    ],
  },

  'ideogram-v4': {
    id: 'ideogram-v4',
    displayName: 'Ideogram 4',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'ideogram/v4',
    envKeyName: ['IDEOGRAM_API_KEY', 'FAL_KEY'],
    executionPattern: 'async-poll',
    directKeyName: 'IDEOGRAM_API_KEY',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [],
    sharedParams: [],
    falParams: [
      {
        key: 'rendering_speed',
        label: 'Rendering Speed',
        type: 'enum',
        required: false,
        default: 'BALANCED',
        options: [
          { label: 'Turbo', value: 'TURBO' },
          { label: 'Balanced', value: 'BALANCED' },
          { label: 'Quality', value: 'QUALITY' },
        ],
      },
      {
        key: 'image_size',
        label: 'Size',
        type: 'enum',
        required: false,
        default: 'square_hd',
        options: [
          { label: 'Square HD', value: 'square_hd' },
          { label: 'Square', value: 'square' },
          { label: 'Portrait 4:3', value: 'portrait_4_3' },
          { label: 'Portrait 16:9', value: 'portrait_16_9' },
          { label: 'Landscape 4:3', value: 'landscape_4_3' },
          { label: 'Landscape 16:9', value: 'landscape_16_9' },
        ],
      },
      {
        key: 'expansion_model',
        label: 'Prompt Expansion',
        type: 'enum',
        required: false,
        default: 'Medium',
        options: [
          { label: 'None (no expansion fee)', value: 'None' },
          { label: 'Medium', value: 'Medium' },
          { label: 'Large', value: 'Large' },
        ],
      },
      {
        key: 'acceleration',
        label: 'Acceleration',
        type: 'enum',
        required: false,
        default: 'none',
        options: [
          { label: 'None', value: 'none' },
          { label: 'Low', value: 'low' },
          { label: 'Regular', value: 'regular' },
          { label: 'High', value: 'high' },
        ],
      },
      {
        key: 'num_images',
        label: 'Images',
        type: 'integer',
        required: false,
        default: 1,
        min: 1,
        max: 4,
      },
      {
        key: 'output_format',
        label: 'Format',
        type: 'enum',
        required: false,
        default: 'png',
        options: [
          { label: 'PNG', value: 'png' },
          { label: 'JPEG', value: 'jpeg' },
        ],
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        placeholder: 'Random',
      },
      {
        key: 'enable_safety_checker',
        label: 'Safety Checker',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
    directParams: [
      {
        key: 'resolution',
        label: 'Resolution (2K)',
        type: 'enum',
        required: false,
        default: '2048x2048',
        options: [
          { label: '2048x2048', value: '2048x2048' },
          { label: '1440x2880', value: '1440x2880' },
          { label: '2880x1440', value: '2880x1440' },
          { label: '1664x2496', value: '1664x2496' },
          { label: '2496x1664', value: '2496x1664' },
          { label: '1792x2240', value: '1792x2240' },
          { label: '2240x1792', value: '2240x1792' },
          { label: '1440x2560', value: '1440x2560' },
          { label: '2560x1440', value: '2560x1440' },
          { label: '1600x2560', value: '1600x2560' },
          { label: '2560x1600', value: '2560x1600' },
          { label: '1728x2304', value: '1728x2304' },
          { label: '2304x1728', value: '2304x1728' },
          { label: '1296x3168', value: '1296x3168' },
          { label: '3168x1296', value: '3168x1296' },
          { label: '1152x2944', value: '1152x2944' },
          { label: '2944x1152', value: '2944x1152' },
          { label: '1248x3328', value: '1248x3328' },
          { label: '3328x1248', value: '3328x1248' },
          { label: '1280x3072', value: '1280x3072' },
          { label: '3072x1280', value: '3072x1280' },
          { label: '1024x3072', value: '1024x3072' },
          { label: '3072x1024', value: '3072x1024' },
        ],
      },
      {
        key: 'rendering_speed',
        label: 'Rendering Speed',
        type: 'enum',
        required: false,
        default: 'DEFAULT',
        options: [
          { label: 'Turbo', value: 'TURBO' },
          { label: 'Default', value: 'DEFAULT' },
          { label: 'Quality', value: 'QUALITY' },
        ],
      },
      {
        key: 'enable_copyright_detection',
        label: 'Copyright Detection',
        type: 'boolean',
        required: false,
        default: false,
      },
    ],
  },

  'ideogram-edit': {
    id: 'ideogram-edit',
    displayName: 'Ideogram Edit (Inpaint)',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/ideogram/v3/edit',
    envKeyName: ['IDEOGRAM_API_KEY', 'FAL_KEY'],
    executionPattern: 'async-poll',
    directKeyName: 'IDEOGRAM_API_KEY',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'image', label: 'Base Image', dataType: 'Image', required: true, role: 'subject' },
      { id: 'mask', label: 'Mask (black = edit)', dataType: 'Image', required: true },
      { id: 'images', label: 'Style Refs', dataType: 'Image', required: false, multiple: true, role: 'style' },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [],
    sharedParams: [
      {
        key: 'num_images',
        label: 'Images',
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
    ],
    falParams: [
      {
        key: 'rendering_speed',
        label: 'Rendering Speed',
        type: 'enum',
        required: false,
        default: 'BALANCED',
        options: [
          { label: 'Turbo', value: 'TURBO' },
          { label: 'Balanced', value: 'BALANCED' },
          { label: 'Quality', value: 'QUALITY' },
        ],
      },
      {
        key: 'expand_prompt',
        label: 'Magic Prompt',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
    directParams: [
      {
        key: 'rendering_speed',
        label: 'Rendering Speed',
        type: 'enum',
        required: false,
        default: 'DEFAULT',
        options: [
          { label: 'Turbo', value: 'TURBO' },
          { label: 'Default', value: 'DEFAULT' },
          { label: 'Quality', value: 'QUALITY' },
        ],
      },
      {
        key: 'magic_prompt',
        label: 'Magic Prompt',
        type: 'enum',
        required: false,
        default: 'AUTO',
        options: [
          { label: 'Auto', value: 'AUTO' },
          { label: 'On', value: 'ON' },
          { label: 'Off', value: 'OFF' },
        ],
      },
    ],
  },

  'ideogram-remix': {
    id: 'ideogram-remix',
    displayName: 'Ideogram Remix',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/ideogram/v3/remix',
    envKeyName: ['IDEOGRAM_API_KEY', 'FAL_KEY'],
    executionPattern: 'async-poll',
    directKeyName: 'IDEOGRAM_API_KEY',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'image', label: 'Source Image', dataType: 'Image', required: true, role: 'subject' },
      { id: 'images', label: 'Style Refs', dataType: 'Image', required: false, multiple: true, role: 'style' },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [],
    sharedParams: [],
    falParams: [
      {
        key: 'strength',
        label: 'Image Strength',
        type: 'float',
        required: false,
        default: 0.8,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        key: 'image_size',
        label: 'Size',
        type: 'enum',
        required: false,
        default: 'square_hd',
        options: [
          { label: 'Square HD', value: 'square_hd' },
          { label: 'Square', value: 'square' },
          { label: 'Portrait 4:3', value: 'portrait_4_3' },
          { label: 'Portrait 16:9', value: 'portrait_16_9' },
          { label: 'Landscape 4:3', value: 'landscape_4_3' },
          { label: 'Landscape 16:9', value: 'landscape_16_9' },
        ],
      },
      {
        key: 'style',
        label: 'Style',
        type: 'enum',
        required: false,
        default: 'AUTO',
        options: [
          { label: 'Auto', value: 'AUTO' },
          { label: 'General', value: 'GENERAL' },
          { label: 'Realistic', value: 'REALISTIC' },
          { label: 'Design', value: 'DESIGN' },
        ],
      },
      {
        key: 'negative_prompt',
        label: 'Negative Prompt',
        type: 'string',
        required: false,
        placeholder: 'What to avoid',
      },
      {
        key: 'rendering_speed',
        label: 'Rendering Speed',
        type: 'enum',
        required: false,
        default: 'BALANCED',
        options: [
          { label: 'Turbo', value: 'TURBO' },
          { label: 'Balanced', value: 'BALANCED' },
          { label: 'Quality', value: 'QUALITY' },
        ],
      },
      {
        key: 'expand_prompt',
        label: 'Magic Prompt',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'num_images',
        label: 'Images',
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
    ],
    directParams: [
      {
        key: 'image_weight',
        label: 'Image Weight',
        type: 'integer',
        required: false,
        min: 1,
        max: 100,
        placeholder: 'Auto (from prompt)',
      },
      {
        key: 'resolution',
        label: 'Resolution (2K)',
        type: 'enum',
        required: false,
        default: '',
        options: [
          { label: 'Auto', value: '' },
          { label: '2048x2048', value: '2048x2048' },
          { label: '1440x2880', value: '1440x2880' },
          { label: '2880x1440', value: '2880x1440' },
          { label: '1664x2496', value: '1664x2496' },
          { label: '2496x1664', value: '2496x1664' },
          { label: '1792x2240', value: '1792x2240' },
          { label: '2240x1792', value: '2240x1792' },
          { label: '1440x2560', value: '1440x2560' },
          { label: '2560x1440', value: '2560x1440' },
          { label: '1600x2560', value: '1600x2560' },
          { label: '2560x1600', value: '2560x1600' },
          { label: '1728x2304', value: '1728x2304' },
          { label: '2304x1728', value: '2304x1728' },
          { label: '1296x3168', value: '1296x3168' },
          { label: '3168x1296', value: '3168x1296' },
          { label: '1152x2944', value: '1152x2944' },
          { label: '2944x1152', value: '2944x1152' },
          { label: '1248x3328', value: '1248x3328' },
          { label: '3328x1248', value: '3328x1248' },
          { label: '1280x3072', value: '1280x3072' },
          { label: '3072x1280', value: '3072x1280' },
          { label: '1024x3072', value: '1024x3072' },
          { label: '3072x1024', value: '3072x1024' },
        ],
      },
      {
        key: 'rendering_speed',
        label: 'Rendering Speed',
        type: 'enum',
        required: false,
        default: 'DEFAULT',
        options: [
          { label: 'Turbo', value: 'TURBO' },
          { label: 'Default', value: 'DEFAULT' },
          { label: 'Quality', value: 'QUALITY' },
        ],
      },
      {
        key: 'enable_copyright_detection',
        label: 'Copyright Detection',
        type: 'boolean',
        required: false,
        default: false,
      },
    ],
  },

  'ideogram-reframe': {
    id: 'ideogram-reframe',
    displayName: 'Ideogram Reframe (Outpaint)',
    category: 'transform',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/ideogram/v3/reframe',
    envKeyName: ['IDEOGRAM_API_KEY', 'FAL_KEY'],
    executionPattern: 'async-poll',
    directKeyName: 'IDEOGRAM_API_KEY',
    inputPorts: [
      { id: 'image', label: 'Source Image', dataType: 'Image', required: true, role: 'subject' },
      { id: 'images', label: 'Style Refs', dataType: 'Image', required: false, multiple: true, role: 'style' },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [],
    sharedParams: [
      {
        key: 'num_images',
        label: 'Images',
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
    ],
    falParams: [
      {
        key: 'image_size',
        label: 'Target Size',
        type: 'enum',
        required: true,
        default: 'square_hd',
        options: [
          { label: 'Square HD', value: 'square_hd' },
          { label: 'Square', value: 'square' },
          { label: 'Portrait 4:3', value: 'portrait_4_3' },
          { label: 'Portrait 16:9', value: 'portrait_16_9' },
          { label: 'Landscape 4:3', value: 'landscape_4_3' },
          { label: 'Landscape 16:9', value: 'landscape_16_9' },
        ],
      },
      {
        key: 'style',
        label: 'Style',
        type: 'enum',
        required: false,
        default: 'AUTO',
        options: [
          { label: 'Auto', value: 'AUTO' },
          { label: 'General', value: 'GENERAL' },
          { label: 'Realistic', value: 'REALISTIC' },
          { label: 'Design', value: 'DESIGN' },
        ],
      },
      {
        key: 'rendering_speed',
        label: 'Rendering Speed',
        type: 'enum',
        required: false,
        default: 'BALANCED',
        options: [
          { label: 'Turbo', value: 'TURBO' },
          { label: 'Balanced', value: 'BALANCED' },
          { label: 'Quality', value: 'QUALITY' },
        ],
      },
    ],
    directParams: [
      {
        key: 'resolution',
        label: 'Target Resolution',
        type: 'enum',
        required: true,
        default: '1024x1024',
        options: [
          { label: '1024x1024', value: '1024x1024' },
          { label: '1280x800', value: '1280x800' },
          { label: '800x1280', value: '800x1280' },
          { label: '1344x768', value: '1344x768' },
          { label: '768x1344', value: '768x1344' },
          { label: '1152x896', value: '1152x896' },
          { label: '896x1152', value: '896x1152' },
          { label: '1216x832', value: '1216x832' },
          { label: '832x1216', value: '832x1216' },
          { label: '1536x640', value: '1536x640' },
        ],
      },
      {
        key: 'rendering_speed',
        label: 'Rendering Speed',
        type: 'enum',
        required: false,
        default: 'DEFAULT',
        options: [
          { label: 'Turbo', value: 'TURBO' },
          { label: 'Default', value: 'DEFAULT' },
          { label: 'Quality', value: 'QUALITY' },
        ],
      },
    ],
  },

  'ideogram-replace-background': {
    id: 'ideogram-replace-background',
    displayName: 'Ideogram Replace Background',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/ideogram/v3/replace-background',
    envKeyName: ['IDEOGRAM_API_KEY', 'FAL_KEY'],
    executionPattern: 'async-poll',
    directKeyName: 'IDEOGRAM_API_KEY',
    inputPorts: [
      { id: 'prompt', label: 'New Background', dataType: 'Text', required: true },
      { id: 'image', label: 'Subject Image', dataType: 'Image', required: true, role: 'subject' },
      { id: 'images', label: 'Style Refs', dataType: 'Image', required: false, multiple: true, role: 'style' },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [],
    sharedParams: [
      {
        key: 'num_images',
        label: 'Images',
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
    ],
    falParams: [
      {
        key: 'style',
        label: 'Style',
        type: 'enum',
        required: false,
        default: 'AUTO',
        options: [
          { label: 'Auto', value: 'AUTO' },
          { label: 'General', value: 'GENERAL' },
          { label: 'Realistic', value: 'REALISTIC' },
          { label: 'Design', value: 'DESIGN' },
        ],
      },
      {
        key: 'rendering_speed',
        label: 'Rendering Speed',
        type: 'enum',
        required: false,
        default: 'BALANCED',
        options: [
          { label: 'Turbo', value: 'TURBO' },
          { label: 'Balanced', value: 'BALANCED' },
          { label: 'Quality', value: 'QUALITY' },
        ],
      },
      {
        key: 'expand_prompt',
        label: 'Magic Prompt',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
    directParams: [
      {
        key: 'magic_prompt',
        label: 'Magic Prompt',
        type: 'enum',
        required: false,
        default: 'AUTO',
        options: [
          { label: 'Auto', value: 'AUTO' },
          { label: 'On', value: 'ON' },
          { label: 'Off', value: 'OFF' },
        ],
      },
      {
        key: 'rendering_speed',
        label: 'Rendering Speed',
        type: 'enum',
        required: false,
        default: 'DEFAULT',
        options: [
          { label: 'Turbo', value: 'TURBO' },
          { label: 'Default', value: 'DEFAULT' },
          { label: 'Quality', value: 'QUALITY' },
        ],
      },
    ],
  },

  'ideogram-character': {
    id: 'ideogram-character',
    displayName: 'Ideogram Character',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/ideogram/character',
    envKeyName: ['IDEOGRAM_API_KEY', 'FAL_KEY'],
    executionPattern: 'async-poll',
    directKeyName: 'IDEOGRAM_API_KEY',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'character', label: 'Character', dataType: 'Character', required: false },
      { id: 'reference_images', label: 'Character Refs', dataType: 'Image', required: false, multiple: true, role: 'identity' },
      { id: 'images', label: 'Style Refs', dataType: 'Image', required: false, multiple: true, role: 'style' },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [],
    sharedParams: [
      {
        key: 'negative_prompt',
        label: 'Negative Prompt',
        type: 'string',
        required: false,
        placeholder: 'What to avoid',
      },
      {
        key: 'num_images',
        label: 'Images',
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
    ],
    falParams: [
      {
        key: 'style',
        label: 'Style',
        type: 'enum',
        required: false,
        default: 'AUTO',
        options: [
          { label: 'Auto', value: 'AUTO' },
          { label: 'Realistic', value: 'REALISTIC' },
          { label: 'Fiction', value: 'FICTION' },
        ],
      },
      {
        key: 'image_size',
        label: 'Size',
        type: 'enum',
        required: false,
        default: 'square_hd',
        options: [
          { label: 'Square HD', value: 'square_hd' },
          { label: 'Square', value: 'square' },
          { label: 'Portrait 4:3', value: 'portrait_4_3' },
          { label: 'Portrait 16:9', value: 'portrait_16_9' },
          { label: 'Landscape 4:3', value: 'landscape_4_3' },
          { label: 'Landscape 16:9', value: 'landscape_16_9' },
        ],
      },
      {
        key: 'rendering_speed',
        label: 'Rendering Speed',
        type: 'enum',
        required: false,
        default: 'BALANCED',
        options: [
          { label: 'Turbo', value: 'TURBO' },
          { label: 'Balanced', value: 'BALANCED' },
          { label: 'Quality', value: 'QUALITY' },
        ],
      },
      {
        key: 'expand_prompt',
        label: 'Magic Prompt',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
    directParams: [
      {
        key: 'aspect_ratio',
        label: 'Aspect Ratio',
        type: 'enum',
        required: false,
        default: '1x1',
        options: [
          { label: '1:1', value: '1x1' },
          { label: '16:9', value: '16x9' },
          { label: '9:16', value: '9x16' },
          { label: '4:3', value: '4x3' },
          { label: '3:4', value: '3x4' },
          { label: '3:2', value: '3x2' },
          { label: '2:3', value: '2x3' },
          { label: '16:10', value: '16x10' },
          { label: '10:16', value: '10x16' },
          { label: '5:4', value: '5x4' },
          { label: '4:5', value: '4x5' },
          { label: '2:1', value: '2x1' },
          { label: '1:2', value: '1x2' },
          { label: '3:1', value: '3x1' },
          { label: '1:3', value: '1x3' },
        ],
      },
      {
        key: 'style_type',
        label: 'Style Type',
        type: 'enum',
        required: false,
        default: 'AUTO',
        options: [
          { label: 'Auto', value: 'AUTO' },
          { label: 'Realistic', value: 'REALISTIC' },
          { label: 'Fiction', value: 'FICTION' },
        ],
      },
      {
        key: 'magic_prompt',
        label: 'Magic Prompt',
        type: 'enum',
        required: false,
        default: 'AUTO',
        options: [
          { label: 'Auto', value: 'AUTO' },
          { label: 'On', value: 'ON' },
          { label: 'Off', value: 'OFF' },
        ],
      },
      {
        key: 'rendering_speed',
        label: 'Rendering Speed',
        type: 'enum',
        required: false,
        default: 'DEFAULT',
        options: [
          { label: 'Turbo', value: 'TURBO' },
          { label: 'Default', value: 'DEFAULT' },
          { label: 'Quality', value: 'QUALITY' },
        ],
      },
      {
        key: 'custom_model_uri',
        label: 'Custom Model URI',
        type: 'string',
        required: false,
        placeholder: 'From an Ideogram Train Model node',
      },
    ],
  },

  'ideogram-upscale': {
    id: 'ideogram-upscale',
    displayName: 'Ideogram Upscale',
    category: 'transform',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/ideogram/upscale',
    envKeyName: ['IDEOGRAM_API_KEY', 'FAL_KEY'],
    executionPattern: 'async-poll',
    directKeyName: 'IDEOGRAM_API_KEY',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
      { id: 'prompt', label: 'Guidance (optional)', dataType: 'Text', required: false },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [],
    sharedParams: [
      {
        key: 'resemblance',
        label: 'Resemblance',
        type: 'integer',
        required: false,
        default: 50,
        min: 1,
        max: 100,
      },
      {
        key: 'detail',
        label: 'Detail',
        type: 'integer',
        required: false,
        default: 50,
        min: 1,
        max: 100,
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        placeholder: 'Random',
      },
    ],
    falParams: [
      {
        key: 'expand_prompt',
        label: 'Magic Prompt',
        type: 'boolean',
        required: false,
        default: false,
      },
    ],
    directParams: [
      {
        key: 'magic_prompt',
        label: 'Magic Prompt',
        type: 'enum',
        required: false,
        default: 'AUTO',
        options: [
          { label: 'Auto', value: 'AUTO' },
          { label: 'On', value: 'ON' },
          { label: 'Off', value: 'OFF' },
        ],
      },
    ],
  },

  'ideogram-describe': {
    id: 'ideogram-describe',
    displayName: 'Ideogram Describe',
    category: 'analyzer',
    apiProvider: 'ideogram',
    apiEndpoint: '/v1/ideogram-v4/describe',
    envKeyName: 'IDEOGRAM_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
    ],
    outputPorts: [
      { id: 'description', label: 'Description', dataType: 'Text', required: false },
      { id: 'json_prompt', label: 'JSON Prompt (v4)', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'include_bbox',
        label: 'Include Layout (bbox)',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
  },

  'ideogram-magic-prompt': {
    id: 'ideogram-magic-prompt',
    displayName: 'Ideogram Magic Prompt',
    category: 'text-gen',
    apiProvider: 'ideogram',
    apiEndpoint: '/v1/ideogram-v4/magic-prompt',
    envKeyName: 'IDEOGRAM_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'description', label: 'Expanded Prompt', dataType: 'Text', required: false },
      { id: 'json_prompt', label: 'JSON Prompt (v4)', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'aspect_ratio',
        label: 'Aspect Ratio',
        type: 'enum',
        required: false,
        default: 'AUTO',
        options: [
          { label: 'AUTO', value: 'AUTO' },
          { label: '1:1', value: '1x1' },
          { label: '16:9', value: '16x9' },
          { label: '9:16', value: '9x16' },
          { label: '4:3', value: '4x3' },
          { label: '3:4', value: '3x4' },
          { label: '3:2', value: '3x2' },
          { label: '2:3', value: '2x3' },
          { label: '16:10', value: '16x10' },
          { label: '10:16', value: '10x16' },
          { label: '5:4', value: '5x4' },
          { label: '4:5', value: '4x5' },
          { label: '2:1', value: '2x1' },
          { label: '1:2', value: '1x2' },
          { label: '3:1', value: '3x1' },
          { label: '1:3', value: '1x3' },
          { label: '1:4', value: '1x4' },
          { label: '4:1', value: '4x1' },
        ],
      },
    ],
  },

  'ideogram-transparent': {
    id: 'ideogram-transparent',
    displayName: 'Ideogram Transparent',
    category: 'image-gen',
    apiProvider: 'ideogram',
    apiEndpoint: '/v1/ideogram-v3/generate-transparent',
    envKeyName: 'IDEOGRAM_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image (alpha)', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'aspect_ratio',
        label: 'Aspect Ratio',
        type: 'enum',
        required: false,
        default: '1x1',
        options: [
          { label: '1:1', value: '1x1' },
          { label: '16:9', value: '16x9' },
          { label: '9:16', value: '9x16' },
          { label: '4:3', value: '4x3' },
          { label: '3:4', value: '3x4' },
          { label: '3:2', value: '3x2' },
          { label: '2:3', value: '2x3' },
          { label: '16:10', value: '16x10' },
          { label: '10:16', value: '10x16' },
          { label: '5:4', value: '5x4' },
          { label: '4:5', value: '4x5' },
          { label: '2:1', value: '2x1' },
          { label: '1:2', value: '1x2' },
          { label: '3:1', value: '3x1' },
          { label: '1:3', value: '1x3' },
        ],
      },
      {
        key: 'upscale_factor',
        label: 'Upscale',
        type: 'enum',
        required: false,
        default: 'X1',
        options: [
          { label: '1x', value: 'X1' },
          { label: '2x', value: 'X2' },
          { label: '4x', value: 'X4' },
        ],
      },
      {
        key: 'rendering_speed',
        label: 'Rendering Speed',
        type: 'enum',
        required: false,
        default: 'DEFAULT',
        options: [
          { label: 'Turbo', value: 'TURBO' },
          { label: 'Default', value: 'DEFAULT' },
          { label: 'Quality', value: 'QUALITY' },
        ],
      },
      {
        key: 'magic_prompt',
        label: 'Magic Prompt',
        type: 'enum',
        required: false,
        default: 'AUTO',
        options: [
          { label: 'Auto', value: 'AUTO' },
          { label: 'On', value: 'ON' },
          { label: 'Off', value: 'OFF' },
        ],
      },
      {
        key: 'negative_prompt',
        label: 'Negative Prompt',
        type: 'string',
        required: false,
        placeholder: 'What to avoid',
      },
      {
        key: 'num_images',
        label: 'Images',
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
    ],
  },

  'ideogram-remove-background': {
    id: 'ideogram-remove-background',
    displayName: 'Ideogram Remove BG',
    category: 'transform',
    apiProvider: 'ideogram',
    apiEndpoint: '/v1/remove-background',
    envKeyName: 'IDEOGRAM_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image (alpha)', dataType: 'Image', required: false },
    ],
    params: [],
  },

  'ideogram-layerize': {
    id: 'ideogram-layerize',
    displayName: 'Ideogram Layerize Text',
    category: 'transform',
    apiProvider: 'ideogram',
    apiEndpoint: '/v1/ideogram-v3/layerize-text',
    envKeyName: 'IDEOGRAM_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
      { id: 'prompt', label: 'Guidance (optional)', dataType: 'Text', required: false },
    ],
    outputPorts: [
      { id: 'image', label: 'Base Plate (text removed)', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        placeholder: 'Random',
      },
    ],
  },

  'ideogram-edit-prompt': {
    id: 'ideogram-edit-prompt',
    displayName: 'Ideogram Edit (Prompt)',
    category: 'image-gen',
    apiProvider: 'ideogram',
    apiEndpoint: '/v1/edit',
    envKeyName: 'IDEOGRAM_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'prompt', label: 'Edit Instruction', dataType: 'Text', required: true },
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
      { id: 'images', label: 'Images', dataType: 'Image', required: false, multiple: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'magic_prompt',
        label: 'Magic Prompt',
        type: 'enum',
        required: false,
        default: 'AUTO',
        options: [
          { label: 'Auto', value: 'AUTO' },
          { label: 'On', value: 'ON' },
          { label: 'Off', value: 'OFF' },
        ],
      },
      {
        key: 'aspect_ratio',
        label: 'Aspect Ratio',
        type: 'enum',
        required: false,
        default: '',
        options: [
          { label: 'Keep input', value: '' },
          { label: '1:1', value: '1x1' },
          { label: '16:9', value: '16x9' },
          { label: '9:16', value: '9x16' },
          { label: '4:3', value: '4x3' },
          { label: '3:4', value: '3x4' },
          { label: '3:2', value: '3x2' },
          { label: '2:3', value: '2x3' },
          { label: '16:10', value: '16x10' },
          { label: '10:16', value: '10x16' },
          { label: '5:4', value: '5x4' },
          { label: '4:5', value: '4x5' },
          { label: '2:1', value: '2x1' },
          { label: '1:2', value: '1x2' },
          { label: '3:1', value: '3x1' },
          { label: '1:3', value: '1x3' },
        ],
      },
      {
        key: 'transparent_background',
        label: 'Transparent Background',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'num_images',
        label: 'Images',
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
    ],
  },

  'ideogram-train-model': {
    id: 'ideogram-train-model',
    displayName: 'Ideogram Train Model',
    category: 'image-gen',
    apiProvider: 'ideogram',
    apiEndpoint: '/v1/ideogram-v3/train-model',
    envKeyName: 'IDEOGRAM_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'images', label: 'Training Images', dataType: 'Image', required: true, multiple: true },
    ],
    outputPorts: [
      { id: 'custom_model_uri', label: 'Custom Model URI', dataType: 'Text', required: false },
      { id: 'model_id', label: 'Model ID', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'model_name',
        label: 'Model Name',
        type: 'string',
        required: true,
        placeholder: 'my-brand-style',
      },
    ],
  },

  'mask-painter': {
    id: 'mask-painter',
    displayName: 'Mask Painter',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
    ],
    outputPorts: [
      { id: 'mask', label: 'Mask', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'polarity',
        label: 'Painted Area Means',
        type: 'enum',
        required: false,
        default: 'white-edit',
        options: [
          { label: 'White = edit (FLUX Fill)', value: 'white-edit' },
          { label: 'Black = edit (Ideogram)', value: 'black-edit' },
        ],
      },
    ],
  },

  'svg-rasterize': {
    id: 'svg-rasterize',
    displayName: 'SVG Rasterize',
    category: 'transform',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      { id: 'svg', label: 'SVG', dataType: 'SVG', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'width',
        label: 'Width',
        type: 'integer',
        required: false,
        default: 1024,
        min: 64,
        max: 4096,
      },
      {
        key: 'height',
        label: 'Height',
        type: 'integer',
        required: false,
        default: 1024,
        min: 64,
        max: 4096,
      },
      {
        key: 'background',
        label: 'Background',
        type: 'enum',
        required: false,
        default: 'transparent',
        options: [
          { label: 'Transparent', value: 'transparent' },
          { label: 'White', value: 'white' },
        ],
      },
    ],
  },

  'batch': {
    id: 'batch',
    displayName: 'Batch',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    capabilityNote: 'Runs each text item through the downstream workflow when you press Run. Each model may charge per item; the item cap limits expansion.',
    inputPorts: [],
    outputPorts: [
      { id: 'set', label: 'Items', dataType: 'Text', required: false },
    ],
    params: [
      { key: 'display_name', label: 'Name', type: 'string', required: false, default: 'Batch', placeholder: 'colors' },
      { key: 'items_text', label: 'Items', type: 'textarea', required: false, default: '', placeholder: 'one item per line' },
      {
        key: 'split_mode', label: 'Split mode', type: 'enum', required: false, default: 'by_line',
        options: [
          { label: 'By line (one item per line)', value: 'by_line' },
          { label: 'None (entire text is one item)', value: 'none' },
        ],
      },
      { key: 'batch_size_cap', label: 'Item cap', type: 'integer', required: false, default: 10, min: 1, max: 25 },
    ],
  },

  'iterator-image': {
    id: 'iterator-image',
    displayName: 'Image Iterator',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      { id: 'array', label: 'Images', dataType: 'Array', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'batch_size_cap',
        label: 'Batch Size Cap',
        type: 'integer',
        required: false,
        default: 10,
        min: 1,
        max: 25,
      },
    ],
  },

  'iterator-text': {
    id: 'iterator-text',
    displayName: 'Text Iterator',
    category: 'utility',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      { id: 'array', label: 'Texts', dataType: 'Array', required: true },
    ],
    outputPorts: [
      { id: 'text', label: 'Text', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'batch_size_cap',
        label: 'Batch Size Cap',
        type: 'integer',
        required: false,
        default: 10,
        min: 1,
        max: 25,
      },
    ],
  },

  'sync-lipsync': {
    id: 'sync-lipsync',
    displayName: 'Lipsync',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/sync-lipsync/v3',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: true },
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: true },
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
        default: 'sync-3',
        options: [
          { label: 'Sync 3', value: 'sync-3' },
          { label: 'Sync Lipsync v2 Pro', value: 'sync-lipsync-v2-pro' },
          { label: 'VEED Lipsync', value: 'veed-lipsync' },
        ],
      },
      {
        key: 'sync_mode',
        label: 'Sync Mode',
        type: 'enum',
        required: false,
        default: 'cut_off',
        options: [
          { label: 'Cut Off', value: 'cut_off' },
          { label: 'Loop', value: 'loop' },
          { label: 'Bounce', value: 'bounce' },
          { label: 'Silence', value: 'silence' },
          { label: 'Remap', value: 'remap' },
        ],
      },
    ],
  },
  'topaz-image-upscale': {
    id: 'topaz-image-upscale',
    displayName: 'Topaz Image Upscale',
    category: 'transform',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/topaz/upscale/image',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
      { id: 'prompt', label: 'Prompt (Redefine only)', dataType: 'Text', required: false },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'Standard V2',
        options: [
          { label: 'Standard V2', value: 'Standard V2' },
          { label: 'High Fidelity V2', value: 'High Fidelity V2' },
          { label: 'Low Resolution V2', value: 'Low Resolution V2' },
          { label: 'Recovery V2', value: 'Recovery V2' },
          { label: 'Redefine', value: 'Redefine' },
          { label: 'CGI', value: 'CGI' },
          { label: 'Text Refine', value: 'Text Refine' },
          { label: 'Recovery', value: 'Recovery' },
        ],
      },
      {
        key: 'face_enhancement',
        label: 'Face Enhancement',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'face_enhancement_strength',
        label: 'Face Enhancement Strength',
        type: 'float',
        required: false,
        default: 0.8,
        min: 0.0,
        max: 1.0,
      },
      {
        key: 'upscale_factor',
        label: 'Upscale Factor',
        type: 'float',
        required: false,
        default: 2.0,
        min: 1.0,
        max: 6.0,
      },
      {
        key: 'sharpen',
        label: 'Sharpen',
        type: 'float',
        required: false,
        default: 0.0,
        min: 0.0,
        max: 1.0,
      },
      {
        key: 'denoise',
        label: 'Denoise',
        type: 'float',
        required: false,
        default: 0.0,
        min: 0.0,
        max: 1.0,
      },
      {
        key: 'fix_compression',
        label: 'Fix Compression',
        type: 'float',
        required: false,
        default: 0.0,
        min: 0.0,
        max: 1.0,
      },
      {
        key: 'output_format',
        label: 'Output Format',
        type: 'enum',
        required: false,
        default: 'jpeg',
        options: [
          { label: 'JPEG', value: 'jpeg' },
          { label: 'PNG', value: 'png' },
        ],
      },
    ],
  },
  'veo-3-flf': {
    id: 'veo-3-flf',
    displayName: 'Veo 3.1 First-Last Frame',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/veo3.1/first-last-frame-to-video',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'image', label: 'First Frame', dataType: 'Image', required: true, role: 'subject' },
      { id: 'end_image', label: 'Last Frame', dataType: 'Image', required: true },
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
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '16:9', value: '16:9' },
          { label: '9:16', value: '9:16' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration',
        type: 'enum',
        required: false,
        default: '4s',
        options: [
          { label: '4s', value: '4s' },
          { label: '6s', value: '6s' },
          { label: '8s', value: '8s' },
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
          { label: '4K', value: '4k' },
        ],
      },
      {
        key: 'generate_audio',
        label: 'Generate Audio',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'negative_prompt',
        label: 'Negative Prompt',
        type: 'string',
        required: false,
        placeholder: 'What to avoid',
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        placeholder: 'Random',
      },
      {
        key: 'safety_tolerance',
        label: 'Safety Tolerance',
        type: 'enum',
        required: false,
        default: '2',
        options: [
          { label: '1 (Strict)', value: '1' },
          { label: '2', value: '2' },
          { label: '3', value: '3' },
          { label: '4', value: '4' },
          { label: '5', value: '5' },
          { label: '6 (Permissive)', value: '6' },
        ],
      },
    ],
  },

  'kling-pro': {
    id: 'kling-pro',
    displayName: 'Kling Pro I2V',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/kling-video/v2.6/pro/image-to-video',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'image', label: 'Start Image', dataType: 'Image', required: true, role: 'subject' },
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: false },
      { id: 'end_image', label: 'End Image', dataType: 'Image', required: false },
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
        default: 'v2.6-pro',
        options: [
          { label: 'Kling 2.6 Pro', value: 'v2.6-pro' },
          { label: 'Kling v3 Pro', value: 'v3-pro' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration',
        type: 'enum',
        required: false,
        default: '5',
        options: [
          { label: '3s', value: '3' },
          { label: '4s', value: '4' },
          { label: '5s', value: '5' },
          { label: '6s', value: '6' },
          { label: '7s', value: '7' },
          { label: '8s', value: '8' },
          { label: '9s', value: '9' },
          { label: '10s', value: '10' },
          { label: '11s', value: '11' },
          { label: '12s', value: '12' },
          { label: '13s', value: '13' },
          { label: '14s', value: '14' },
          { label: '15s', value: '15' },
        ],
      },
      {
        key: 'negative_prompt',
        label: 'Negative Prompt',
        type: 'string',
        required: false,
        default: 'blur, distort, and low quality',
      },
      {
        key: 'generate_audio',
        label: 'Generate Audio',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'cfg_scale',
        label: 'CFG Scale',
        type: 'float',
        required: false,
        default: 0.5,
        min: 0.0,
        max: 1.0,
      },
    ],
  },
  'kling-o3-ref': {
    id: 'kling-o3-ref',
    displayName: 'Kling O3 Pro Reference-to-Video',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/kling-video/o3/pro/reference-to-video',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'image', label: 'Start Image', dataType: 'Image', required: false, role: 'subject' },
      { id: 'end_image', label: 'End Image', dataType: 'Image', required: false },
      { id: 'images', label: 'Reference Images', dataType: 'Image', required: false, multiple: true, role: 'identity' },
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
          { label: '3 seconds', value: '3' },
          { label: '5 seconds', value: '5' },
          { label: '10 seconds', value: '10' },
          { label: '15 seconds', value: '15' },
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
      {
        key: 'generate_audio',
        label: 'Generate Audio',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'shot_type',
        label: 'Shot Type',
        type: 'enum',
        required: false,
        default: 'customize',
        options: [
          { label: 'Customize', value: 'customize' },
          { label: 'Intelligent', value: 'intelligent' },
        ],
      },
    ],
  },
  'kling-motion': {
    id: 'kling-motion',
    displayName: 'Kling v2.6 Pro Motion Control',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/kling-video/v2.6/pro/motion-control',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'image', label: 'Character Image', dataType: 'Image', required: true, role: 'identity' },
      { id: 'video', label: 'Motion Reference Video', dataType: 'Video', required: true },
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: false },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'character_orientation',
        label: 'Character Orientation',
        type: 'enum',
        required: true,
        default: 'video',
        options: [
          { label: 'Image', value: 'image' },
          { label: 'Video', value: 'video' },
        ],
      },
      {
        key: 'keep_original_sound',
        label: 'Keep Original Sound',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
  },
  'topaz-video-upscale': {
    id: 'topaz-video-upscale',
    displayName: 'Topaz Video Upscale',
    category: 'transform',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/topaz/upscale/video',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: true },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'Proteus',
        options: [
          { label: 'Proteus', value: 'Proteus' },
          { label: 'Artemis HQ', value: 'Artemis HQ' },
          { label: 'Artemis MQ', value: 'Artemis MQ' },
          { label: 'Artemis LQ', value: 'Artemis LQ' },
          { label: 'Nyx', value: 'Nyx' },
          { label: 'Nyx Fast', value: 'Nyx Fast' },
          { label: 'Nyx XL', value: 'Nyx XL' },
          { label: 'Nyx HF', value: 'Nyx HF' },
          { label: 'Gaia HQ', value: 'Gaia HQ' },
          { label: 'Gaia CG', value: 'Gaia CG' },
          { label: 'Iris', value: 'Iris' },
        ],
      },
      {
        key: 'upscale_factor',
        label: 'Upscale Factor',
        type: 'float',
        required: false,
        default: 2.0,
        min: 1.0,
        max: 4.0,
      },
      {
        key: 'target_fps',
        label: 'Target FPS',
        type: 'integer',
        required: false,
        min: 16,
        max: 120,
      },
      {
        key: 'compression',
        label: 'Compression',
        type: 'float',
        required: false,
        default: 0.0,
        min: 0.0,
        max: 1.0,
      },
      {
        key: 'noise',
        label: 'Noise',
        type: 'float',
        required: false,
        default: 0.0,
        min: 0.0,
        max: 1.0,
      },
      {
        key: 'halo',
        label: 'Halo',
        type: 'float',
        required: false,
        default: 0.0,
        min: 0.0,
        max: 1.0,
      },
      {
        key: 'grain',
        label: 'Grain',
        type: 'float',
        required: false,
        default: 0.0,
        min: 0.0,
        max: 1.0,
      },
      {
        key: 'recover_detail',
        label: 'Recover Detail',
        type: 'float',
        required: false,
        default: 0.0,
        min: 0.0,
        max: 1.0,
      },
      {
        key: 'H264_output',
        label: 'H264 Output',
        type: 'boolean',
        required: false,
        default: false,
      },
    ],
  },
  'grok-imagine-image': {
    id: 'grok-imagine-image',
    displayName: 'Grok Imagine Image',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'xai/grok-imagine-image',
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
        key: 'num_images',
        label: 'Number of Images',
        type: 'integer',
        required: false,
        default: 1,
        min: 1,
        max: 4,
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
          { label: '3:2', value: '3:2' },
          { label: '2:3', value: '2:3' },
          { label: '2:1', value: '2:1' },
          { label: '1:2', value: '1:2' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '1k',
        options: [
          { label: '1K', value: '1k' },
          { label: '2K', value: '2k' },
        ],
      },
      {
        key: 'output_format',
        label: 'Output Format',
        type: 'enum',
        required: false,
        default: 'jpeg',
        options: [
          { label: 'JPEG', value: 'jpeg' },
          { label: 'PNG', value: 'png' },
          { label: 'WebP', value: 'webp' },
        ],
      },
    ],
  },
  'grok-imagine-image-edit': {
    id: 'grok-imagine-image-edit',
    displayName: 'Grok Imagine Image Edit',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'xai/grok-imagine-image/edit',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'images', label: 'Source Images', dataType: 'Image', required: true, multiple: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'num_images',
        label: 'Number of Images',
        type: 'integer',
        required: false,
        default: 1,
        min: 1,
        max: 10,
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '1k',
        options: [
          { label: '1K', value: '1k' },
          { label: '2K', value: '2k' },
        ],
      },
      {
        key: 'output_format',
        label: 'Output Format',
        type: 'enum',
        required: false,
        default: 'jpeg',
        options: [
          { label: 'JPEG', value: 'jpeg' },
          { label: 'PNG', value: 'png' },
          { label: 'WebP', value: 'webp' },
        ],
      },
    ],
  },
  'sora-2-i2v': {
    id: 'sora-2-i2v',
    displayName: 'Sora 2 Image-to-Video',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/sora-2/image-to-video',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'image', label: 'Image', dataType: 'Image', required: true, role: 'subject' },
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
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '720p', value: '720p' },
        ],
      },
      {
        key: 'aspect_ratio',
        label: 'Aspect Ratio',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '9:16', value: '9:16' },
          { label: '16:9', value: '16:9' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration',
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
  'esrgan-upscale': {
    id: 'esrgan-upscale',
    displayName: 'Real-ESRGAN Upscale',
    category: 'transform',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/esrgan',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'RealESRGAN_x4plus',
        options: [
          { label: 'x4plus (General)', value: 'RealESRGAN_x4plus' },
          { label: 'x2plus (General)', value: 'RealESRGAN_x2plus' },
          { label: 'x4plus Anime 6B', value: 'RealESRGAN_x4plus_anime_6B' },
          { label: 'x4 v3 (General)', value: 'RealESRGAN_x4_v3' },
          { label: 'x4 WDN v3 (Denoise)', value: 'RealESRGAN_x4_wdn_v3' },
          { label: 'x4 Anime v3', value: 'RealESRGAN_x4_anime_v3' },
        ],
      },
      {
        key: 'scale',
        label: 'Scale',
        type: 'float',
        required: false,
        default: 2,
        min: 1,
        max: 8,
      },
      {
        key: 'face',
        label: 'Face Enhancement',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'tile',
        label: 'Tile Size (0=none)',
        type: 'integer',
        required: false,
        default: 0,
        min: 0,
        max: 1000,
      },
      {
        key: 'output_format',
        label: 'Output Format',
        type: 'enum',
        required: false,
        default: 'png',
        options: [
          { label: 'PNG', value: 'png' },
          { label: 'JPEG', value: 'jpeg' },
        ],
      },
    ],
  },
  'recraft-crisp-upscale': {
    id: 'recraft-crisp-upscale',
    displayName: 'Recraft Crisp Upscale',
    category: 'transform',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/recraft/upscale/crisp',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'enable_safety_checker',
        label: 'Safety Checker',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
  },
  'pika-i2v': {
    id: 'pika-i2v',
    displayName: 'Pika 2.2 Image-to-Video',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/pika/v2.2/image-to-video',
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
        key: 'duration',
        label: 'Duration',
        type: 'enum',
        required: false,
        default: 5,
        options: [
          { label: '5s', value: 5 },
          { label: '10s', value: 10 },
        ],
      },
      {
        key: 'negative_prompt',
        label: 'Negative Prompt',
        type: 'string',
        required: false,
        default: '',
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        default: null,
        placeholder: 'Random',
      },
    ],
  },
  'hunyuan-video': {
    id: 'hunyuan-video',
    displayName: 'HunyuanVideo T2V',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/hunyuan-video',
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
        default: '720p',
        options: [
          { label: '480p', value: '480p' },
          { label: '580p', value: '580p' },
          { label: '720p', value: '720p' },
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
        key: 'num_frames',
        label: 'Number of Frames',
        type: 'enum',
        required: false,
        default: '129',
        options: [
          { label: '129 (~5s)', value: '129' },
          { label: '85 (~3.5s)', value: '85' },
        ],
      },
      {
        key: 'pro_mode',
        label: 'Pro Mode',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        default: null,
        placeholder: 'Random',
      },
      {
        key: 'enable_safety_checker',
        label: 'Safety Checker',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
  },
  'elevenlabs-music': {
    id: 'elevenlabs-music',
    displayName: 'ElevenLabs Music',
    category: 'audio-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/elevenlabs/music',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: false },
    ],
    params: [
      {
        key: 'music_length_ms',
        label: 'Duration (ms)',
        type: 'integer',
        required: false,
        default: 30000,
        min: 3000,
        max: 600000,
      },
      {
        key: 'force_instrumental',
        label: 'Instrumental Only',
        type: 'boolean',
        required: false,
        default: false,
      },
    ],
  },
  'wan-animate-move': {
    id: 'wan-animate-move',
    displayName: 'WAN 2.2 Animate Move',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/wan/v2.2-14b/animate/move',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true, role: 'identity' },
      { id: 'video', label: 'Video', dataType: 'Video', required: true },
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
        default: '480p',
        options: [
          { label: '480p', value: '480p' },
          { label: '580p', value: '580p' },
          { label: '720p', value: '720p' },
        ],
      },
      {
        key: 'guidance_scale',
        label: 'Guidance Scale',
        type: 'float',
        required: false,
        default: 1.0,
        min: 1.0,
        max: 20.0,
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        default: null,
        placeholder: 'Random',
      },
      {
        key: 'num_inference_steps',
        label: 'Inference Steps',
        type: 'integer',
        required: false,
        default: 20,
        min: 1,
        max: 50,
      },
      {
        key: 'enable_safety_checker',
        label: 'Safety Checker',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
  },
  'wan-animate-replace': {
    id: 'wan-animate-replace',
    displayName: 'WAN 2.2 Animate Replace',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/wan/v2.2-14b/animate/replace',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true, role: 'identity' },
      { id: 'video', label: 'Video', dataType: 'Video', required: true },
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
        default: '480p',
        options: [
          { label: '480p', value: '480p' },
          { label: '580p', value: '580p' },
          { label: '720p', value: '720p' },
        ],
      },
      {
        key: 'guidance_scale',
        label: 'Guidance Scale',
        type: 'float',
        required: false,
        default: 1.0,
        min: 1.0,
        max: 20.0,
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        default: null,
        placeholder: 'Random',
      },
      {
        key: 'num_inference_steps',
        label: 'Inference Steps',
        type: 'integer',
        required: false,
        default: 20,
        min: 1,
        max: 50,
      },
      {
        key: 'enable_safety_checker',
        label: 'Safety Checker',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
  },
  'kling-video-to-audio': {
    id: 'kling-video-to-audio',
    displayName: 'Kling Video-to-Audio',
    category: 'audio-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/kling-video/video-to-audio',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: true },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: false },
    ],
    params: [
      {
        key: 'sound_effect_prompt',
        label: 'Sound Effect Prompt',
        type: 'string',
        required: false,
        default: '',
      },
      {
        key: 'background_music_prompt',
        label: 'Background Music Prompt',
        type: 'string',
        required: false,
        default: '',
      },
      {
        key: 'asmr_mode',
        label: 'ASMR Mode',
        type: 'boolean',
        required: false,
        default: false,
      },
    ],
  },
  'seedance-1-0-t2v': {
    id: 'seedance-1-0-t2v',
    displayName: 'Seedance 1.0 Pro T2V',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/bytedance/seedance/v1/pro/text-to-video',
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
          { label: '21:9', value: '21:9' },
          { label: '16:9', value: '16:9' },
          { label: '4:3', value: '4:3' },
          { label: '1:1', value: '1:1' },
          { label: '3:4', value: '3:4' },
          { label: '9:16', value: '9:16' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '1080p',
        options: [
          { label: '480p', value: '480p' },
          { label: '720p', value: '720p' },
          { label: '1080p', value: '1080p' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration',
        type: 'enum',
        required: false,
        default: '5',
        options: [
          { label: '2s', value: '2' },
          { label: '3s', value: '3' },
          { label: '4s', value: '4' },
          { label: '5s', value: '5' },
          { label: '6s', value: '6' },
          { label: '7s', value: '7' },
          { label: '8s', value: '8' },
          { label: '9s', value: '9' },
          { label: '10s', value: '10' },
          { label: '11s', value: '11' },
          { label: '12s', value: '12' },
        ],
      },
      {
        key: 'camera_fixed',
        label: 'Camera Fixed',
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
      {
        key: 'enable_safety_checker',
        label: 'Safety Checker',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
  },
  'ltx-audio-to-video': {
    id: 'ltx-audio-to-video',
    displayName: 'LTX 2.3 Audio-to-Video',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/ltx-2.3/audio-to-video',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: true },
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: false },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'guidance_scale',
        label: 'Guidance Scale',
        type: 'float',
        required: false,
        default: 5.0,
        min: 1.0,
        max: 50.0,
      },
      {
        key: 'aspect_ratio',
        label: 'Aspect Ratio',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '16:9', value: '16:9' },
          { label: '9:16', value: '9:16' },
        ],
      },
    ],
  },
  'video-understanding': {
    id: 'video-understanding',
    displayName: 'Video Understanding',
    category: 'analyzer',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/video-understanding',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: true },
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'text', label: 'Text', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'detailed_analysis',
        label: 'Detailed Analysis',
        type: 'boolean',
        required: false,
        default: false,
      },
    ],
  },
  'ltx-2-3-fast-t2v': {
    id: 'ltx-2-3-fast-t2v',
    displayName: 'LTX 2.3 Fast T2V',
    category: 'video-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/ltx-2.3/text-to-video/fast',
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
        default: '6',
        options: [
          { label: '6s', value: '6' },
          { label: '8s', value: '8' },
          { label: '10s', value: '10' },
          { label: '12s', value: '12' },
          { label: '14s', value: '14' },
          { label: '16s', value: '16' },
          { label: '18s', value: '18' },
          { label: '20s', value: '20' },
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
          { label: '2160p (4K)', value: '2160p' },
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
        key: 'fps',
        label: 'FPS',
        type: 'enum',
        required: false,
        default: 25,
        options: [
          { label: '24', value: 24 },
          { label: '25', value: 25 },
          { label: '48', value: 48 },
          { label: '50', value: 50 },
        ],
      },
      {
        key: 'generate_audio',
        label: 'Generate Audio',
        type: 'boolean',
        required: false,
        default: true,
      },
    ],
  },
  'video-duration-check': {
    id: 'video-duration-check',
    displayName: 'Video Duration Check',
    category: 'analyzer',
    apiProvider: 'utility',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: true },
      {
        id: 'requested_duration',
        label: 'Requested Duration',
        dataType: 'Text',
        required: false,
      },
    ],
    outputPorts: [
      { id: 'text', label: 'Report', dataType: 'Text', required: false },
      { id: 'match', label: 'Match', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'requested_duration',
        label: 'Requested Duration (s)',
        type: 'float',
        required: false,
        default: '',
        min: 0,
        step: 0.1,
      },
    ],
  },

  'qc-loop-safety': {
    id: 'qc-loop-safety', displayName: 'QC Loop Safety', category: 'analyzer',
    apiProvider: 'utility', apiEndpoint: '', envKeyName: [], executionPattern: 'sync',
    inputPorts: [{ id: 'video', label: 'Video', dataType: 'Video', required: true }],
    outputPorts: [
      { id: 'frame', label: 'Annotated Frame', dataType: 'Image', required: false },
      { id: 'text', label: 'QC Report', dataType: 'Text', required: false },
    ],
    params: [
      { key: 'mode', label: 'Analysis Mode', type: 'enum', required: false, default: 'heuristic', options: [
        { label: 'Heuristic', value: 'heuristic' }, { label: 'Vision LLM', value: 'vision-llm' }, { label: 'OpenCV', value: 'opencv' },
      ] },
      { key: 'sample_density', label: 'Sample Density', type: 'integer', required: false, default: 5, min: 2, max: 12, step: 1 },
    ],
  },
  'qc-frame-review': {
    id: 'qc-frame-review', displayName: 'QC Frame Review', category: 'analyzer',
    apiProvider: 'utility', apiEndpoint: '', envKeyName: [], executionPattern: 'sync',
    inputPorts: [{ id: 'video', label: 'Video', dataType: 'Video', required: true }],
    outputPorts: [
      { id: 'frame', label: 'Annotated Frames', dataType: 'Image', required: false },
      { id: 'text', label: 'QC Report', dataType: 'Text', required: false },
    ],
    params: [
      { key: 'mode', label: 'Analysis Mode', type: 'enum', required: false, default: 'heuristic', options: [
        { label: 'Heuristic', value: 'heuristic' }, { label: 'Vision LLM', value: 'vision-llm' }, { label: 'OpenCV', value: 'opencv' },
      ] },
      { key: 'sample_rate', label: 'Samples Per Second', type: 'float', required: false, default: 1, min: 0.1, max: 4, step: 0.1 },
      { key: 'track_faces', label: 'Track Faces', type: 'boolean', required: false, default: true },
    ],
  },
  'qc-composited-look': {
    id: 'qc-composited-look', displayName: 'QC Composited Look', category: 'analyzer',
    apiProvider: 'utility', apiEndpoint: '', envKeyName: [], executionPattern: 'sync',
    inputPorts: [{ id: 'video', label: 'Video', dataType: 'Video', required: true }],
    outputPorts: [
      { id: 'frame', label: 'Annotated Frames', dataType: 'Image', required: false },
      { id: 'text', label: 'QC Report', dataType: 'Text', required: false },
    ],
    params: [
      { key: 'mode', label: 'Analysis Mode', type: 'enum', required: false, default: 'heuristic', options: [
        { label: 'Heuristic', value: 'heuristic' }, { label: 'Vision LLM', value: 'vision-llm' }, { label: 'OpenCV', value: 'opencv' },
      ] },
      { key: 'sample_density', label: 'Sample Density', type: 'integer', required: false, default: 5, min: 2, max: 12, step: 1 },
    ],
  },
  'qc-camera-geometry': {
    id: 'qc-camera-geometry', displayName: 'QC Camera Geometry', category: 'analyzer',
    apiProvider: 'utility', apiEndpoint: '', envKeyName: [], executionPattern: 'sync',
    inputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: true },
      { id: 'reference', label: 'Reference Frame', dataType: 'Image', required: false, role: 'composition' },
    ],
    outputPorts: [
      { id: 'frame', label: 'Annotated Frames', dataType: 'Image', required: false },
      { id: 'text', label: 'QC Report', dataType: 'Text', required: false },
    ],
    params: [
      { key: 'mode', label: 'Analysis Mode', type: 'enum', required: false, default: 'heuristic', options: [
        { label: 'Heuristic', value: 'heuristic' }, { label: 'Vision LLM', value: 'vision-llm' }, { label: 'OpenCV', value: 'opencv' },
      ] },
      { key: 'expected_angle', label: 'Expected Angle', type: 'string', required: false, default: '', placeholder: 'e.g. low-angle push-in' },
    ],
  },

  'identity-edit': {
    id: 'identity-edit',
    displayName: 'Identity Edit',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/nano-banana-2/edit',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    capabilityNote: 'Identity guidance uses Character reference images and traits. This model has no identity-strength or mask control.',
    // nano-banana-2/edit with optional Character-bundle identity preservation:
    // when a Character is wired in, its trait string leads the prompt and its
    // reference views ride as additional images behind the base edit target.
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true, role: 'identity' },
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'character', label: 'Character', dataType: 'Character', required: false },
      { id: 'mask', label: 'Mask (unavailable)', dataType: 'Mask', required: false },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'enum',
        required: false,
        default: '1024',
        options: [
          { label: '1024', value: '1024' },
          { label: '2048', value: '2048' },
        ],
      },
      {
        key: 'thinking_level',
        label: 'Thinking Level',
        type: 'enum',
        required: false,
        default: 'low',
        options: [
          { label: 'Low', value: 'low' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
        ],
      },
      {
        key: 'identity_strength',
        label: 'Identity Strength',
        disabledReason: 'Unavailable: this model uses reference images and traits without an identity-strength control. Your stored value is retained.',
        type: 'float',
        required: false,
        default: 0.8,
        min: 0.0,
        max: 1.0,
        step: 0.05,
      },
    ],
  },
  // BEGIN GENERATED KREA CATALOG (scripts/sync-krea-catalog.py)
  'krea-image-krea-krea-2-medium': {
    "id": "krea-image-krea-krea-2-medium",
    "displayName": "Krea 2 Medium (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/krea/krea-2/medium",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "styles",
        "label": "Styles",
        "dataType": "Any",
        "required": false,
        "multiple": true
      },
      {
        "id": "image_style_references",
        "label": "Image style references",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 10
      },
      {
        "id": "moodboards",
        "label": "Moodboards",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 1
      },
      {
        "id": "image_url",
        "label": "Image URL",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "styles",
        "label": "Styles (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "image_style_references",
        "label": "Image style references (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": true,
        "type": "enum",
        "options": [
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "3:2",
            "value": "3:2"
          },
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "2.35:1",
            "value": "2.35:1"
          },
          {
            "label": "4:5",
            "value": "4:5"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "2:3",
            "value": "2:3"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ]
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": true,
        "type": "enum",
        "options": [
          {
            "label": "1K",
            "value": "1K"
          }
        ]
      },
      {
        "key": "creativity",
        "label": "Creativity",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "raw",
            "value": "raw"
          },
          {
            "label": "low",
            "value": "low"
          },
          {
            "label": "medium",
            "value": "medium"
          },
          {
            "label": "high",
            "value": "high"
          }
        ],
        "default": "low"
      },
      {
        "key": "intensity",
        "label": "Intensity",
        "required": false,
        "type": "integer",
        "min": -100,
        "max": 100,
        "step": 1,
        "default": 0
      },
      {
        "key": "complexity",
        "label": "Complexity",
        "required": false,
        "type": "integer",
        "min": -100,
        "max": 100,
        "step": 1,
        "default": 0
      },
      {
        "key": "movement",
        "label": "Movement",
        "required": false,
        "type": "integer",
        "min": -100,
        "max": 100,
        "step": 1,
        "default": 0
      },
      {
        "key": "moodboards",
        "label": "Moodboards (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "image_url",
        "label": "Image URL",
        "required": false,
        "type": "string"
      },
      {
        "key": "strength",
        "label": "Strength",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 0.99
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-krea-krea-2-large': {
    "id": "krea-image-krea-krea-2-large",
    "displayName": "Krea 2 Large (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/krea/krea-2/large",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "styles",
        "label": "Styles",
        "dataType": "Any",
        "required": false,
        "multiple": true
      },
      {
        "id": "image_style_references",
        "label": "Image style references",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 10
      },
      {
        "id": "moodboards",
        "label": "Moodboards",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 1
      },
      {
        "id": "image_url",
        "label": "Image URL",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "styles",
        "label": "Styles (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "image_style_references",
        "label": "Image style references (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": true,
        "type": "enum",
        "options": [
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "3:2",
            "value": "3:2"
          },
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "2.35:1",
            "value": "2.35:1"
          },
          {
            "label": "4:5",
            "value": "4:5"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "2:3",
            "value": "2:3"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ]
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": true,
        "type": "enum",
        "options": [
          {
            "label": "1K",
            "value": "1K"
          }
        ]
      },
      {
        "key": "creativity",
        "label": "Creativity",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "raw",
            "value": "raw"
          },
          {
            "label": "low",
            "value": "low"
          },
          {
            "label": "medium",
            "value": "medium"
          },
          {
            "label": "high",
            "value": "high"
          }
        ],
        "default": "low"
      },
      {
        "key": "intensity",
        "label": "Intensity",
        "required": false,
        "type": "integer",
        "min": -100,
        "max": 100,
        "step": 1,
        "default": 0
      },
      {
        "key": "complexity",
        "label": "Complexity",
        "required": false,
        "type": "integer",
        "min": -100,
        "max": 100,
        "step": 1,
        "default": 0
      },
      {
        "key": "movement",
        "label": "Movement",
        "required": false,
        "type": "integer",
        "min": -100,
        "max": 100,
        "step": 1,
        "default": 0
      },
      {
        "key": "moodboards",
        "label": "Moodboards (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "image_url",
        "label": "Image URL",
        "required": false,
        "type": "string"
      },
      {
        "key": "strength",
        "label": "Strength",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 0.99
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-krea-krea-2-medium-turbo': {
    "id": "krea-image-krea-krea-2-medium-turbo",
    "displayName": "Krea 2 Turbo (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/krea/krea-2/medium-turbo",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "styles",
        "label": "Styles",
        "dataType": "Any",
        "required": false,
        "multiple": true
      },
      {
        "id": "image_style_references",
        "label": "Image style references",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 10
      },
      {
        "id": "moodboards",
        "label": "Moodboards",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 1
      },
      {
        "id": "image_url",
        "label": "Image URL",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "styles",
        "label": "Styles (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "image_style_references",
        "label": "Image style references (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": true,
        "type": "enum",
        "options": [
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "3:2",
            "value": "3:2"
          },
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "2.35:1",
            "value": "2.35:1"
          },
          {
            "label": "4:5",
            "value": "4:5"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "2:3",
            "value": "2:3"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ]
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": true,
        "type": "enum",
        "options": [
          {
            "label": "1K",
            "value": "1K"
          }
        ]
      },
      {
        "key": "creativity",
        "label": "Creativity",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "raw",
            "value": "raw"
          },
          {
            "label": "low",
            "value": "low"
          },
          {
            "label": "medium",
            "value": "medium"
          },
          {
            "label": "high",
            "value": "high"
          }
        ],
        "default": "low"
      },
      {
        "key": "intensity",
        "label": "Intensity",
        "required": false,
        "type": "integer",
        "min": -100,
        "max": 100,
        "step": 1,
        "default": 0
      },
      {
        "key": "complexity",
        "label": "Complexity",
        "required": false,
        "type": "integer",
        "min": -100,
        "max": 100,
        "step": 1,
        "default": 0
      },
      {
        "key": "movement",
        "label": "Movement",
        "required": false,
        "type": "integer",
        "min": -100,
        "max": 100,
        "step": 1,
        "default": 0
      },
      {
        "key": "moodboards",
        "label": "Moodboards (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "image_url",
        "label": "Image URL",
        "required": false,
        "type": "string"
      },
      {
        "key": "strength",
        "label": "Strength",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 0.99
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-ideogram-ideogram-4-5': {
    "id": "krea-image-ideogram-ideogram-4-5",
    "displayName": "Ideogram 4.5 (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/ideogram/ideogram-4.5",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_urls",
        "label": "Image URLs",
        "dataType": "Image",
        "required": false,
        "multiple": true,
        "maxConnections": 5
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "integer",
        "min": 0,
        "max": 2147483647,
        "step": 1
      },
      {
        "key": "quality",
        "label": "Quality",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "very_low",
            "value": "very_low"
          },
          {
            "label": "low",
            "value": "low"
          },
          {
            "label": "medium",
            "value": "medium"
          },
          {
            "label": "high",
            "value": "high"
          }
        ],
        "default": "high"
      },
      {
        "key": "preserve_source_size",
        "label": "Preserve source size",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "skip_prompt_expansion",
        "label": "Skip prompt expansion",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "3:2",
            "value": "3:2"
          },
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "2.4:1",
            "value": "2.4:1"
          },
          {
            "label": "4:5",
            "value": "4:5"
          },
          {
            "label": "2:3",
            "value": "2:3"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ],
        "default": "1:1"
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "2K",
            "value": "2K"
          }
        ],
        "default": "2K"
      },
      {
        "key": "image_urls",
        "label": "Image URLs (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-bfl-flux-1-dev': {
    "id": "krea-image-bfl-flux-1-dev",
    "displayName": "Flux.1 Dev (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/bfl/flux-1-dev",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_url",
        "label": "Image URL",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "styles",
        "label": "Styles",
        "dataType": "Any",
        "required": false,
        "multiple": true
      },
      {
        "id": "style_images",
        "label": "Style images",
        "dataType": "Any",
        "required": false,
        "multiple": true
      },
      {
        "id": "image_style_references",
        "label": "Image style references",
        "dataType": "Any",
        "required": false,
        "multiple": true
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1513805061
      },
      {
        "key": "steps",
        "label": "Steps",
        "required": false,
        "type": "integer",
        "min": 1,
        "max": 100,
        "step": 1,
        "default": 25
      },
      {
        "key": "width",
        "label": "Width",
        "required": false,
        "type": "float",
        "min": 512,
        "max": 2368,
        "step": 0.01,
        "default": 1024
      },
      {
        "key": "height",
        "label": "Height",
        "required": false,
        "type": "float",
        "min": 512,
        "max": 2368,
        "step": 0.01,
        "default": 1024
      },
      {
        "key": "image_url",
        "label": "Image URL",
        "required": false,
        "type": "string"
      },
      {
        "key": "styles",
        "label": "Styles (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "strength",
        "label": "Strength",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 1
      },
      {
        "key": "guidance_scale",
        "label": "Guidance scale",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 24,
        "step": 0.01,
        "default": 3
      },
      {
        "key": "style_images",
        "label": "Style images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "image_style_references",
        "label": "Image style references (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-bfl-flux-1-kontext-dev': {
    "id": "krea-image-bfl-flux-1-kontext-dev",
    "displayName": "Flux Kontext Dev (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/bfl/flux-1-kontext-dev",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_url",
        "label": "Image URL",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "style_images",
        "label": "Style images",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 1
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      },
      {
        "key": "steps",
        "label": "Steps",
        "required": false,
        "type": "integer",
        "min": 1,
        "max": 100,
        "step": 1,
        "default": 28
      },
      {
        "key": "width",
        "label": "Width",
        "required": false,
        "type": "float",
        "min": 512,
        "max": 8192,
        "step": 0.01,
        "default": 1024
      },
      {
        "key": "height",
        "label": "Height",
        "required": false,
        "type": "float",
        "min": 512,
        "max": 8192,
        "step": 0.01,
        "default": 1024
      },
      {
        "key": "image_url",
        "label": "Image URL",
        "required": false,
        "type": "string"
      },
      {
        "key": "guidance_scale",
        "label": "Guidance scale",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 24,
        "step": 0.01,
        "default": 3
      },
      {
        "key": "style_images",
        "label": "Style images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "strength",
        "label": "Strength",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 1
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-google-nano-banana-pro': {
    "id": "krea-image-google-nano-banana-pro",
    "displayName": "Nano Banana Pro (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/google/nano-banana-pro",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_urls",
        "label": "Image URLs",
        "dataType": "Image",
        "required": false,
        "multiple": true
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "width",
        "label": "Width",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "height",
        "label": "Height",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "image_urls",
        "label": "Image URLs (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "21:9",
            "value": "21:9"
          },
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "3:2",
            "value": "3:2"
          },
          {
            "label": "2:3",
            "value": "2:3"
          },
          {
            "label": "5:4",
            "value": "5:4"
          },
          {
            "label": "4:5",
            "value": "4:5"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ]
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "1K",
            "value": "1K"
          },
          {
            "label": "2K",
            "value": "2K"
          },
          {
            "label": "4K",
            "value": "4K"
          }
        ],
        "default": "1K"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-google-nano-banana-2': {
    "id": "krea-image-google-nano-banana-2",
    "displayName": "Nano Banana 2 (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/google/nano-banana-2",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_urls",
        "label": "Image URLs",
        "dataType": "Image",
        "required": false,
        "multiple": true
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "width",
        "label": "Width",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "height",
        "label": "Height",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "image_urls",
        "label": "Image URLs (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "4:1",
            "value": "4:1"
          },
          {
            "label": "21:9",
            "value": "21:9"
          },
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "3:2",
            "value": "3:2"
          },
          {
            "label": "2:3",
            "value": "2:3"
          },
          {
            "label": "5:4",
            "value": "5:4"
          },
          {
            "label": "4:5",
            "value": "4:5"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          },
          {
            "label": "1:4",
            "value": "1:4"
          },
          {
            "label": "1:8",
            "value": "1:8"
          }
        ]
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "1K",
            "value": "1K"
          },
          {
            "label": "2K",
            "value": "2K"
          },
          {
            "label": "4K",
            "value": "4K"
          }
        ],
        "default": "1K"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-google-nano-banana-2-1': {
    "id": "krea-image-google-nano-banana-2-1",
    "displayName": "Nano Banana 2.1 (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/google/nano-banana-2.1",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_urls",
        "label": "Image URLs",
        "dataType": "Image",
        "required": false,
        "multiple": true
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "width",
        "label": "Width",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "height",
        "label": "Height",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "image_urls",
        "label": "Image URLs (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "4:1",
            "value": "4:1"
          },
          {
            "label": "21:9",
            "value": "21:9"
          },
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "3:2",
            "value": "3:2"
          },
          {
            "label": "2:3",
            "value": "2:3"
          },
          {
            "label": "5:4",
            "value": "5:4"
          },
          {
            "label": "4:5",
            "value": "4:5"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          },
          {
            "label": "1:4",
            "value": "1:4"
          },
          {
            "label": "1:8",
            "value": "1:8"
          }
        ]
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "1K",
            "value": "1K"
          },
          {
            "label": "2K",
            "value": "2K"
          },
          {
            "label": "4K",
            "value": "4K"
          }
        ],
        "default": "1K"
      },
      {
        "key": "thinking_level",
        "label": "Thinking level",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "minimal",
            "value": "minimal"
          },
          {
            "label": "medium",
            "value": "medium"
          },
          {
            "label": "high",
            "value": "high"
          }
        ],
        "default": "medium"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-google-nano-banana-flash-lite': {
    "id": "krea-image-google-nano-banana-flash-lite",
    "displayName": "Nano Banana 2 Lite (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/google/nano-banana-flash-lite",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_urls",
        "label": "Image URLs",
        "dataType": "Image",
        "required": false,
        "multiple": true,
        "maxConnections": 14
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "width",
        "label": "Width",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "height",
        "label": "Height",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "image_urls",
        "label": "Image URLs (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "21:9",
            "value": "21:9"
          },
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "3:2",
            "value": "3:2"
          },
          {
            "label": "2:3",
            "value": "2:3"
          },
          {
            "label": "5:4",
            "value": "5:4"
          },
          {
            "label": "4:5",
            "value": "4:5"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ]
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-google-nano-banana': {
    "id": "krea-image-google-nano-banana",
    "displayName": "Nano Banana (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/google/nano-banana",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_urls",
        "label": "Image URLs",
        "dataType": "Image",
        "required": false,
        "multiple": true
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "width",
        "label": "Width",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "height",
        "label": "Height",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "image_urls",
        "label": "Image URLs (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "21:9",
            "value": "21:9"
          },
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "3:2",
            "value": "3:2"
          },
          {
            "label": "2:3",
            "value": "2:3"
          },
          {
            "label": "5:4",
            "value": "5:4"
          },
          {
            "label": "4:5",
            "value": "4:5"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ]
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-bfl-flux-1-1-pro': {
    "id": "krea-image-bfl-flux-1-1-pro",
    "displayName": "Flux 1.1 Pro (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/bfl/flux-1.1-pro",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "width",
        "label": "Width",
        "required": true,
        "type": "float",
        "min": 256,
        "max": 1440,
        "step": 0.01
      },
      {
        "key": "height",
        "label": "Height",
        "required": true,
        "type": "float",
        "min": 256,
        "max": 1440,
        "step": 0.01
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-bfl-flux-1-1-pro-ultra': {
    "id": "krea-image-bfl-flux-1-1-pro-ultra",
    "displayName": "Flux 1.1 Pro Ultra (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/bfl/flux-1.1-pro-ultra",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "width",
        "label": "Width",
        "required": false,
        "type": "float",
        "min": 512,
        "max": 8192,
        "step": 0.01,
        "default": 1024
      },
      {
        "key": "height",
        "label": "Height",
        "required": false,
        "type": "float",
        "min": 512,
        "max": 8192,
        "step": 0.01,
        "default": 1024
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      },
      {
        "key": "raw",
        "label": "Raw",
        "required": false,
        "type": "boolean",
        "default": true
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-ideogram-ideogram-2-turbo': {
    "id": "krea-image-ideogram-ideogram-2-turbo",
    "displayName": "Ideogram 2.0A Turbo (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/ideogram/ideogram-2-turbo",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "width",
        "label": "Width",
        "required": false,
        "type": "float",
        "min": 512,
        "max": 8192,
        "step": 0.01,
        "default": 1024
      },
      {
        "key": "height",
        "label": "Height",
        "required": false,
        "type": "float",
        "min": 512,
        "max": 8192,
        "step": 0.01,
        "default": 1024
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-ideogram-ideogram-3': {
    "id": "krea-image-ideogram-ideogram-3",
    "displayName": "Ideogram 3.0 (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/ideogram/ideogram-3",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "character_reference_images",
        "label": "Character reference images",
        "dataType": "Image",
        "required": false,
        "multiple": true
      },
      {
        "id": "style_images",
        "label": "Style images",
        "dataType": "Any",
        "required": false,
        "multiple": true
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "width",
        "label": "Width",
        "required": false,
        "type": "float",
        "min": 512,
        "max": 8192,
        "step": 0.01,
        "default": 1024
      },
      {
        "key": "height",
        "label": "Height",
        "required": false,
        "type": "float",
        "min": 512,
        "max": 8192,
        "step": 0.01,
        "default": 1024
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      },
      {
        "key": "character_reference_images",
        "label": "Character reference images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "style_images",
        "label": "Style images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-runway-gen-4-image': {
    "id": "krea-image-runway-gen-4-image",
    "displayName": "Runway Gen-4 Image (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/runway/gen-4-image",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "reference_images",
        "label": "Reference images",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 3
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "width",
        "label": "Width",
        "required": false,
        "type": "float",
        "min": 512,
        "max": 8192,
        "step": 0.01,
        "default": 1024
      },
      {
        "key": "height",
        "label": "Height",
        "required": false,
        "type": "float",
        "min": 512,
        "max": 8192,
        "step": 0.01,
        "default": 1024
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      },
      {
        "key": "reference_images",
        "label": "Reference images (JSON)",
        "required": true,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-openai-gpt-image': {
    "id": "krea-image-openai-gpt-image",
    "displayName": "ChatGPT Image (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/openai/gpt-image",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_urls",
        "label": "Image URLs",
        "dataType": "Image",
        "required": false,
        "multiple": true,
        "maxConnections": 15
      },
      {
        "id": "styles",
        "label": "Styles",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 5
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "width",
        "label": "Width",
        "required": false,
        "type": "float",
        "min": 512,
        "max": 8192,
        "step": 0.01,
        "default": 1024
      },
      {
        "key": "height",
        "label": "Height",
        "required": false,
        "type": "float",
        "min": 512,
        "max": 8192,
        "step": 0.01,
        "default": 1024
      },
      {
        "key": "quality",
        "label": "Quality",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "low",
            "value": "low"
          },
          {
            "label": "medium",
            "value": "medium"
          },
          {
            "label": "high",
            "value": "high"
          },
          {
            "label": "auto",
            "value": "auto"
          }
        ],
        "default": "auto"
      },
      {
        "key": "image_urls",
        "label": "Image URLs (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "styles",
        "label": "Styles (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-openai-gpt-image-2': {
    "id": "krea-image-openai-gpt-image-2",
    "displayName": "GPT Image 2 (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/openai/gpt-image-2",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_urls",
        "label": "Image URLs",
        "dataType": "Image",
        "required": false,
        "multiple": true,
        "maxConnections": 10
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "quality",
        "label": "Quality",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "low",
            "value": "low"
          },
          {
            "label": "medium",
            "value": "medium"
          },
          {
            "label": "high",
            "value": "high"
          },
          {
            "label": "auto",
            "value": "auto"
          }
        ],
        "default": "high"
      },
      {
        "key": "image_urls",
        "label": "Image URLs (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "width",
        "label": "Width",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "height",
        "label": "Height",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "2:1",
            "value": "2:1"
          },
          {
            "label": "3:2",
            "value": "3:2"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "2:3",
            "value": "2:3"
          },
          {
            "label": "1:2",
            "value": "1:2"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ]
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "1K",
            "value": "1K"
          },
          {
            "label": "2K",
            "value": "2K"
          },
          {
            "label": "4K",
            "value": "4K"
          }
        ]
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-openai-gpt-image-2-5-flare': {
    "id": "krea-image-openai-gpt-image-2-5-flare",
    "displayName": "GPT Image 2.5 Flare (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/openai/gpt-image-2.5-flare",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_urls",
        "label": "Image URLs",
        "dataType": "Image",
        "required": false,
        "multiple": true,
        "maxConnections": 10
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "quality",
        "label": "Quality",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "low",
            "value": "low"
          },
          {
            "label": "medium",
            "value": "medium"
          },
          {
            "label": "high",
            "value": "high"
          },
          {
            "label": "xhigh",
            "value": "xhigh"
          },
          {
            "label": "max",
            "value": "max"
          }
        ],
        "default": "high"
      },
      {
        "key": "image_urls",
        "label": "Image URLs (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": true,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "2:1",
            "value": "2:1"
          },
          {
            "label": "3:2",
            "value": "3:2"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "2:3",
            "value": "2:3"
          },
          {
            "label": "1:2",
            "value": "1:2"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ]
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": true,
        "type": "enum",
        "options": [
          {
            "label": "1K",
            "value": "1K"
          },
          {
            "label": "2K",
            "value": "2K"
          },
          {
            "label": "4K",
            "value": "4K"
          }
        ]
      },
      {
        "key": "background",
        "label": "Background",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "transparent",
            "value": "transparent"
          },
          {
            "label": "opaque",
            "value": "opaque"
          },
          {
            "label": "auto",
            "value": "auto"
          }
        ]
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-openai-gpt-image-2-5-sunburst': {
    "id": "krea-image-openai-gpt-image-2-5-sunburst",
    "displayName": "GPT Image 2.5 Sunburst (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/openai/gpt-image-2.5-sunburst",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_urls",
        "label": "Image URLs",
        "dataType": "Image",
        "required": false,
        "multiple": true,
        "maxConnections": 10
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "quality",
        "label": "Quality",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "low",
            "value": "low"
          },
          {
            "label": "medium",
            "value": "medium"
          },
          {
            "label": "high",
            "value": "high"
          },
          {
            "label": "xhigh",
            "value": "xhigh"
          },
          {
            "label": "max",
            "value": "max"
          }
        ],
        "default": "high"
      },
      {
        "key": "image_urls",
        "label": "Image URLs (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": true,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "2:1",
            "value": "2:1"
          },
          {
            "label": "3:2",
            "value": "3:2"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "2:3",
            "value": "2:3"
          },
          {
            "label": "1:2",
            "value": "1:2"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ]
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": true,
        "type": "enum",
        "options": [
          {
            "label": "1K",
            "value": "1K"
          },
          {
            "label": "2K",
            "value": "2K"
          },
          {
            "label": "4K",
            "value": "4K"
          }
        ]
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-xai-grok-imagine-2': {
    "id": "krea-image-xai-grok-imagine-2",
    "displayName": "Grok Imagine 2.0 (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/xai/grok-imagine-2",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "style_images",
        "label": "Style images",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 3
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "quality",
        "label": "Quality",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "low",
            "value": "low"
          },
          {
            "label": "medium",
            "value": "medium"
          }
        ],
        "default": "medium"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": true,
        "type": "enum",
        "options": [
          {
            "label": "2:1",
            "value": "2:1"
          },
          {
            "label": "20:9",
            "value": "20:9"
          },
          {
            "label": "19.5:9",
            "value": "19.5:9"
          },
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "3:2",
            "value": "3:2"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "2:3",
            "value": "2:3"
          },
          {
            "label": "9:16",
            "value": "9:16"
          },
          {
            "label": "9:19.5",
            "value": "9:19.5"
          },
          {
            "label": "9:20",
            "value": "9:20"
          },
          {
            "label": "1:2",
            "value": "1:2"
          }
        ]
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": true,
        "type": "enum",
        "options": [
          {
            "label": "1K",
            "value": "1K"
          },
          {
            "label": "2K",
            "value": "2K"
          }
        ]
      },
      {
        "key": "style_images",
        "label": "Style images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-xai-grok-imagine-2-edit': {
    "id": "krea-image-xai-grok-imagine-2-edit",
    "displayName": "Grok Imagine 2.0 Edit (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/xai/grok-imagine-2-edit",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_urls",
        "label": "Image URLs",
        "dataType": "Image",
        "required": false,
        "multiple": true,
        "maxConnections": 3
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "quality",
        "label": "Quality",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "low",
            "value": "low"
          },
          {
            "label": "medium",
            "value": "medium"
          }
        ],
        "default": "medium"
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "1K",
            "value": "1K"
          },
          {
            "label": "2K",
            "value": "2K"
          }
        ],
        "default": "1K"
      },
      {
        "key": "image_urls",
        "label": "Image URLs (JSON)",
        "required": true,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-meta-muse-image': {
    "id": "krea-image-meta-muse-image",
    "displayName": "Muse Image (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/meta/muse-image",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "style_images",
        "label": "Style images",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 10
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "21:9",
            "value": "21:9"
          },
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "3:2",
            "value": "3:2"
          },
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "2:3",
            "value": "2:3"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "9:16",
            "value": "9:16"
          },
          {
            "label": "9:21",
            "value": "9:21"
          }
        ]
      },
      {
        "key": "style_images",
        "label": "Style images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-alibaba-qwen-image-3': {
    "id": "krea-image-alibaba-qwen-image-3",
    "displayName": "Qwen Image 3 (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/alibaba/qwen-image-3",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "style_images",
        "label": "Style images",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 3
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "width",
        "label": "Width",
        "required": false,
        "type": "integer",
        "min": 512,
        "max": 2048,
        "step": 1,
        "default": 1024
      },
      {
        "key": "height",
        "label": "Height",
        "required": false,
        "type": "integer",
        "min": 512,
        "max": 2048,
        "step": 1,
        "default": 1024
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      },
      {
        "key": "style_images",
        "label": "Style images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-alibaba-qwen-image-2-1': {
    "id": "krea-image-alibaba-qwen-image-2-1",
    "displayName": "Qwen Image 2.1 (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/alibaba/qwen-image-2.1",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "style_images",
        "label": "Style images",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 3
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "width",
        "label": "Width",
        "required": false,
        "type": "integer",
        "min": 512,
        "max": 2048,
        "step": 1,
        "default": 1024
      },
      {
        "key": "height",
        "label": "Height",
        "required": false,
        "type": "integer",
        "min": 512,
        "max": 2048,
        "step": 1,
        "default": 1024
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      },
      {
        "key": "style_images",
        "label": "Style images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "background",
        "label": "Background",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "transparent",
            "value": "transparent"
          },
          {
            "label": "opaque",
            "value": "opaque"
          },
          {
            "label": "auto",
            "value": "auto"
          }
        ]
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-luma-uni-1': {
    "id": "krea-image-luma-uni-1",
    "displayName": "Luma UNI-1 (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/luma/uni-1",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "style_images",
        "label": "Style images",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 9
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "width",
        "label": "Width",
        "required": false,
        "type": "float",
        "min": 512,
        "max": 8192,
        "step": 0.01,
        "default": 1024
      },
      {
        "key": "height",
        "label": "Height",
        "required": false,
        "type": "float",
        "min": 512,
        "max": 8192,
        "step": 0.01,
        "default": 1024
      },
      {
        "key": "mode",
        "label": "Mode",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "standard",
            "value": "standard"
          },
          {
            "label": "max",
            "value": "max"
          }
        ],
        "default": "standard"
      },
      {
        "key": "style",
        "label": "Style",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "auto",
            "value": "auto"
          },
          {
            "label": "manga",
            "value": "manga"
          }
        ],
        "default": "auto"
      },
      {
        "key": "output_format",
        "label": "Output format",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "png",
            "value": "png"
          },
          {
            "label": "jpeg",
            "value": "jpeg"
          }
        ]
      },
      {
        "key": "web_search",
        "label": "Web search",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "style_images",
        "label": "Style images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-recraft-recraft-v4-1-flash': {
    "id": "krea-image-recraft-recraft-v4-1-flash",
    "displayName": "Recraft V4.1 Flash (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/recraft/recraft-v4.1-flash",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": true,
        "type": "enum",
        "options": [
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "3:2",
            "value": "3:2"
          },
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "2:3",
            "value": "2:3"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ]
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": true,
        "type": "enum",
        "options": [
          {
            "label": "1K",
            "value": "1K"
          }
        ]
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-bytedance-seedream-4': {
    "id": "krea-image-bytedance-seedream-4",
    "displayName": "Seedream 4 (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/bytedance/seedream-4",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "style_images",
        "label": "Style images",
        "dataType": "Any",
        "required": false,
        "multiple": true
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "width",
        "label": "Width",
        "required": true,
        "type": "float",
        "max": 4096,
        "step": 0.01
      },
      {
        "key": "height",
        "label": "Height",
        "required": true,
        "type": "float",
        "max": 4096,
        "step": 0.01
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      },
      {
        "key": "style_images",
        "label": "Style images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-bytedance-seedream-5-lite': {
    "id": "krea-image-bytedance-seedream-5-lite",
    "displayName": "Seedream 5 Lite (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/bytedance/seedream-5-lite",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "style_images",
        "label": "Style images",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 14
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "width",
        "label": "Width",
        "required": true,
        "type": "float",
        "max": 4096,
        "step": 0.01
      },
      {
        "key": "height",
        "label": "Height",
        "required": true,
        "type": "float",
        "max": 4096,
        "step": 0.01
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      },
      {
        "key": "style_images",
        "label": "Style images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-bytedance-seedream-5-pro': {
    "id": "krea-image-bytedance-seedream-5-pro",
    "displayName": "Seedream 5 Pro (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/bytedance/seedream-5-pro",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "style_images",
        "label": "Style images",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 10
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "width",
        "label": "Width",
        "required": true,
        "type": "float",
        "max": 4096,
        "step": 0.01
      },
      {
        "key": "height",
        "label": "Height",
        "required": true,
        "type": "float",
        "max": 4096,
        "step": 0.01
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      },
      {
        "key": "style_images",
        "label": "Style images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-qwen-2512': {
    "id": "krea-image-qwen-2512",
    "displayName": "Qwen Image 2512 (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/qwen/2512",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "styles",
        "label": "Styles",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 3
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "negative_prompt",
        "label": "Negative prompt",
        "required": false,
        "type": "string",
        "default": ""
      },
      {
        "key": "width",
        "label": "Width",
        "required": false,
        "type": "float",
        "min": 256,
        "max": 4096,
        "step": 0.01,
        "default": 1024
      },
      {
        "key": "height",
        "label": "Height",
        "required": false,
        "type": "float",
        "min": 256,
        "max": 4096,
        "step": 0.01,
        "default": 1024
      },
      {
        "key": "num_inference_steps",
        "label": "Num inference steps",
        "required": false,
        "type": "integer",
        "min": 1,
        "max": 50,
        "step": 1,
        "default": 28
      },
      {
        "key": "cfg_scale",
        "label": "Cfg scale",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 4
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      },
      {
        "key": "styles",
        "label": "Styles (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-z-image-z-image': {
    "id": "krea-image-z-image-z-image",
    "displayName": "Z Image (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/z-image/z-image",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "styles",
        "label": "Styles",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 3
      },
      {
        "id": "image_url",
        "label": "Image URL",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "style_images",
        "label": "Style images",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 1
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      },
      {
        "key": "denoising_strength",
        "label": "Denoising strength",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 0.6
      },
      {
        "key": "styles",
        "label": "Styles (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "skip_prompt_expansion",
        "label": "Skip prompt expansion",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": true,
        "type": "enum",
        "options": [
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "2:3",
            "value": "2:3"
          },
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ]
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": true,
        "type": "enum",
        "options": [
          {
            "label": "1K",
            "value": "1K"
          }
        ]
      },
      {
        "key": "image_url",
        "label": "Image URL",
        "required": false,
        "type": "string"
      },
      {
        "key": "style_images",
        "label": "Style images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-enhance-krea-enhance': {
    "id": "krea-enhance-krea-enhance",
    "displayName": "Krea Enhance (Krea)",
    "category": "transform",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/enhance/krea/enhance",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_url",
        "label": "Image URL",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": false,
        "type": "textarea",
        "default": ""
      },
      {
        "key": "image_url",
        "label": "Image URL",
        "required": true,
        "type": "string"
      },
      {
        "key": "image_scaling_factor",
        "label": "Image scaling factor",
        "required": false,
        "type": "float",
        "min": 0.1,
        "step": 0.01,
        "default": 2
      },
      {
        "key": "rescale_color",
        "label": "Rescale color",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "ai_strength",
        "label": "Ai strength",
        "required": false,
        "type": "float",
        "min": 0.1,
        "max": 1,
        "step": 0.01,
        "default": 0.4
      },
      {
        "key": "clarity_strength",
        "label": "Clarity strength",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 12,
        "step": 0.01,
        "default": 4
      },
      {
        "key": "resemblance_strength",
        "label": "Resemblance strength",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 2.5,
        "step": 0.01,
        "default": 1
      },
      {
        "key": "sharpness",
        "label": "Sharpness",
        "required": false,
        "type": "float",
        "min": 0.1,
        "max": 1.5,
        "step": 0.01,
        "default": 0.5
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-enhance-krea-legacy-enhance': {
    "id": "krea-enhance-krea-legacy-enhance",
    "displayName": "Krea Enhance Legacy (Krea)",
    "category": "transform",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/enhance/krea/legacy-enhance",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_url",
        "label": "Image URL",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": false,
        "type": "textarea",
        "default": ""
      },
      {
        "key": "image_url",
        "label": "Image URL",
        "required": true,
        "type": "string"
      },
      {
        "key": "image_scaling_factor",
        "label": "Image scaling factor",
        "required": false,
        "type": "float",
        "min": 0.1,
        "step": 0.01,
        "default": 2
      },
      {
        "key": "rescale_color",
        "label": "Rescale color",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "upscaling_activated",
        "label": "Upscaling activated",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "ai_strength",
        "label": "Ai strength",
        "required": false,
        "type": "float",
        "min": 0.1,
        "max": 1,
        "step": 0.01,
        "default": 0.6
      },
      {
        "key": "clarity_strength",
        "label": "Clarity strength",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 12,
        "step": 0.01,
        "default": 2.5
      },
      {
        "key": "resemblance_strength",
        "label": "Resemblance strength",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 2.5,
        "step": 0.01,
        "default": 1
      },
      {
        "key": "scene_transfer",
        "label": "Scene transfer",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "scene_image_url",
        "label": "Scene image URL (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model",
        "default": "\"\""
      },
      {
        "key": "scene_prompt",
        "label": "Scene prompt",
        "required": false,
        "type": "string",
        "default": ""
      },
      {
        "key": "scene_strength",
        "label": "Scene strength",
        "required": false,
        "type": "float",
        "min": 0.5,
        "max": 1,
        "step": 0.01,
        "default": 0.85
      },
      {
        "key": "switch_background",
        "label": "Switch background",
        "required": false,
        "type": "boolean",
        "default": false
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-enhance-topaz-generative-enhance': {
    "id": "krea-enhance-topaz-generative-enhance",
    "displayName": "Topaz Image Upscale (Krea)",
    "category": "transform",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/enhance/topaz/generative-enhance",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_url",
        "label": "Image URL",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": false,
        "type": "textarea",
        "default": ""
      },
      {
        "key": "width",
        "label": "Width",
        "required": true,
        "type": "float",
        "min": 1,
        "max": 32000,
        "step": 0.01
      },
      {
        "key": "height",
        "label": "Height",
        "required": true,
        "type": "float",
        "min": 1,
        "max": 32000,
        "step": 0.01
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      },
      {
        "key": "image_url",
        "label": "Image URL",
        "required": true,
        "type": "string"
      },
      {
        "key": "model",
        "label": "Model",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "Redefine",
            "value": "Redefine"
          },
          {
            "label": "Recovery",
            "value": "Recovery"
          },
          {
            "label": "Recovery V2",
            "value": "Recovery V2"
          },
          {
            "label": "Reimagine",
            "value": "Reimagine"
          },
          {
            "label": "Wonder 3",
            "value": "Wonder 3"
          },
          {
            "label": "Standard MAX",
            "value": "Standard MAX"
          },
          {
            "label": "Recover 3",
            "value": "Recover 3"
          },
          {
            "label": "Detail",
            "value": "Detail"
          }
        ],
        "default": "Redefine"
      },
      {
        "key": "output_format",
        "label": "Output format",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "png",
            "value": "png"
          },
          {
            "label": "jpg",
            "value": "jpg"
          },
          {
            "label": "webp",
            "value": "webp"
          }
        ],
        "default": "jpg"
      },
      {
        "key": "subject_detection",
        "label": "Subject detection",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "All",
            "value": "All"
          },
          {
            "label": "Foreground",
            "value": "Foreground"
          },
          {
            "label": "Background",
            "value": "Background"
          }
        ],
        "default": "All"
      },
      {
        "key": "face_enhancement",
        "label": "Face enhancement",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "face_enhancement_creativity",
        "label": "Face enhancement creativity",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 0.5
      },
      {
        "key": "face_enhancement_strength",
        "label": "Face enhancement strength",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 0.5
      },
      {
        "key": "crop_to_fill",
        "label": "Crop to fill",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "upscaling_activated",
        "label": "Upscaling activated",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "image_scaling_factor",
        "label": "Image scaling factor",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 32,
        "step": 0.01,
        "default": 1
      },
      {
        "key": "creativity",
        "label": "Creativity",
        "required": false,
        "type": "integer",
        "min": 1,
        "max": 6,
        "step": 1,
        "default": 3
      },
      {
        "key": "texture",
        "label": "Texture",
        "required": false,
        "type": "integer",
        "min": 1,
        "max": 5,
        "step": 1,
        "default": 3
      },
      {
        "key": "sharpen",
        "label": "Sharpen",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 0.5
      },
      {
        "key": "denoise",
        "label": "Denoise",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 0.5
      },
      {
        "key": "detail",
        "label": "Detail",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 0.5
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-enhance-topaz-standard-enhance': {
    "id": "krea-enhance-topaz-standard-enhance",
    "displayName": "Topaz Standard (Krea)",
    "category": "transform",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/enhance/topaz/standard-enhance",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_url",
        "label": "Image URL",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": false,
        "type": "textarea",
        "default": ""
      },
      {
        "key": "width",
        "label": "Width",
        "required": true,
        "type": "float",
        "min": 1,
        "max": 32000,
        "step": 0.01
      },
      {
        "key": "height",
        "label": "Height",
        "required": true,
        "type": "float",
        "min": 1,
        "max": 32000,
        "step": 0.01
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      },
      {
        "key": "image_url",
        "label": "Image URL",
        "required": true,
        "type": "string"
      },
      {
        "key": "model",
        "label": "Model",
        "required": true,
        "type": "enum",
        "options": [
          {
            "label": "Standard V2",
            "value": "Standard V2"
          },
          {
            "label": "Low Resolution V2",
            "value": "Low Resolution V2"
          },
          {
            "label": "CGI",
            "value": "CGI"
          },
          {
            "label": "High Fidelity V2",
            "value": "High Fidelity V2"
          },
          {
            "label": "Upscale High Fidelity V3",
            "value": "Upscale High Fidelity V3"
          },
          {
            "label": "Text Refine",
            "value": "Text Refine"
          }
        ]
      },
      {
        "key": "output_format",
        "label": "Output format",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "png",
            "value": "png"
          },
          {
            "label": "jpg",
            "value": "jpg"
          },
          {
            "label": "webp",
            "value": "webp"
          }
        ],
        "default": "jpg"
      },
      {
        "key": "subject_detection",
        "label": "Subject detection",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "All",
            "value": "All"
          },
          {
            "label": "Foreground",
            "value": "Foreground"
          },
          {
            "label": "Background",
            "value": "Background"
          }
        ],
        "default": "All"
      },
      {
        "key": "face_enhancement",
        "label": "Face enhancement",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "face_enhancement_creativity",
        "label": "Face enhancement creativity",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 0.5
      },
      {
        "key": "face_enhancement_strength",
        "label": "Face enhancement strength",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 0.5
      },
      {
        "key": "crop_to_fill",
        "label": "Crop to fill",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "upscaling_activated",
        "label": "Upscaling activated",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "image_scaling_factor",
        "label": "Image scaling factor",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 32,
        "step": 0.01,
        "default": 1
      },
      {
        "key": "sharpen",
        "label": "Sharpen",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 0.5
      },
      {
        "key": "denoise",
        "label": "Denoise",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 0.5
      },
      {
        "key": "fix_compression",
        "label": "Fix compression",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 0.5
      },
      {
        "key": "strength",
        "label": "Strength",
        "required": false,
        "type": "float",
        "min": 0.01,
        "max": 1,
        "step": 0.01,
        "default": 0.5
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-enhance-topaz-bloom-enhance': {
    "id": "krea-enhance-topaz-bloom-enhance",
    "displayName": "Topaz Bloom (Krea)",
    "category": "transform",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/enhance/topaz/bloom-enhance",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_url",
        "label": "Image URL",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": false,
        "type": "textarea",
        "default": ""
      },
      {
        "key": "width",
        "label": "Width",
        "required": true,
        "type": "float",
        "min": 1,
        "max": 10000,
        "step": 0.01
      },
      {
        "key": "height",
        "label": "Height",
        "required": true,
        "type": "float",
        "min": 1,
        "max": 10000,
        "step": 0.01
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      },
      {
        "key": "image_url",
        "label": "Image URL",
        "required": true,
        "type": "string"
      },
      {
        "key": "output_format",
        "label": "Output format",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "png",
            "value": "png"
          },
          {
            "label": "jpg",
            "value": "jpg"
          },
          {
            "label": "webp",
            "value": "webp"
          }
        ],
        "default": "jpg"
      },
      {
        "key": "crop_to_fill",
        "label": "Crop to fill",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "creativity",
        "label": "Creativity",
        "required": false,
        "type": "integer",
        "min": 1,
        "max": 9,
        "step": 1,
        "default": 3
      },
      {
        "key": "face_preservation",
        "label": "Face preservation",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "color_preservation",
        "label": "Color preservation",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "upscaling_activated",
        "label": "Upscaling activated",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "image_scaling_factor",
        "label": "Image scaling factor",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 32,
        "step": 0.01,
        "default": 1
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-enhance-topaz-bloom-2-enhance': {
    "id": "krea-enhance-topaz-bloom-2-enhance",
    "displayName": "Topaz Bloom 2 (Krea)",
    "category": "transform",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/enhance/topaz/bloom-2-enhance",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_url",
        "label": "Image URL",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "reference_uri",
        "label": "Reference uri",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": false,
        "type": "textarea",
        "default": ""
      },
      {
        "key": "width",
        "label": "Width",
        "required": true,
        "type": "float",
        "min": 1,
        "max": 10000,
        "step": 0.01
      },
      {
        "key": "height",
        "label": "Height",
        "required": true,
        "type": "float",
        "min": 1,
        "max": 10000,
        "step": 0.01
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      },
      {
        "key": "image_url",
        "label": "Image URL",
        "required": true,
        "type": "string"
      },
      {
        "key": "output_format",
        "label": "Output format",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "png",
            "value": "png"
          },
          {
            "label": "jpg",
            "value": "jpg"
          },
          {
            "label": "webp",
            "value": "webp"
          }
        ],
        "default": "jpg"
      },
      {
        "key": "crop_to_fill",
        "label": "Crop to fill",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "creativity",
        "label": "Creativity",
        "required": false,
        "type": "integer",
        "min": 1,
        "max": 9,
        "step": 1,
        "default": 3
      },
      {
        "key": "autoprompt",
        "label": "Autoprompt",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "face_preservation",
        "label": "Face preservation",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "color_preservation",
        "label": "Color preservation",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "grain",
        "label": "Grain",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "grain_model",
        "label": "Grain model",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "silver",
            "value": "silver"
          },
          {
            "label": "gaussian",
            "value": "gaussian"
          },
          {
            "label": "grey",
            "value": "grey"
          }
        ],
        "default": "silver"
      },
      {
        "key": "grain_density",
        "label": "Grain density",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 0.5
      },
      {
        "key": "grain_strength",
        "label": "Grain strength",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 0.5
      },
      {
        "key": "grain_size",
        "label": "Grain size",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 5,
        "step": 0.01,
        "default": 1
      },
      {
        "key": "reference_uri",
        "label": "Reference uri",
        "required": false,
        "type": "string"
      },
      {
        "key": "upscaling_activated",
        "label": "Upscaling activated",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "image_scaling_factor",
        "label": "Image scaling factor",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 32,
        "step": 0.01,
        "default": 1
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-enhance-topaz-wonder-35-enhance': {
    "id": "krea-enhance-topaz-wonder-35-enhance",
    "displayName": "Topaz Wonder 3.5 (Krea)",
    "category": "transform",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/enhance/topaz/wonder-35-enhance",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "image_url",
        "label": "Image URL",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "width",
        "label": "Width",
        "required": true,
        "type": "float",
        "min": 1,
        "max": 16000,
        "step": 0.01
      },
      {
        "key": "height",
        "label": "Height",
        "required": true,
        "type": "float",
        "min": 1,
        "max": 16000,
        "step": 0.01
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      },
      {
        "key": "image_url",
        "label": "Image URL",
        "required": true,
        "type": "string"
      },
      {
        "key": "output_format",
        "label": "Output format",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "png",
            "value": "png"
          },
          {
            "label": "jpg",
            "value": "jpg"
          },
          {
            "label": "webp",
            "value": "webp"
          }
        ],
        "default": "jpg"
      },
      {
        "key": "crop_to_fill",
        "label": "Crop to fill",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "enhancement_strength",
        "label": "Enhancement strength",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "low",
            "value": "low"
          },
          {
            "label": "medium",
            "value": "medium"
          },
          {
            "label": "high",
            "value": "high"
          }
        ],
        "default": "high"
      },
      {
        "key": "grain",
        "label": "Grain",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "grain_model",
        "label": "Grain model",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "silver",
            "value": "silver"
          },
          {
            "label": "gaussian",
            "value": "gaussian"
          },
          {
            "label": "grey",
            "value": "grey"
          }
        ],
        "default": "silver"
      },
      {
        "key": "grain_density",
        "label": "Grain density",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 0.5
      },
      {
        "key": "grain_strength",
        "label": "Grain strength",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 0.5
      },
      {
        "key": "grain_size",
        "label": "Grain size",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 5,
        "step": 0.01,
        "default": 1
      },
      {
        "key": "upscaling_activated",
        "label": "Upscaling activated",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "image_scaling_factor",
        "label": "Image scaling factor",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 32,
        "step": 0.01,
        "default": 1
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-enhance-magnific-creative-enhance': {
    "id": "krea-enhance-magnific-creative-enhance",
    "displayName": "Magnific Creative (Krea)",
    "category": "transform",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/enhance/magnific/creative-enhance",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_url",
        "label": "Image URL",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": false,
        "type": "textarea",
        "default": ""
      },
      {
        "key": "width",
        "label": "Width",
        "required": true,
        "type": "float",
        "min": 1,
        "max": 10000,
        "step": 0.01
      },
      {
        "key": "height",
        "label": "Height",
        "required": true,
        "type": "float",
        "min": 1,
        "max": 10000,
        "step": 0.01
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      },
      {
        "key": "image_url",
        "label": "Image URL",
        "required": true,
        "type": "string"
      },
      {
        "key": "output_format",
        "label": "Output format",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "png",
            "value": "png"
          },
          {
            "label": "jpg",
            "value": "jpg"
          },
          {
            "label": "webp",
            "value": "webp"
          }
        ],
        "default": "png"
      },
      {
        "key": "optimized_for",
        "label": "Optimized for",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "standard",
            "value": "standard"
          },
          {
            "label": "soft_portraits",
            "value": "soft_portraits"
          },
          {
            "label": "hard_portraits",
            "value": "hard_portraits"
          },
          {
            "label": "art_n_illustration",
            "value": "art_n_illustration"
          },
          {
            "label": "videogame_assets",
            "value": "videogame_assets"
          },
          {
            "label": "nature_n_landscapes",
            "value": "nature_n_landscapes"
          },
          {
            "label": "films_n_photography",
            "value": "films_n_photography"
          },
          {
            "label": "3d_renders",
            "value": "3d_renders"
          },
          {
            "label": "science_fiction_n_horror",
            "value": "science_fiction_n_horror"
          }
        ],
        "default": "standard"
      },
      {
        "key": "creativity",
        "label": "Creativity",
        "required": false,
        "type": "integer",
        "min": -10,
        "max": 10,
        "step": 1,
        "default": 0
      },
      {
        "key": "hdr",
        "label": "Hdr",
        "required": false,
        "type": "integer",
        "min": -10,
        "max": 10,
        "step": 1,
        "default": 0
      },
      {
        "key": "resemblance",
        "label": "Resemblance",
        "required": false,
        "type": "integer",
        "min": -10,
        "max": 10,
        "step": 1,
        "default": 0
      },
      {
        "key": "fractality",
        "label": "Fractality",
        "required": false,
        "type": "integer",
        "min": -10,
        "max": 10,
        "step": 1,
        "default": 0
      },
      {
        "key": "engine",
        "label": "Engine",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "automatic",
            "value": "automatic"
          },
          {
            "label": "magnific_illusio",
            "value": "magnific_illusio"
          },
          {
            "label": "magnific_sharpy",
            "value": "magnific_sharpy"
          },
          {
            "label": "magnific_sparkle",
            "value": "magnific_sparkle"
          }
        ],
        "default": "automatic"
      },
      {
        "key": "upscaling_activated",
        "label": "Upscaling activated",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "image_scaling_factor",
        "label": "Image scaling factor",
        "required": false,
        "type": "float",
        "min": 2,
        "max": 16,
        "step": 0.01,
        "default": 2
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-enhance-magnific-precise-enhance': {
    "id": "krea-enhance-magnific-precise-enhance",
    "displayName": "Magnific Precise (Krea)",
    "category": "transform",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/enhance/magnific/precise-enhance",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "image_url",
        "label": "Image URL",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "width",
        "label": "Width",
        "required": true,
        "type": "float",
        "min": 1,
        "max": 10000,
        "step": 0.01
      },
      {
        "key": "height",
        "label": "Height",
        "required": true,
        "type": "float",
        "min": 1,
        "max": 10000,
        "step": 0.01
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      },
      {
        "key": "image_url",
        "label": "Image URL",
        "required": true,
        "type": "string"
      },
      {
        "key": "output_format",
        "label": "Output format",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "png",
            "value": "png"
          },
          {
            "label": "jpg",
            "value": "jpg"
          },
          {
            "label": "webp",
            "value": "webp"
          }
        ],
        "default": "png"
      },
      {
        "key": "sharpen",
        "label": "Sharpen",
        "required": false,
        "type": "integer",
        "min": 0,
        "max": 100,
        "step": 1,
        "default": 7
      },
      {
        "key": "smart_grain",
        "label": "Smart grain",
        "required": false,
        "type": "integer",
        "min": 0,
        "max": 100,
        "step": 1,
        "default": 7
      },
      {
        "key": "ultra_detail",
        "label": "Ultra detail",
        "required": false,
        "type": "integer",
        "min": 0,
        "max": 100,
        "step": 1,
        "default": 30
      },
      {
        "key": "flavor",
        "label": "Flavor",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "sublime",
            "value": "sublime"
          },
          {
            "label": "photo",
            "value": "photo"
          },
          {
            "label": "photo_denoiser",
            "value": "photo_denoiser"
          }
        ]
      },
      {
        "key": "upscaling_activated",
        "label": "Upscaling activated",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "image_scaling_factor",
        "label": "Image scaling factor",
        "required": false,
        "type": "float",
        "min": 2,
        "max": 16,
        "step": 0.01,
        "default": 2
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-kling-kling-2-5': {
    "id": "krea-video-kling-kling-2-5",
    "displayName": "Kling 2.5 (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/kling/kling-2.5",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          },
          {
            "label": "1:1",
            "value": "1:1"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "5",
            "value": 5
          },
          {
            "label": "10",
            "value": 10
          }
        ],
        "default": 5
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-kling-kling-2-6': {
    "id": "krea-video-kling-kling-2-6",
    "displayName": "Kling 2.6 (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/kling/kling-2.6",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "5",
            "value": 5
          },
          {
            "label": "10",
            "value": 10
          }
        ],
        "default": 5
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      },
      {
        "key": "generate_audio",
        "label": "Generate audio",
        "required": false,
        "type": "boolean",
        "default": false
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-kling-kling-3-0': {
    "id": "krea-video-kling-kling-3-0",
    "displayName": "Kling 3.0 (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/kling/kling-3.0",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "multi_prompt",
        "label": "Multi prompt",
        "dataType": "Any",
        "required": false,
        "multiple": true
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "float",
        "min": 3,
        "max": 15,
        "step": 0.01,
        "default": 5
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      },
      {
        "key": "generate_audio",
        "label": "Generate audio",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "mode",
        "label": "Mode",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "std",
            "value": "std"
          },
          {
            "label": "pro",
            "value": "pro"
          },
          {
            "label": "4k",
            "value": "4k"
          }
        ],
        "default": "std"
      },
      {
        "key": "multi_prompt",
        "label": "Multi prompt (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-kling-kling-o1': {
    "id": "krea-video-kling-kling-o1",
    "displayName": "Kling o1 (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/kling/kling-o1",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "style_references",
        "label": "Style references",
        "dataType": "Any",
        "required": false,
        "multiple": true
      },
      {
        "id": "element_references",
        "label": "Element references",
        "dataType": "Any",
        "required": false,
        "multiple": true
      },
      {
        "id": "video_reference",
        "label": "Video reference",
        "dataType": "Any",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          },
          {
            "label": "1:1",
            "value": "1:1"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "float",
        "min": 3,
        "max": 10,
        "step": 0.01,
        "default": 5
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      },
      {
        "key": "style_references",
        "label": "Style references (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "element_references",
        "label": "Element references (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "video_reference",
        "label": "Video reference (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-minimax-hailuo': {
    "id": "krea-video-minimax-hailuo",
    "displayName": "Hailuo (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/minimax/hailuo",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "expand_prompt",
        "label": "Expand prompt",
        "required": false,
        "type": "boolean",
        "default": true
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-minimax-hailuo-02': {
    "id": "krea-video-minimax-hailuo-02",
    "displayName": "Hailuo 02 (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/minimax/hailuo-02",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "expand_prompt",
        "label": "Expand prompt",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "512p",
            "value": "512p"
          },
          {
            "label": "768p",
            "value": "768p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          }
        ],
        "default": "768p"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "float",
        "min": 6,
        "max": 10,
        "step": 0.01,
        "default": 6
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-minimax-hailuo-2-3': {
    "id": "krea-video-minimax-hailuo-2-3",
    "displayName": "Hailuo 2.3 (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/minimax/hailuo-2.3",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "expand_prompt",
        "label": "Expand prompt",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "768p",
            "value": "768p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          }
        ],
        "default": "768p"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "6",
            "value": 6
          },
          {
            "label": "10",
            "value": 10
          }
        ],
        "default": 6
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-minimax-hailuo-2-3-fast': {
    "id": "krea-video-minimax-hailuo-2-3-fast",
    "displayName": "Hailuo 2.3 Fast (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/minimax/hailuo-2.3-fast",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "expand_prompt",
        "label": "Expand prompt",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "768p",
            "value": "768p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          }
        ],
        "default": "768p"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "6",
            "value": 6
          },
          {
            "label": "10",
            "value": 10
          }
        ],
        "default": 6
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-minimax-hailuo-3': {
    "id": "krea-video-minimax-hailuo-3",
    "displayName": "MiniMax H3 (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/minimax/hailuo-3",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "reference_images",
        "label": "Reference images",
        "dataType": "Image",
        "required": false,
        "multiple": true,
        "maxConnections": 9
      },
      {
        "id": "reference_videos",
        "label": "Reference videos",
        "dataType": "Video",
        "required": false,
        "multiple": true,
        "maxConnections": 3
      },
      {
        "id": "reference_audios",
        "label": "Reference audios",
        "dataType": "Audio",
        "required": false,
        "multiple": true,
        "maxConnections": 3
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "adaptive",
            "value": "adaptive"
          },
          {
            "label": "21:9",
            "value": "21:9"
          },
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      },
      {
        "key": "reference_images",
        "label": "Reference images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "reference_videos",
        "label": "Reference videos (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "reference_video_seconds",
        "label": "Reference video seconds",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 15,
        "step": 0.01
      },
      {
        "key": "reference_audios",
        "label": "Reference audios (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "integer",
        "min": 5,
        "max": 15,
        "step": 1,
        "default": 5
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-minimax-h3-max': {
    "id": "krea-video-minimax-h3-max",
    "displayName": "MiniMax H3 Max (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/minimax/h3-max",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "reference_images",
        "label": "Reference images",
        "dataType": "Image",
        "required": false,
        "multiple": true,
        "maxConnections": 12
      },
      {
        "id": "reference_videos",
        "label": "Reference videos",
        "dataType": "Video",
        "required": false,
        "multiple": true,
        "maxConnections": 7
      },
      {
        "id": "reference_audios",
        "label": "Reference audios",
        "dataType": "Audio",
        "required": false,
        "multiple": true,
        "maxConnections": 7
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "21:9",
            "value": "21:9"
          },
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "480p",
            "value": "480p"
          },
          {
            "label": "768p",
            "value": "768p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          }
        ],
        "default": "768p"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "integer",
        "min": 5,
        "max": 15,
        "step": 1,
        "default": 5
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "integer",
        "min": 0,
        "max": 2147483647,
        "step": 1
      },
      {
        "key": "prompt_expansion_mode",
        "label": "Prompt expansion mode",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "disabled",
            "value": "disabled"
          },
          {
            "label": "fast",
            "value": "fast"
          },
          {
            "label": "balanced",
            "value": "balanced"
          },
          {
            "label": "quality",
            "value": "quality"
          }
        ],
        "default": "balanced"
      },
      {
        "key": "reference_images",
        "label": "Reference images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "reference_videos",
        "label": "Reference videos (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "reference_video_seconds",
        "label": "Reference video seconds",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 15,
        "step": 0.01
      },
      {
        "key": "reference_audios",
        "label": "Reference audios (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-minimax-h3-max-turbo': {
    "id": "krea-video-minimax-h3-max-turbo",
    "displayName": "MiniMax H3 Max Turbo (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/minimax/h3-max-turbo",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "21:9",
            "value": "21:9"
          },
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "480p",
            "value": "480p"
          },
          {
            "label": "768p",
            "value": "768p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          }
        ],
        "default": "768p"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "integer",
        "min": 5,
        "max": 15,
        "step": 1,
        "default": 5
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "integer",
        "min": 0,
        "max": 2147483647,
        "step": 1
      },
      {
        "key": "prompt_expansion_mode",
        "label": "Prompt expansion mode",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "balanced",
            "value": "balanced"
          },
          {
            "label": "quality",
            "value": "quality"
          }
        ],
        "default": "balanced"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-minimax-h3-max-camera-controls': {
    "id": "krea-video-minimax-h3-max-camera-controls",
    "displayName": "minimax_h3max_camera (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/minimax/h3-max-camera-controls",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "camera_trajectory",
        "label": "Camera trajectory",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 12
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": true,
        "type": "string"
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "480p",
            "value": "480p"
          },
          {
            "label": "768p",
            "value": "768p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          }
        ],
        "default": "768p"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "integer",
        "min": 5,
        "max": 15,
        "step": 1,
        "default": 5
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "integer",
        "min": 0,
        "max": 2147483647,
        "step": 1
      },
      {
        "key": "prompt_expansion_mode",
        "label": "Prompt expansion mode",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "balanced",
            "value": "balanced"
          },
          {
            "label": "quality",
            "value": "quality"
          }
        ],
        "default": "balanced"
      },
      {
        "key": "camera_trajectory",
        "label": "Camera trajectory (JSON)",
        "required": true,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-alibaba-wan-2-1': {
    "id": "krea-video-alibaba-wan-2-1",
    "displayName": "Wan 2.1 (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/alibaba/wan-2.1",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "styles",
        "label": "Styles",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 3
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "width",
        "label": "Width",
        "required": true,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "height",
        "label": "Height",
        "required": true,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "styles",
        "label": "Styles (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-alibaba-wan-2-2': {
    "id": "krea-video-alibaba-wan-2-2",
    "displayName": "Wan 2.2 (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/alibaba/wan-2.2",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "width",
        "label": "Width",
        "required": true,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "height",
        "label": "Height",
        "required": true,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ],
        "default": "16:9"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-alibaba-wan-2-5': {
    "id": "krea-video-alibaba-wan-2-5",
    "displayName": "Wan 2.5 (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/alibaba/wan-2.5",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "audio_url",
        "label": "Audio URL",
        "dataType": "Audio",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          },
          {
            "label": "1:1",
            "value": "1:1"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "480p",
            "value": "480p"
          },
          {
            "label": "720p",
            "value": "720p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          }
        ],
        "default": "1080p"
      },
      {
        "key": "enable_prompt_expansion",
        "label": "Enable prompt expansion",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "float",
        "min": 5,
        "max": 10,
        "step": 0.01,
        "default": 5
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "audio_url",
        "label": "Audio URL",
        "required": false,
        "type": "string"
      },
      {
        "key": "generate_audio",
        "label": "Generate audio",
        "required": false,
        "type": "boolean",
        "default": false
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-alibaba-wan-3-0': {
    "id": "krea-video-alibaba-wan-3-0",
    "displayName": "Wan 3.0 (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/alibaba/wan-3.0",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "reference_images",
        "label": "Reference images",
        "dataType": "Image",
        "required": false,
        "multiple": true,
        "maxConnections": 10
      },
      {
        "id": "reference_videos",
        "label": "Reference videos",
        "dataType": "Video",
        "required": false,
        "multiple": true,
        "maxConnections": 5
      },
      {
        "id": "reference_audios",
        "label": "Reference audios",
        "dataType": "Audio",
        "required": false,
        "multiple": true,
        "maxConnections": 5
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "adaptive",
            "value": "adaptive"
          },
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ],
        "default": "adaptive"
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "480p",
            "value": "480p"
          },
          {
            "label": "720p",
            "value": "720p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          }
        ],
        "default": "720p"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "integer",
        "min": 2,
        "max": 30,
        "step": 1,
        "default": 5
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "integer",
        "min": 0,
        "max": 2147483647,
        "step": 1
      },
      {
        "key": "generate_audio",
        "label": "Generate audio",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "enable_prompt_expansion",
        "label": "Enable prompt expansion",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      },
      {
        "key": "reference_images",
        "label": "Reference images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "reference_videos",
        "label": "Reference videos (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "reference_audios",
        "label": "Reference audios (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-google-veo-2': {
    "id": "krea-video-google-veo-2",
    "displayName": "Veo 2 (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/google/veo-2",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "start_video",
        "label": "Start video",
        "dataType": "Video",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "start_video",
        "label": "Start video",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "float",
        "min": 5,
        "max": 8,
        "step": 0.01,
        "default": 5
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-google-veo-3': {
    "id": "krea-video-google-veo-3",
    "displayName": "Veo 3 (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/google/veo-3",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          },
          {
            "label": "1:1",
            "value": "1:1"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "4",
            "value": 4
          },
          {
            "label": "6",
            "value": 6
          },
          {
            "label": "8",
            "value": 8
          }
        ],
        "default": 8
      },
      {
        "key": "generate_audio",
        "label": "Generate audio",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "720p",
            "value": "720p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          }
        ],
        "default": "720p"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-google-veo-3-fast': {
    "id": "krea-video-google-veo-3-fast",
    "displayName": "Veo 3 Fast (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/google/veo-3-fast",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          },
          {
            "label": "1:1",
            "value": "1:1"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "4",
            "value": 4
          },
          {
            "label": "6",
            "value": 6
          },
          {
            "label": "8",
            "value": 8
          }
        ],
        "default": 8
      },
      {
        "key": "generate_audio",
        "label": "Generate audio",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "720p",
            "value": "720p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          }
        ],
        "default": "720p"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-google-veo-3-1': {
    "id": "krea-video-google-veo-3-1",
    "displayName": "Veo 3.1 (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/google/veo-3.1",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "reference_images",
        "label": "Reference images",
        "dataType": "Image",
        "required": false,
        "multiple": true
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "4",
            "value": 4
          },
          {
            "label": "6",
            "value": 6
          },
          {
            "label": "8",
            "value": 8
          }
        ],
        "default": 8
      },
      {
        "key": "generate_audio",
        "label": "Generate audio",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "720p",
            "value": "720p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          },
          {
            "label": "4K",
            "value": "4K"
          }
        ],
        "default": "720p"
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      },
      {
        "key": "reference_images",
        "label": "Reference images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-google-veo-3-1-fast': {
    "id": "krea-video-google-veo-3-1-fast",
    "displayName": "Veo 3.1 Fast (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/google/veo-3.1-fast",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "reference_images",
        "label": "Reference images",
        "dataType": "Image",
        "required": false,
        "multiple": true
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "4",
            "value": 4
          },
          {
            "label": "6",
            "value": 6
          },
          {
            "label": "8",
            "value": 8
          }
        ],
        "default": 8
      },
      {
        "key": "generate_audio",
        "label": "Generate audio",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "720p",
            "value": "720p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          },
          {
            "label": "4K",
            "value": "4K"
          }
        ],
        "default": "720p"
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      },
      {
        "key": "reference_images",
        "label": "Reference images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-google-veo-3-1-lite': {
    "id": "krea-video-google-veo-3-1-lite",
    "displayName": "Veo 3.1 Lite (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/google/veo-3.1-lite",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "4",
            "value": 4
          },
          {
            "label": "6",
            "value": 6
          },
          {
            "label": "8",
            "value": 8
          }
        ],
        "default": 8
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "720p",
            "value": "720p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          }
        ],
        "default": "720p"
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-google-gemini-omni-flash': {
    "id": "krea-video-google-gemini-omni-flash",
    "displayName": "Gemini Omni Flash (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/google/gemini-omni-flash",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "reference_images",
        "label": "Reference images",
        "dataType": "Image",
        "required": false,
        "multiple": true,
        "maxConnections": 10
      },
      {
        "id": "reference_videos",
        "label": "Reference videos",
        "dataType": "Video",
        "required": false,
        "multiple": true,
        "maxConnections": 1
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "integer",
        "min": 3,
        "max": 10,
        "step": 1,
        "default": 8
      },
      {
        "key": "reference_images",
        "label": "Reference images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "reference_videos",
        "label": "Reference videos (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-google-gemini-omni-flash-1-1': {
    "id": "krea-video-google-gemini-omni-flash-1-1",
    "displayName": "Gemini Omni Flash 1.1 (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/google/gemini-omni-flash-1.1",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "reference_images",
        "label": "Reference images",
        "dataType": "Image",
        "required": false,
        "multiple": true,
        "maxConnections": 10
      },
      {
        "id": "reference_videos",
        "label": "Reference videos",
        "dataType": "Video",
        "required": false,
        "multiple": true,
        "maxConnections": 3
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "integer",
        "min": 3,
        "max": 10,
        "step": 1,
        "default": 8
      },
      {
        "key": "reference_images",
        "label": "Reference images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "reference_videos",
        "label": "Reference videos (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-bytedance-seedance-1-0-pro': {
    "id": "krea-video-bytedance-seedance-1-0-pro",
    "displayName": "Seedance 1.0 Pro (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/bytedance/seedance-1.0-pro",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "start_video",
        "label": "Start video",
        "dataType": "Video",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "reference_images",
        "label": "Reference images",
        "dataType": "Image",
        "required": false,
        "multiple": true,
        "maxConnections": 4
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "start_video",
        "label": "Start video",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "21:9",
            "value": "21:9"
          },
          {
            "label": "9:21",
            "value": "9:21"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      },
      {
        "key": "reference_images",
        "label": "Reference images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 5
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "720p",
            "value": "720p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          }
        ],
        "default": "720p"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-bytedance-seedance-1-0-pro-fast': {
    "id": "krea-video-bytedance-seedance-1-0-pro-fast",
    "displayName": "Seedance 1.0 Pro Fast (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/bytedance/seedance-1.0-pro-fast",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "start_video",
        "label": "Start video",
        "dataType": "Video",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "start_video",
        "label": "Start video",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "21:9",
            "value": "21:9"
          },
          {
            "label": "9:21",
            "value": "9:21"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "float",
        "min": 2,
        "max": 12,
        "step": 0.01,
        "default": 5
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "480p",
            "value": "480p"
          },
          {
            "label": "720p",
            "value": "720p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          }
        ],
        "default": "720p"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-bytedance-seedance-2': {
    "id": "krea-video-bytedance-seedance-2",
    "displayName": "Seedance 2.0* (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/bytedance/seedance-2",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "reference_images",
        "label": "Reference images",
        "dataType": "Image",
        "required": false,
        "multiple": true,
        "maxConnections": 9
      },
      {
        "id": "reference_videos",
        "label": "Reference videos",
        "dataType": "Video",
        "required": false,
        "multiple": true,
        "maxConnections": 3
      },
      {
        "id": "reference_audios",
        "label": "Reference audios",
        "dataType": "Audio",
        "required": false,
        "multiple": true,
        "maxConnections": 3
      },
      {
        "id": "effects",
        "label": "Effects",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 12
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "9:16",
            "value": "9:16"
          },
          {
            "label": "21:9",
            "value": "21:9"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      },
      {
        "key": "reference_images",
        "label": "Reference images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "reference_videos",
        "label": "Reference videos (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "reference_audios",
        "label": "Reference audios (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "float",
        "min": 4,
        "max": 15,
        "step": 0.01,
        "default": 5
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "480p",
            "value": "480p"
          },
          {
            "label": "720p",
            "value": "720p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          },
          {
            "label": "4k",
            "value": "4k"
          }
        ],
        "default": "720p"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "integer",
        "min": -9007199254740991,
        "max": 9007199254740991,
        "step": 1
      },
      {
        "key": "generate_audio",
        "label": "Generate audio",
        "required": false,
        "type": "boolean"
      },
      {
        "key": "effects",
        "label": "Effects (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "upscale",
        "label": "Upscale",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "enhance_prompt",
        "label": "Enhance prompt",
        "required": false,
        "type": "boolean",
        "default": false
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-bytedance-seedance-2-fast': {
    "id": "krea-video-bytedance-seedance-2-fast",
    "displayName": "Seedance 2.0 Fast* (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/bytedance/seedance-2-fast",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "reference_images",
        "label": "Reference images",
        "dataType": "Image",
        "required": false,
        "multiple": true,
        "maxConnections": 9
      },
      {
        "id": "reference_videos",
        "label": "Reference videos",
        "dataType": "Video",
        "required": false,
        "multiple": true,
        "maxConnections": 3
      },
      {
        "id": "reference_audios",
        "label": "Reference audios",
        "dataType": "Audio",
        "required": false,
        "multiple": true,
        "maxConnections": 3
      },
      {
        "id": "effects",
        "label": "Effects",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 12
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "9:16",
            "value": "9:16"
          },
          {
            "label": "21:9",
            "value": "21:9"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      },
      {
        "key": "reference_images",
        "label": "Reference images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "reference_videos",
        "label": "Reference videos (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "reference_audios",
        "label": "Reference audios (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "float",
        "min": 4,
        "max": 15,
        "step": 0.01,
        "default": 5
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "480p",
            "value": "480p"
          },
          {
            "label": "720p",
            "value": "720p"
          }
        ],
        "default": "720p"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "integer",
        "min": -9007199254740991,
        "max": 9007199254740991,
        "step": 1
      },
      {
        "key": "generate_audio",
        "label": "Generate audio",
        "required": false,
        "type": "boolean"
      },
      {
        "key": "effects",
        "label": "Effects (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "upscale",
        "label": "Upscale",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "enhance_prompt",
        "label": "Enhance prompt",
        "required": false,
        "type": "boolean",
        "default": false
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-bytedance-seedance-2-mini': {
    "id": "krea-video-bytedance-seedance-2-mini",
    "displayName": "Seedance 2.0 Mini (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/bytedance/seedance-2-mini",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "reference_images",
        "label": "Reference images",
        "dataType": "Image",
        "required": false,
        "multiple": true,
        "maxConnections": 9
      },
      {
        "id": "reference_videos",
        "label": "Reference videos",
        "dataType": "Video",
        "required": false,
        "multiple": true,
        "maxConnections": 3
      },
      {
        "id": "reference_audios",
        "label": "Reference audios",
        "dataType": "Audio",
        "required": false,
        "multiple": true,
        "maxConnections": 3
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "9:16",
            "value": "9:16"
          },
          {
            "label": "21:9",
            "value": "21:9"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      },
      {
        "key": "reference_images",
        "label": "Reference images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "reference_videos",
        "label": "Reference videos (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "reference_audios",
        "label": "Reference audios (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "float",
        "min": 4,
        "max": 15,
        "step": 0.01,
        "default": 5
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "480p",
            "value": "480p"
          },
          {
            "label": "720p",
            "value": "720p"
          }
        ],
        "default": "720p"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "integer",
        "min": -9007199254740991,
        "max": 9007199254740991,
        "step": 1
      },
      {
        "key": "generate_audio",
        "label": "Generate audio",
        "required": false,
        "type": "boolean"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-bytedance-seedance-2-5': {
    "id": "krea-video-bytedance-seedance-2-5",
    "displayName": "Seedance 2.5* (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/bytedance/seedance-2-5",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "reference_images",
        "label": "Reference images",
        "dataType": "Image",
        "required": false,
        "multiple": true,
        "maxConnections": 30
      },
      {
        "id": "reference_videos",
        "label": "Reference videos",
        "dataType": "Video",
        "required": false,
        "multiple": true,
        "maxConnections": 10
      },
      {
        "id": "reference_audios",
        "label": "Reference audios",
        "dataType": "Audio",
        "required": false,
        "multiple": true,
        "maxConnections": 10
      },
      {
        "id": "effects",
        "label": "Effects",
        "dataType": "Any",
        "required": false,
        "multiple": true,
        "maxConnections": 12
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "9:16",
            "value": "9:16"
          },
          {
            "label": "21:9",
            "value": "21:9"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      },
      {
        "key": "reference_images",
        "label": "Reference images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "reference_videos",
        "label": "Reference videos (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "reference_audios",
        "label": "Reference audios (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "float",
        "min": 4,
        "max": 30,
        "step": 0.01,
        "default": 5
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "480p",
            "value": "480p"
          },
          {
            "label": "720p",
            "value": "720p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          }
        ],
        "default": "720p"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "integer",
        "min": -9007199254740991,
        "max": 9007199254740991,
        "step": 1
      },
      {
        "key": "generate_audio",
        "label": "Generate audio",
        "required": false,
        "type": "boolean"
      },
      {
        "key": "effects",
        "label": "Effects (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "enhance_prompt",
        "label": "Enhance prompt",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "draft",
        "label": "Draft",
        "required": false,
        "type": "boolean",
        "default": false
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-lightricks-ltx-video-2-3-22b': {
    "id": "krea-video-lightricks-ltx-video-2-3-22b",
    "displayName": "LTX-2.3 22B (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/lightricks/ltx-video-2.3-22b",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "styles",
        "label": "Styles",
        "dataType": "Any",
        "required": false,
        "multiple": true
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "5",
            "value": 5
          },
          {
            "label": "10",
            "value": 10
          },
          {
            "label": "15",
            "value": 15
          },
          {
            "label": "20",
            "value": 20
          }
        ],
        "default": 5
      },
      {
        "key": "num_frames",
        "label": "Num frames",
        "required": false,
        "type": "integer",
        "min": 9,
        "max": 481,
        "step": 1
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "integer",
        "min": 0,
        "max": 2147483647,
        "step": 1
      },
      {
        "key": "generate_audio",
        "label": "Generate audio",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      },
      {
        "key": "styles",
        "label": "Styles (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-lightricks-ltx-video-2-5-pro': {
    "id": "krea-video-lightricks-ltx-video-2-5-pro",
    "displayName": "LTX-2.5 Pro (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/lightricks/ltx-video-2.5-pro",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "6",
            "value": 6
          },
          {
            "label": "8",
            "value": 8
          },
          {
            "label": "10",
            "value": 10
          }
        ],
        "default": 6
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "720p",
            "value": "720p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          }
        ],
        "default": "1080p"
      },
      {
        "key": "generate_audio",
        "label": "Generate audio",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "camera_motion",
        "label": "Camera motion",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "dolly_in",
            "value": "dolly_in"
          },
          {
            "label": "dolly_out",
            "value": "dolly_out"
          },
          {
            "label": "dolly_left",
            "value": "dolly_left"
          },
          {
            "label": "dolly_right",
            "value": "dolly_right"
          },
          {
            "label": "jib_up",
            "value": "jib_up"
          },
          {
            "label": "jib_down",
            "value": "jib_down"
          },
          {
            "label": "static",
            "value": "static"
          },
          {
            "label": "focus_shift",
            "value": "focus_shift"
          }
        ]
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-lightricks-ltx-video-2-5-fast': {
    "id": "krea-video-lightricks-ltx-video-2-5-fast",
    "displayName": "LTX-2.5 Fast (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/lightricks/ltx-video-2.5-fast",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "6",
            "value": 6
          },
          {
            "label": "8",
            "value": 8
          },
          {
            "label": "10",
            "value": 10
          },
          {
            "label": "12",
            "value": 12
          },
          {
            "label": "14",
            "value": 14
          },
          {
            "label": "16",
            "value": 16
          },
          {
            "label": "18",
            "value": 18
          },
          {
            "label": "20",
            "value": 20
          }
        ],
        "default": 6
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "720p",
            "value": "720p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          },
          {
            "label": "1440p",
            "value": "1440p"
          },
          {
            "label": "4k",
            "value": "4k"
          }
        ],
        "default": "720p"
      },
      {
        "key": "generate_audio",
        "label": "Generate audio",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "camera_motion",
        "label": "Camera motion",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "dolly_in",
            "value": "dolly_in"
          },
          {
            "label": "dolly_out",
            "value": "dolly_out"
          },
          {
            "label": "dolly_left",
            "value": "dolly_left"
          },
          {
            "label": "dolly_right",
            "value": "dolly_right"
          },
          {
            "label": "jib_up",
            "value": "jib_up"
          },
          {
            "label": "jib_down",
            "value": "jib_down"
          },
          {
            "label": "static",
            "value": "static"
          },
          {
            "label": "focus_shift",
            "value": "focus_shift"
          }
        ]
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-vidu-q3': {
    "id": "krea-video-vidu-q3",
    "displayName": "Vidu Q3 (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/vidu/q3",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 16,
        "step": 0.01,
        "default": 5
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "540p",
            "value": "540p"
          },
          {
            "label": "720p",
            "value": "720p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          }
        ],
        "default": "720p"
      },
      {
        "key": "generate_audio",
        "label": "Generate audio",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "movement_amplitude",
        "label": "Movement amplitude",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "auto",
            "value": "auto"
          },
          {
            "label": "small",
            "value": "small"
          },
          {
            "label": "medium",
            "value": "medium"
          },
          {
            "label": "large",
            "value": "large"
          }
        ],
        "default": "auto"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-luma-ray-2': {
    "id": "krea-video-luma-ray-2",
    "displayName": "Ray 2 (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/luma/ray-2",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "21:9",
            "value": "21:9"
          },
          {
            "label": "9:21",
            "value": "9:21"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "loop",
        "label": "Loop",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "width",
        "label": "Width",
        "required": false,
        "type": "integer",
        "min": 540,
        "max": 2520,
        "step": 1,
        "default": 960
      },
      {
        "key": "height",
        "label": "Height",
        "required": false,
        "type": "integer",
        "min": 540,
        "max": 2520,
        "step": 1,
        "default": 540
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-runway-gen-4-video': {
    "id": "krea-video-runway-gen-4-video",
    "displayName": "Runway Gen-4 Video (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/runway/gen-4-video",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "1280:720",
            "value": "1280:720"
          },
          {
            "label": "720:1280",
            "value": "720:1280"
          }
        ],
        "default": "1280:720"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "5",
            "value": 5
          },
          {
            "label": "10",
            "value": 10
          }
        ],
        "default": 5
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-runway-gen-4-5': {
    "id": "krea-video-runway-gen-4-5",
    "displayName": "Runway Gen-4.5 (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/runway/gen-4.5",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "1280:720",
            "value": "1280:720"
          },
          {
            "label": "720:1280",
            "value": "720:1280"
          },
          {
            "label": "1104:832",
            "value": "1104:832"
          },
          {
            "label": "832:1104",
            "value": "832:1104"
          },
          {
            "label": "960:960",
            "value": "960:960"
          },
          {
            "label": "1584:672",
            "value": "1584:672"
          },
          {
            "label": "672:1584",
            "value": "672:1584"
          }
        ],
        "default": "1280:720"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "float",
        "min": 2,
        "max": 10,
        "step": 0.01,
        "default": 5
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-xai-grok-video': {
    "id": "krea-video-xai-grok-video",
    "displayName": "Grok Imagine (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/xai/grok-video",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "start_video",
        "label": "Start video",
        "dataType": "Video",
        "required": false
      },
      {
        "id": "reference_images",
        "label": "Reference images",
        "dataType": "Image",
        "required": false,
        "multiple": true,
        "maxConnections": 7
      },
      {
        "id": "edit_video",
        "label": "Edit video",
        "dataType": "Video",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "start_video",
        "label": "Start video",
        "required": false,
        "type": "string"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 15,
        "step": 0.01,
        "default": 6
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "480p",
            "value": "480p"
          },
          {
            "label": "720p",
            "value": "720p"
          }
        ],
        "default": "720p"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          },
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "3:2",
            "value": "3:2"
          },
          {
            "label": "2:3",
            "value": "2:3"
          }
        ]
      },
      {
        "key": "reference_images",
        "label": "Reference images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model"
      },
      {
        "key": "edit_video",
        "label": "Edit video",
        "required": false,
        "type": "string"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-xai-grok-video-1-5': {
    "id": "krea-video-xai-grok-video-1-5",
    "displayName": "Grok Imagine 1.5 (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/xai/grok-video-1.5",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "start_video",
        "label": "Start video",
        "dataType": "Video",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "start_video",
        "label": "Start video",
        "required": false,
        "type": "string"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 15,
        "step": 0.01,
        "default": 6
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "480p",
            "value": "480p"
          },
          {
            "label": "720p",
            "value": "720p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          }
        ],
        "default": "720p"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "9:16",
            "value": "9:16"
          },
          {
            "label": "1:1",
            "value": "1:1"
          }
        ],
        "default": "16:9"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-black-forest-labs-flux-3-video': {
    "id": "krea-video-black-forest-labs-flux-3-video",
    "displayName": "Flux 3 Video (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/black-forest-labs/flux-3-video",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_image",
        "label": "Start image",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "start_video",
        "label": "Start video",
        "dataType": "Video",
        "required": false
      },
      {
        "id": "end_image",
        "label": "End image",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_image",
        "label": "Start image",
        "required": false,
        "type": "string"
      },
      {
        "key": "start_video",
        "label": "Start video",
        "required": false,
        "type": "string"
      },
      {
        "key": "end_image",
        "label": "End image",
        "required": false,
        "type": "string"
      },
      {
        "key": "duration",
        "label": "Duration",
        "required": false,
        "type": "integer",
        "min": 5,
        "max": 20,
        "step": 1,
        "default": 5
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "720p",
            "value": "720p"
          },
          {
            "label": "1080p",
            "value": "1080p"
          }
        ],
        "default": "720p"
      },
      {
        "key": "aspect_ratio",
        "label": "Aspect ratio",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "21:9",
            "value": "21:9"
          },
          {
            "label": "2:1",
            "value": "2:1"
          },
          {
            "label": "16:9",
            "value": "16:9"
          },
          {
            "label": "4:3",
            "value": "4:3"
          },
          {
            "label": "1:1",
            "value": "1:1"
          },
          {
            "label": "3:4",
            "value": "3:4"
          },
          {
            "label": "9:16",
            "value": "9:16"
          }
        ],
        "default": "16:9"
      },
      {
        "key": "generate_audio",
        "label": "Generate audio",
        "required": false,
        "type": "boolean",
        "default": true
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-video-black-forest-labs-flux-video-edit': {
    "id": "krea-video-black-forest-labs-flux-video-edit",
    "displayName": "Flux Video Edit (Krea)",
    "category": "video-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/video/black-forest-labs/flux-video-edit",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "start_video",
        "label": "Start video",
        "dataType": "Video",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "start_video",
        "label": "Start video",
        "required": true,
        "type": "string"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-enhance-topaz-video-upscale': {
    "id": "krea-enhance-topaz-video-upscale",
    "displayName": "Topaz Video Upscale (Krea)",
    "category": "transform",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/enhance/topaz/video-upscale",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "video_url",
        "label": "Video URL",
        "dataType": "Video",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "target_width",
        "label": "Target width",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 8000,
        "step": 0.01
      },
      {
        "key": "target_height",
        "label": "Target height",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 8000,
        "step": 0.01
      },
      {
        "key": "crop_to_fit",
        "label": "Crop to fit",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "video_url",
        "label": "Video URL",
        "required": true,
        "type": "string"
      },
      {
        "key": "enhancement",
        "label": "Enhancement",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "enhancement_video_type",
        "label": "Enhancement video type",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "Progressive",
            "value": "Progressive"
          },
          {
            "label": "Interlaced",
            "value": "Interlaced"
          },
          {
            "label": "ProgressiveInterlaced",
            "value": "ProgressiveInterlaced"
          }
        ],
        "default": "Progressive"
      },
      {
        "key": "enhancement_model",
        "label": "Enhancement model",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "aaa-9",
            "value": "aaa-9"
          },
          {
            "label": "ahq-12",
            "value": "ahq-12"
          },
          {
            "label": "alq-13",
            "value": "alq-13"
          },
          {
            "label": "alqs-2",
            "value": "alqs-2"
          },
          {
            "label": "amq-13",
            "value": "amq-13"
          },
          {
            "label": "amqs-2",
            "value": "amqs-2"
          },
          {
            "label": "ddv-3",
            "value": "ddv-3"
          },
          {
            "label": "dtd-4",
            "value": "dtd-4"
          },
          {
            "label": "dtds-2",
            "value": "dtds-2"
          },
          {
            "label": "dtv-4",
            "value": "dtv-4"
          },
          {
            "label": "dtvs-2",
            "value": "dtvs-2"
          },
          {
            "label": "gcg-5",
            "value": "gcg-5"
          },
          {
            "label": "ghq-5",
            "value": "ghq-5"
          },
          {
            "label": "iris-2",
            "value": "iris-2"
          },
          {
            "label": "iris-3",
            "value": "iris-3"
          },
          {
            "label": "nxf-1",
            "value": "nxf-1"
          },
          {
            "label": "nyx-3",
            "value": "nyx-3"
          },
          {
            "label": "prob-4",
            "value": "prob-4"
          },
          {
            "label": "rhea-1",
            "value": "rhea-1"
          },
          {
            "label": "sl-1",
            "value": "sl-1"
          },
          {
            "label": "thd-3",
            "value": "thd-3"
          },
          {
            "label": "thf-4",
            "value": "thf-4"
          },
          {
            "label": "thm-2",
            "value": "thm-2"
          }
        ],
        "default": "prob-4"
      },
      {
        "key": "enhancement_focus_fix",
        "label": "Enhancement focus fix",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "None",
            "value": "None"
          },
          {
            "label": "Normal",
            "value": "Normal"
          },
          {
            "label": "Strong",
            "value": "Strong"
          }
        ],
        "default": "None"
      },
      {
        "key": "enhancement_parameters",
        "label": "Enhancement parameters",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "Auto",
            "value": "Auto"
          },
          {
            "label": "Manual",
            "value": "Manual"
          }
        ],
        "default": "Auto"
      },
      {
        "key": "enhancement_compression",
        "label": "Enhancement compression",
        "required": false,
        "type": "float",
        "min": -1,
        "max": 1,
        "step": 0.01,
        "default": 0.1
      },
      {
        "key": "enhancement_recover_details",
        "label": "Enhancement recover details",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 0.7
      },
      {
        "key": "enhancement_sharpen",
        "label": "Enhancement sharpen",
        "required": false,
        "type": "float",
        "min": -1,
        "max": 1,
        "step": 0.01,
        "default": 0.2
      },
      {
        "key": "enhancement_reduce_noise",
        "label": "Enhancement reduce noise",
        "required": false,
        "type": "float",
        "min": -1,
        "max": 1,
        "step": 0.01,
        "default": 0.3
      },
      {
        "key": "enhancement_reduce_halo",
        "label": "Enhancement reduce halo",
        "required": false,
        "type": "float",
        "min": -1,
        "max": 1,
        "step": 0.01,
        "default": 0.4
      },
      {
        "key": "enhancement_preblur",
        "label": "Enhancement preblur",
        "required": false,
        "type": "float",
        "min": -1,
        "max": 1,
        "step": 0.01,
        "default": 0.5
      },
      {
        "key": "frame_interpolation",
        "label": "Frame interpolation",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "frame_interpolation_fps",
        "label": "Frame interpolation fps",
        "required": false,
        "type": "integer",
        "min": 15,
        "max": 240,
        "step": 1,
        "default": 60
      },
      {
        "key": "frame_interpolation_model",
        "label": "Frame interpolation model",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "apo-8",
            "value": "apo-8"
          },
          {
            "label": "apf-2",
            "value": "apf-2"
          },
          {
            "label": "chr-2",
            "value": "chr-2"
          },
          {
            "label": "chf-3",
            "value": "chf-3"
          }
        ],
        "default": "apo-8"
      },
      {
        "key": "frame_interpolation_slowmo",
        "label": "Frame interpolation slowmo",
        "required": false,
        "type": "integer",
        "min": 1,
        "max": 16,
        "step": 1,
        "default": 1
      },
      {
        "key": "frame_interpolation_fix_duplicate_frames",
        "label": "Frame interpolation fix duplicate frames",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "frame_interpolation_duplicate_sensitivity",
        "label": "Frame interpolation duplicate sensitivity",
        "required": false,
        "type": "float",
        "min": 0.001,
        "max": 0.1,
        "step": 0.01,
        "default": 0.01
      },
      {
        "key": "grain",
        "label": "Grain",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "grain_strength",
        "label": "Grain strength",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 0.1,
        "step": 0.01,
        "default": 0.02
      },
      {
        "key": "grain_size",
        "label": "Grain size",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 5,
        "step": 0.01,
        "default": 1
      },
      {
        "key": "video_output_preset",
        "label": "Video output preset",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "h264-high",
            "value": "h264-high"
          },
          {
            "label": "h265-main",
            "value": "h265-main"
          },
          {
            "label": "h265-main10",
            "value": "h265-main10"
          },
          {
            "label": "prores-422-proxy",
            "value": "prores-422-proxy"
          },
          {
            "label": "prores-422-lt",
            "value": "prores-422-lt"
          },
          {
            "label": "prores-422-std",
            "value": "prores-422-std"
          },
          {
            "label": "prores-422-hq",
            "value": "prores-422-hq"
          },
          {
            "label": "av1-8-bit",
            "value": "av1-8-bit"
          },
          {
            "label": "av1-10-bit",
            "value": "av1-10-bit"
          },
          {
            "label": "vp9-good",
            "value": "vp9-good"
          },
          {
            "label": "vp9-best",
            "value": "vp9-best"
          }
        ],
        "default": "h265-main"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-enhance-topaz-starlight-precise': {
    "id": "krea-enhance-topaz-starlight-precise",
    "displayName": "Topaz Starlight Precise (Krea)",
    "category": "transform",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/enhance/topaz/starlight-precise",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "video_url",
        "label": "Video URL",
        "dataType": "Video",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "target_width",
        "label": "Target width",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 8000,
        "step": 0.01
      },
      {
        "key": "target_height",
        "label": "Target height",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 8000,
        "step": 0.01
      },
      {
        "key": "crop_to_fit",
        "label": "Crop to fit",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "video_url",
        "label": "Video URL",
        "required": true,
        "type": "string"
      },
      {
        "key": "frame_interpolation",
        "label": "Frame interpolation",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "frame_interpolation_fps",
        "label": "Frame interpolation fps",
        "required": false,
        "type": "integer",
        "min": 15,
        "max": 240,
        "step": 1,
        "default": 60
      },
      {
        "key": "frame_interpolation_model",
        "label": "Frame interpolation model",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "apo-8",
            "value": "apo-8"
          },
          {
            "label": "apf-2",
            "value": "apf-2"
          },
          {
            "label": "chr-2",
            "value": "chr-2"
          },
          {
            "label": "chf-3",
            "value": "chf-3"
          }
        ],
        "default": "apo-8"
      },
      {
        "key": "frame_interpolation_slowmo",
        "label": "Frame interpolation slowmo",
        "required": false,
        "type": "integer",
        "min": 1,
        "max": 16,
        "step": 1,
        "default": 1
      },
      {
        "key": "frame_interpolation_fix_duplicate_frames",
        "label": "Frame interpolation fix duplicate frames",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "frame_interpolation_duplicate_sensitivity",
        "label": "Frame interpolation duplicate sensitivity",
        "required": false,
        "type": "float",
        "min": 0.001,
        "max": 0.1,
        "step": 0.01,
        "default": 0.01
      },
      {
        "key": "video_output_preset",
        "label": "Video output preset",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "h264-high",
            "value": "h264-high"
          },
          {
            "label": "h265-main",
            "value": "h265-main"
          },
          {
            "label": "h265-main10",
            "value": "h265-main10"
          },
          {
            "label": "prores-422-proxy",
            "value": "prores-422-proxy"
          },
          {
            "label": "prores-422-lt",
            "value": "prores-422-lt"
          },
          {
            "label": "prores-422-std",
            "value": "prores-422-std"
          },
          {
            "label": "prores-422-hq",
            "value": "prores-422-hq"
          },
          {
            "label": "av1-8-bit",
            "value": "av1-8-bit"
          },
          {
            "label": "av1-10-bit",
            "value": "av1-10-bit"
          },
          {
            "label": "vp9-good",
            "value": "vp9-good"
          },
          {
            "label": "vp9-best",
            "value": "vp9-best"
          }
        ],
        "default": "h265-main"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-enhance-topaz-starlight-precise-25': {
    "id": "krea-enhance-topaz-starlight-precise-25",
    "displayName": "Topaz Starlight Precise 2.5 (Krea)",
    "category": "transform",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/enhance/topaz/starlight-precise-25",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "video_url",
        "label": "Video URL",
        "dataType": "Video",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "target_width",
        "label": "Target width",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 8000,
        "step": 0.01
      },
      {
        "key": "target_height",
        "label": "Target height",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 8000,
        "step": 0.01
      },
      {
        "key": "crop_to_fit",
        "label": "Crop to fit",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "video_url",
        "label": "Video URL",
        "required": true,
        "type": "string"
      },
      {
        "key": "frame_interpolation",
        "label": "Frame interpolation",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "frame_interpolation_fps",
        "label": "Frame interpolation fps",
        "required": false,
        "type": "integer",
        "min": 15,
        "max": 240,
        "step": 1,
        "default": 60
      },
      {
        "key": "frame_interpolation_model",
        "label": "Frame interpolation model",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "apo-8",
            "value": "apo-8"
          },
          {
            "label": "apf-2",
            "value": "apf-2"
          },
          {
            "label": "chr-2",
            "value": "chr-2"
          },
          {
            "label": "chf-3",
            "value": "chf-3"
          }
        ],
        "default": "apo-8"
      },
      {
        "key": "frame_interpolation_slowmo",
        "label": "Frame interpolation slowmo",
        "required": false,
        "type": "integer",
        "min": 1,
        "max": 16,
        "step": 1,
        "default": 1
      },
      {
        "key": "frame_interpolation_fix_duplicate_frames",
        "label": "Frame interpolation fix duplicate frames",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "frame_interpolation_duplicate_sensitivity",
        "label": "Frame interpolation duplicate sensitivity",
        "required": false,
        "type": "float",
        "min": 0.001,
        "max": 0.1,
        "step": 0.01,
        "default": 0.01
      },
      {
        "key": "video_output_preset",
        "label": "Video output preset",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "h264-high",
            "value": "h264-high"
          },
          {
            "label": "h265-main",
            "value": "h265-main"
          },
          {
            "label": "h265-main10",
            "value": "h265-main10"
          },
          {
            "label": "prores-422-proxy",
            "value": "prores-422-proxy"
          },
          {
            "label": "prores-422-lt",
            "value": "prores-422-lt"
          },
          {
            "label": "prores-422-std",
            "value": "prores-422-std"
          },
          {
            "label": "prores-422-hq",
            "value": "prores-422-hq"
          },
          {
            "label": "av1-8-bit",
            "value": "av1-8-bit"
          },
          {
            "label": "av1-10-bit",
            "value": "av1-10-bit"
          },
          {
            "label": "vp9-good",
            "value": "vp9-good"
          },
          {
            "label": "vp9-best",
            "value": "vp9-best"
          }
        ],
        "default": "h265-main"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-enhance-topaz-astra': {
    "id": "krea-enhance-topaz-astra",
    "displayName": "Topaz Astra (Krea)",
    "category": "transform",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/enhance/topaz/astra",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "video_url",
        "label": "Video URL",
        "dataType": "Video",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "target_width",
        "label": "Target width",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 8000,
        "step": 0.01
      },
      {
        "key": "target_height",
        "label": "Target height",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 8000,
        "step": 0.01
      },
      {
        "key": "crop_to_fit",
        "label": "Crop to fit",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "creativity",
        "label": "Creativity",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "low",
            "value": "low"
          },
          {
            "label": "high",
            "value": "high"
          }
        ],
        "default": "low"
      },
      {
        "key": "video_url",
        "label": "Video URL",
        "required": true,
        "type": "string"
      },
      {
        "key": "frame_interpolation",
        "label": "Frame interpolation",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "frame_interpolation_fps",
        "label": "Frame interpolation fps",
        "required": false,
        "type": "integer",
        "min": 15,
        "max": 240,
        "step": 1,
        "default": 60
      },
      {
        "key": "frame_interpolation_model",
        "label": "Frame interpolation model",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "apo-8",
            "value": "apo-8"
          },
          {
            "label": "apf-2",
            "value": "apf-2"
          },
          {
            "label": "chr-2",
            "value": "chr-2"
          },
          {
            "label": "chf-3",
            "value": "chf-3"
          }
        ],
        "default": "apo-8"
      },
      {
        "key": "frame_interpolation_slowmo",
        "label": "Frame interpolation slowmo",
        "required": false,
        "type": "integer",
        "min": 1,
        "max": 16,
        "step": 1,
        "default": 1
      },
      {
        "key": "frame_interpolation_fix_duplicate_frames",
        "label": "Frame interpolation fix duplicate frames",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "frame_interpolation_duplicate_sensitivity",
        "label": "Frame interpolation duplicate sensitivity",
        "required": false,
        "type": "float",
        "min": 0.001,
        "max": 0.1,
        "step": 0.01,
        "default": 0.01
      },
      {
        "key": "video_output_preset",
        "label": "Video output preset",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "h264-high",
            "value": "h264-high"
          },
          {
            "label": "h265-main",
            "value": "h265-main"
          },
          {
            "label": "h265-main10",
            "value": "h265-main10"
          },
          {
            "label": "prores-422-proxy",
            "value": "prores-422-proxy"
          },
          {
            "label": "prores-422-lt",
            "value": "prores-422-lt"
          },
          {
            "label": "prores-422-std",
            "value": "prores-422-std"
          },
          {
            "label": "prores-422-hq",
            "value": "prores-422-hq"
          },
          {
            "label": "av1-8-bit",
            "value": "av1-8-bit"
          },
          {
            "label": "av1-10-bit",
            "value": "av1-10-bit"
          },
          {
            "label": "vp9-good",
            "value": "vp9-good"
          },
          {
            "label": "vp9-best",
            "value": "vp9-best"
          }
        ],
        "default": "h265-main"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-enhance-topaz-astra-2': {
    "id": "krea-enhance-topaz-astra-2",
    "displayName": "Topaz Astra 2 (Krea)",
    "category": "transform",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/enhance/topaz/astra-2",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "video_url",
        "label": "Video URL",
        "dataType": "Video",
        "required": false
      },
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "target_width",
        "label": "Target width",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 8000,
        "step": 0.01
      },
      {
        "key": "target_height",
        "label": "Target height",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 8000,
        "step": 0.01
      },
      {
        "key": "crop_to_fit",
        "label": "Crop to fit",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "creativity",
        "label": "Creativity",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "low",
            "value": "low"
          },
          {
            "label": "middle",
            "value": "middle"
          },
          {
            "label": "high",
            "value": "high"
          }
        ],
        "default": "middle"
      },
      {
        "key": "sharp",
        "label": "Sharp",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 0.5
      },
      {
        "key": "realism",
        "label": "Realism",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01
      },
      {
        "key": "video_url",
        "label": "Video URL",
        "required": true,
        "type": "string"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": false,
        "type": "textarea"
      },
      {
        "key": "frame_interpolation",
        "label": "Frame interpolation",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "frame_interpolation_fps",
        "label": "Frame interpolation fps",
        "required": false,
        "type": "integer",
        "min": 15,
        "max": 240,
        "step": 1,
        "default": 60
      },
      {
        "key": "frame_interpolation_model",
        "label": "Frame interpolation model",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "apo-8",
            "value": "apo-8"
          },
          {
            "label": "apf-2",
            "value": "apf-2"
          },
          {
            "label": "chr-2",
            "value": "chr-2"
          },
          {
            "label": "chf-3",
            "value": "chf-3"
          }
        ],
        "default": "apo-8"
      },
      {
        "key": "frame_interpolation_slowmo",
        "label": "Frame interpolation slowmo",
        "required": false,
        "type": "integer",
        "min": 1,
        "max": 16,
        "step": 1,
        "default": 1
      },
      {
        "key": "frame_interpolation_fix_duplicate_frames",
        "label": "Frame interpolation fix duplicate frames",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "frame_interpolation_duplicate_sensitivity",
        "label": "Frame interpolation duplicate sensitivity",
        "required": false,
        "type": "float",
        "min": 0.001,
        "max": 0.1,
        "step": 0.01,
        "default": 0.01
      },
      {
        "key": "video_output_preset",
        "label": "Video output preset",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "h264-high",
            "value": "h264-high"
          },
          {
            "label": "h265-main",
            "value": "h265-main"
          },
          {
            "label": "h265-main10",
            "value": "h265-main10"
          },
          {
            "label": "prores-422-proxy",
            "value": "prores-422-proxy"
          },
          {
            "label": "prores-422-lt",
            "value": "prores-422-lt"
          },
          {
            "label": "prores-422-std",
            "value": "prores-422-std"
          },
          {
            "label": "prores-422-hq",
            "value": "prores-422-hq"
          },
          {
            "label": "av1-8-bit",
            "value": "av1-8-bit"
          },
          {
            "label": "av1-10-bit",
            "value": "av1-10-bit"
          },
          {
            "label": "vp9-good",
            "value": "vp9-good"
          },
          {
            "label": "vp9-best",
            "value": "vp9-best"
          }
        ],
        "default": "h265-main"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-enhance-topaz-hyperion': {
    "id": "krea-enhance-topaz-hyperion",
    "displayName": "Topaz Hyperion 2.5 (Krea)",
    "category": "transform",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/enhance/topaz/hyperion",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "video_url",
        "label": "Video URL",
        "dataType": "Video",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "target_width",
        "label": "Target width",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 8000,
        "step": 0.01
      },
      {
        "key": "target_height",
        "label": "Target height",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 8000,
        "step": 0.01
      },
      {
        "key": "crop_to_fit",
        "label": "Crop to fit",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "video_url",
        "label": "Video URL",
        "required": true,
        "type": "string"
      },
      {
        "key": "frame_interpolation",
        "label": "Frame interpolation",
        "required": false,
        "type": "boolean",
        "default": false
      },
      {
        "key": "frame_interpolation_fps",
        "label": "Frame interpolation fps",
        "required": false,
        "type": "integer",
        "min": 15,
        "max": 240,
        "step": 1,
        "default": 60
      },
      {
        "key": "frame_interpolation_model",
        "label": "Frame interpolation model",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "apo-8",
            "value": "apo-8"
          },
          {
            "label": "apf-2",
            "value": "apf-2"
          },
          {
            "label": "chr-2",
            "value": "chr-2"
          },
          {
            "label": "chf-3",
            "value": "chf-3"
          }
        ],
        "default": "apo-8"
      },
      {
        "key": "frame_interpolation_slowmo",
        "label": "Frame interpolation slowmo",
        "required": false,
        "type": "integer",
        "min": 1,
        "max": 16,
        "step": 1,
        "default": 1
      },
      {
        "key": "frame_interpolation_fix_duplicate_frames",
        "label": "Frame interpolation fix duplicate frames",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "frame_interpolation_duplicate_sensitivity",
        "label": "Frame interpolation duplicate sensitivity",
        "required": false,
        "type": "float",
        "min": 0.001,
        "max": 0.1,
        "step": 0.01,
        "default": 0.01
      },
      {
        "key": "video_output_preset",
        "label": "Video output preset",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "h264-high",
            "value": "h264-high"
          },
          {
            "label": "h265-main",
            "value": "h265-main"
          },
          {
            "label": "h265-main10",
            "value": "h265-main10"
          },
          {
            "label": "prores-422-proxy",
            "value": "prores-422-proxy"
          },
          {
            "label": "prores-422-lt",
            "value": "prores-422-lt"
          },
          {
            "label": "prores-422-std",
            "value": "prores-422-std"
          },
          {
            "label": "prores-422-hq",
            "value": "prores-422-hq"
          },
          {
            "label": "av1-8-bit",
            "value": "av1-8-bit"
          },
          {
            "label": "av1-10-bit",
            "value": "av1-10-bit"
          },
          {
            "label": "vp9-good",
            "value": "vp9-good"
          },
          {
            "label": "vp9-best",
            "value": "vp9-best"
          }
        ],
        "default": "h265-main10"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-enhance-bytedance-seedvr-2': {
    "id": "krea-enhance-bytedance-seedvr-2",
    "displayName": "SeedVR 2 (Krea)",
    "category": "transform",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/enhance/bytedance/seedvr-2",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "video_url",
        "label": "Video URL",
        "dataType": "Video",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "target_width",
        "label": "Target width",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 3840,
        "step": 0.01
      },
      {
        "key": "target_height",
        "label": "Target height",
        "required": false,
        "type": "float",
        "min": 1,
        "max": 3840,
        "step": 0.01
      },
      {
        "key": "noise_scale",
        "label": "Noise scale",
        "required": false,
        "type": "float",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "default": 0.1
      },
      {
        "key": "video_url",
        "label": "Video URL",
        "required": true,
        "type": "string"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-enhance-black-forest-labs-flux-video-upscale': {
    "id": "krea-enhance-black-forest-labs-flux-video-upscale",
    "displayName": "Flux Video Upscale (Krea)",
    "category": "transform",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/enhance/black-forest-labs/flux-video-upscale",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "video_url",
        "label": "Video URL",
        "dataType": "Video",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "creativity",
        "label": "Creativity",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "precise",
            "value": "precise"
          },
          {
            "label": "creative",
            "value": "creative"
          }
        ],
        "default": "creative"
      },
      {
        "key": "upscale_factor",
        "label": "Upscale factor",
        "required": false,
        "type": "float",
        "min": 1.5,
        "max": 3,
        "step": 0.01,
        "default": 2
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": false,
        "type": "textarea"
      },
      {
        "key": "video_url",
        "label": "Video URL",
        "required": true,
        "type": "string"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-enhance-runway-ruby': {
    "id": "krea-enhance-runway-ruby",
    "displayName": "Runway Ruby (Krea)",
    "category": "transform",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/enhance/runway/ruby",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "video_url",
        "label": "Video URL",
        "dataType": "Video",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Video",
        "dataType": "Video",
        "required": true
      },
      {
        "id": "videos",
        "label": "All videos",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "output_format",
        "label": "Output format",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "hdr10",
            "value": "hdr10"
          },
          {
            "label": "hlg",
            "value": "hlg"
          },
          {
            "label": "hdr_prores",
            "value": "hdr_prores"
          }
        ],
        "default": "hdr10"
      },
      {
        "key": "video_url",
        "label": "Video URL",
        "required": true,
        "type": "string"
      },
      {
        "key": "prores_profile",
        "label": "Prores profile",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "422",
            "value": "422"
          },
          {
            "label": "4444",
            "value": "4444"
          },
          {
            "label": "422 HQ",
            "value": "422 HQ"
          }
        ]
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-3d-tencent-hunyuan3d-3-1-pro': {
    "id": "krea-3d-tencent-hunyuan3d-3-1-pro",
    "displayName": "Hunyuan3D 3.1 Pro (Krea)",
    "category": "3d-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/3d/tencent/hunyuan3d-3.1-pro",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "back_image_url",
        "label": "Back image URL",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "left_image_url",
        "label": "Left image URL",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "right_image_url",
        "label": "Right image URL",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "top_image_url",
        "label": "Top image URL",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "bottom_image_url",
        "label": "Bottom image URL",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "left_front_image_url",
        "label": "Left front image URL",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "right_front_image_url",
        "label": "Right front image URL",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "image_urls",
        "label": "Image URLs",
        "dataType": "Image",
        "required": false,
        "multiple": true
      }
    ],
    "outputPorts": [
      {
        "id": "mesh",
        "label": "Mesh",
        "dataType": "Mesh",
        "required": true
      },
      {
        "id": "meshes",
        "label": "All meshes",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": false,
        "type": "textarea"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "input_mode",
        "label": "Input mode",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "image",
            "value": "image"
          },
          {
            "label": "text",
            "value": "text"
          }
        ],
        "default": "image"
      },
      {
        "key": "generate_texture",
        "label": "Generate texture",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "enable_pbr",
        "label": "Enable pbr",
        "required": false,
        "type": "boolean"
      },
      {
        "key": "face_count",
        "label": "Face count",
        "required": false,
        "type": "float",
        "min": 40000,
        "max": 1500000,
        "step": 0.01
      },
      {
        "key": "back_image_url",
        "label": "Back image URL",
        "required": false,
        "type": "string"
      },
      {
        "key": "left_image_url",
        "label": "Left image URL",
        "required": false,
        "type": "string"
      },
      {
        "key": "right_image_url",
        "label": "Right image URL",
        "required": false,
        "type": "string"
      },
      {
        "key": "top_image_url",
        "label": "Top image URL",
        "required": false,
        "type": "string"
      },
      {
        "key": "bottom_image_url",
        "label": "Bottom image URL",
        "required": false,
        "type": "string"
      },
      {
        "key": "left_front_image_url",
        "label": "Left front image URL",
        "required": false,
        "type": "string"
      },
      {
        "key": "right_front_image_url",
        "label": "Right front image URL",
        "required": false,
        "type": "string"
      },
      {
        "key": "image_urls",
        "label": "Image URLs (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model",
        "default": "[]"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-3d-microsoft-trellis-2': {
    "id": "krea-3d-microsoft-trellis-2",
    "displayName": "TRELLIS 2 (Krea)",
    "category": "3d-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/3d/microsoft/trellis-2",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_urls",
        "label": "Image URLs",
        "dataType": "Image",
        "required": false,
        "multiple": true
      }
    ],
    "outputPorts": [
      {
        "id": "mesh",
        "label": "Mesh",
        "dataType": "Mesh",
        "required": true
      },
      {
        "id": "meshes",
        "label": "All meshes",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": false,
        "type": "textarea"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "input_mode",
        "label": "Input mode",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "image",
            "value": "image"
          },
          {
            "label": "text",
            "value": "text"
          }
        ],
        "default": "image"
      },
      {
        "key": "generate_texture",
        "label": "Generate texture",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "resolution",
        "label": "Resolution",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "512",
            "value": "512"
          },
          {
            "label": "1024",
            "value": "1024"
          },
          {
            "label": "1536",
            "value": "1536"
          }
        ]
      },
      {
        "key": "texture_size",
        "label": "Texture size",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "1024",
            "value": "1024"
          },
          {
            "label": "2048",
            "value": "2048"
          },
          {
            "label": "4096",
            "value": "4096"
          }
        ]
      },
      {
        "key": "decimation_target",
        "label": "Decimation target",
        "required": false,
        "type": "float",
        "min": 100000,
        "max": 2000000,
        "step": 0.01
      },
      {
        "key": "image_urls",
        "label": "Image URLs (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model",
        "default": "[]"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-3d-tencent-hunyuan3d-2-1': {
    "id": "krea-3d-tencent-hunyuan3d-2-1",
    "displayName": "Hunyuan3D-2.1 (Krea)",
    "category": "3d-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/3d/tencent/hunyuan3d-2.1",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_urls",
        "label": "Image URLs",
        "dataType": "Image",
        "required": false,
        "multiple": true
      }
    ],
    "outputPorts": [
      {
        "id": "mesh",
        "label": "Mesh",
        "dataType": "Mesh",
        "required": true
      },
      {
        "id": "meshes",
        "label": "All meshes",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": false,
        "type": "textarea"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      },
      {
        "key": "input_mode",
        "label": "Input mode",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "image",
            "value": "image"
          },
          {
            "label": "text",
            "value": "text"
          }
        ],
        "default": "image"
      },
      {
        "key": "generate_texture",
        "label": "Generate texture",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "image_urls",
        "label": "Image URLs (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model",
        "default": "[]"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-3d-tripo-tripo': {
    "id": "krea-3d-tripo-tripo",
    "displayName": "Tripo (Krea)",
    "category": "3d-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/3d/tripo/tripo",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_urls",
        "label": "Image URLs",
        "dataType": "Image",
        "required": false,
        "multiple": true
      }
    ],
    "outputPorts": [
      {
        "id": "mesh",
        "label": "Mesh",
        "dataType": "Mesh",
        "required": true
      },
      {
        "id": "meshes",
        "label": "All meshes",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": false,
        "type": "textarea"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "input_mode",
        "label": "Input mode",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "image",
            "value": "image"
          },
          {
            "label": "text",
            "value": "text"
          }
        ],
        "default": "image"
      },
      {
        "key": "generate_texture",
        "label": "Generate texture",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "image_urls",
        "label": "Image URLs (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model",
        "default": "[]"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-3d-tripo-h3-1': {
    "id": "krea-3d-tripo-h3-1",
    "displayName": "Tripo H3.1 (Krea)",
    "category": "3d-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/3d/tripo/h3.1",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_urls",
        "label": "Image URLs",
        "dataType": "Image",
        "required": false,
        "multiple": true
      }
    ],
    "outputPorts": [
      {
        "id": "mesh",
        "label": "Mesh",
        "dataType": "Mesh",
        "required": true
      },
      {
        "id": "meshes",
        "label": "All meshes",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": false,
        "type": "textarea"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "input_mode",
        "label": "Input mode",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "image",
            "value": "image"
          },
          {
            "label": "text",
            "value": "text"
          }
        ],
        "default": "image"
      },
      {
        "key": "generate_texture",
        "label": "Generate texture",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "face_limit",
        "label": "Face limit",
        "required": false,
        "type": "float",
        "min": 1000,
        "max": 2000000,
        "step": 0.01
      },
      {
        "key": "image_urls",
        "label": "Image URLs (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model",
        "default": "[]"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-3d-hyper3d-rodin-2-5': {
    "id": "krea-3d-hyper3d-rodin-2-5",
    "displayName": "Rodin V2.5 (Krea)",
    "category": "3d-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/3d/hyper3d/rodin-2.5",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_urls",
        "label": "Image URLs",
        "dataType": "Image",
        "required": false,
        "multiple": true,
        "maxConnections": 5
      }
    ],
    "outputPorts": [
      {
        "id": "mesh",
        "label": "Mesh",
        "dataType": "Mesh",
        "required": true
      },
      {
        "id": "meshes",
        "label": "All meshes",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": false,
        "type": "textarea"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "input_mode",
        "label": "Input mode",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "image",
            "value": "image"
          },
          {
            "label": "text",
            "value": "text"
          }
        ],
        "default": "image"
      },
      {
        "key": "generate_texture",
        "label": "Generate texture",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "image_urls",
        "label": "Image URLs (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model",
        "default": "[]"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-3d-hyper3d-rodin-2-5-fast': {
    "id": "krea-3d-hyper3d-rodin-2-5-fast",
    "displayName": "Rodin V2.5 Fast (Krea)",
    "category": "3d-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/3d/hyper3d/rodin-2.5-fast",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_urls",
        "label": "Image URLs",
        "dataType": "Image",
        "required": false,
        "multiple": true,
        "maxConnections": 5
      }
    ],
    "outputPorts": [
      {
        "id": "mesh",
        "label": "Mesh",
        "dataType": "Mesh",
        "required": true
      },
      {
        "id": "meshes",
        "label": "All meshes",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": false,
        "type": "textarea"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "input_mode",
        "label": "Input mode",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "image",
            "value": "image"
          },
          {
            "label": "text",
            "value": "text"
          }
        ],
        "default": "image"
      },
      {
        "key": "generate_texture",
        "label": "Generate texture",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "image_urls",
        "label": "Image URLs (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model",
        "default": "[]"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-3d-tencent-hunyuan3d-3-1-rapid': {
    "id": "krea-3d-tencent-hunyuan3d-3-1-rapid",
    "displayName": "Hunyuan3D 3.1 Rapid (Krea)",
    "category": "3d-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/3d/tencent/hunyuan3d-3.1-rapid",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_urls",
        "label": "Image URLs",
        "dataType": "Image",
        "required": false,
        "multiple": true
      }
    ],
    "outputPorts": [
      {
        "id": "mesh",
        "label": "Mesh",
        "dataType": "Mesh",
        "required": true
      },
      {
        "id": "meshes",
        "label": "All meshes",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": false,
        "type": "textarea"
      },
      {
        "key": "input_mode",
        "label": "Input mode",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "image",
            "value": "image"
          },
          {
            "label": "text",
            "value": "text"
          }
        ],
        "default": "image"
      },
      {
        "key": "generate_texture",
        "label": "Generate texture",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "image_urls",
        "label": "Image URLs (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model",
        "default": "[]"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-3d-meshy-meshy-7': {
    "id": "krea-3d-meshy-meshy-7",
    "displayName": "Meshy V7 (Krea)",
    "category": "3d-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/3d/meshy/meshy-7",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_urls",
        "label": "Image URLs",
        "dataType": "Image",
        "required": false,
        "multiple": true
      }
    ],
    "outputPorts": [
      {
        "id": "mesh",
        "label": "Mesh",
        "dataType": "Mesh",
        "required": true
      },
      {
        "id": "meshes",
        "label": "All meshes",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": false,
        "type": "textarea"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "input_mode",
        "label": "Input mode",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "image",
            "value": "image"
          },
          {
            "label": "text",
            "value": "text"
          }
        ],
        "default": "image"
      },
      {
        "key": "generate_texture",
        "label": "Generate texture",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "target_polycount",
        "label": "Target polycount",
        "required": false,
        "type": "float",
        "min": 100,
        "max": 300000,
        "step": 0.01
      },
      {
        "key": "enable_pbr",
        "label": "Enable pbr",
        "required": false,
        "type": "boolean"
      },
      {
        "key": "image_urls",
        "label": "Image URLs (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model",
        "default": "[]"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-3d-microsoft-trellis': {
    "id": "krea-3d-microsoft-trellis",
    "displayName": "TRELLIS (Krea)",
    "category": "3d-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/3d/microsoft/trellis",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_urls",
        "label": "Image URLs",
        "dataType": "Image",
        "required": false,
        "multiple": true
      }
    ],
    "outputPorts": [
      {
        "id": "mesh",
        "label": "Mesh",
        "dataType": "Mesh",
        "required": true
      },
      {
        "id": "meshes",
        "label": "All meshes",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": false,
        "type": "textarea"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "input_mode",
        "label": "Input mode",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "image",
            "value": "image"
          },
          {
            "label": "text",
            "value": "text"
          }
        ],
        "default": "image"
      },
      {
        "key": "generate_texture",
        "label": "Generate texture",
        "required": false,
        "type": "boolean",
        "default": true
      },
      {
        "key": "texture_size",
        "label": "Texture size",
        "required": false,
        "type": "float",
        "step": 0.01
      },
      {
        "key": "image_urls",
        "label": "Image URLs (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model",
        "default": "[]"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-ideogram-ideogram-4-5-precise': {
    "id": "krea-image-ideogram-ideogram-4-5-precise",
    "displayName": "Ideogram 4.5 Precise (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/ideogram/ideogram-4.5-precise",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_url",
        "label": "Image URL",
        "dataType": "Image",
        "required": false
      },
      {
        "id": "mask_url",
        "label": "Mask URL",
        "dataType": "Mask",
        "required": false
      },
      {
        "id": "reference_images",
        "label": "Reference images",
        "dataType": "Image",
        "required": false,
        "multiple": true,
        "maxConnections": 4
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "integer",
        "min": 0,
        "max": 2147483647,
        "step": 1
      },
      {
        "key": "quality",
        "label": "Quality",
        "required": false,
        "type": "enum",
        "options": [
          {
            "label": "very_low",
            "value": "very_low"
          },
          {
            "label": "low",
            "value": "low"
          },
          {
            "label": "medium",
            "value": "medium"
          },
          {
            "label": "high",
            "value": "high"
          }
        ],
        "default": "high"
      },
      {
        "key": "image_url",
        "label": "Image URL",
        "required": true,
        "type": "string"
      },
      {
        "key": "mask_url",
        "label": "Mask URL",
        "required": false,
        "type": "string"
      },
      {
        "key": "reference_images",
        "label": "Reference images (JSON)",
        "required": false,
        "type": "textarea",
        "placeholder": "JSON array or object matching this model",
        "default": "[]"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-image-bytedance-seededit': {
    "id": "krea-image-bytedance-seededit",
    "displayName": "SeedEdit (Krea)",
    "category": "image-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/image/bytedance/seededit",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      },
      {
        "id": "image_url",
        "label": "Image URL",
        "dataType": "Image",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "image",
        "label": "Image",
        "dataType": "Image",
        "required": true
      },
      {
        "id": "images",
        "label": "All images",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "seed",
        "label": "Seed",
        "required": false,
        "type": "float",
        "step": 0.01,
        "default": 1337
      },
      {
        "key": "image_url",
        "label": "Image URL",
        "required": true,
        "type": "string"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-audio-bytedance-seed-audio-1-0': {
    "id": "krea-audio-bytedance-seed-audio-1-0",
    "displayName": "Seed Audio 1.0 (Krea)",
    "category": "audio-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/audio/bytedance/seed-audio-1.0",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "audio",
        "label": "Audio",
        "dataType": "Audio",
        "required": true
      },
      {
        "id": "audios",
        "label": "All audios",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-audio-elevenlabs-tts': {
    "id": "krea-audio-elevenlabs-tts",
    "displayName": "ElevenLabs TTS (Krea)",
    "category": "audio-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/audio/elevenlabs/tts",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "audio",
        "label": "Audio",
        "dataType": "Audio",
        "required": true
      },
      {
        "id": "audios",
        "label": "All audios",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "voice_id",
        "label": "Voice id",
        "required": false,
        "type": "string",
        "default": "hpp4J3VqNfWAUOO0d1Us"
      },
      {
        "key": "model_id",
        "label": "Model id",
        "required": false,
        "type": "string",
        "default": "eleven_multilingual_v2"
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-audio-elevenlabs-music': {
    "id": "krea-audio-elevenlabs-music",
    "displayName": "ElevenLabs Music (Krea)",
    "category": "audio-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/audio/elevenlabs/music",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "audio",
        "label": "Audio",
        "dataType": "Audio",
        "required": true
      },
      {
        "id": "audios",
        "label": "All audios",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "music_length_ms",
        "label": "Music length ms",
        "required": false,
        "type": "integer",
        "min": 3000,
        "max": 600000,
        "step": 1
      },
      {
        "key": "force_instrumental",
        "label": "Force instrumental",
        "required": false,
        "type": "boolean",
        "default": false
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-audio-elevenlabs-music-v2': {
    "id": "krea-audio-elevenlabs-music-v2",
    "displayName": "ElevenLabs Music v2 (Krea)",
    "category": "audio-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/audio/elevenlabs/music-v2",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "audio",
        "label": "Audio",
        "dataType": "Audio",
        "required": true
      },
      {
        "id": "audios",
        "label": "All audios",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "music_length_ms",
        "label": "Music length ms",
        "required": false,
        "type": "integer",
        "min": 3000,
        "max": 600000,
        "step": 1
      },
      {
        "key": "force_instrumental",
        "label": "Force instrumental",
        "required": false,
        "type": "boolean",
        "default": false
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  'krea-audio-elevenlabs-music-v2-5': {
    "id": "krea-audio-elevenlabs-music-v2-5",
    "displayName": "ElevenLabs Music v2.5 (Krea)",
    "category": "audio-gen",
    "apiProvider": "krea",
    "apiEndpoint": "/generate/audio/elevenlabs/music-v2.5",
    "envKeyName": "KREA_API_TOKEN",
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "prompt",
        "label": "Prompt",
        "dataType": "Text",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "audio",
        "label": "Audio",
        "dataType": "Audio",
        "required": true
      },
      {
        "id": "audios",
        "label": "All audios",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "artifacts",
        "label": "All artifacts",
        "dataType": "Array",
        "required": false
      },
      {
        "id": "job",
        "label": "Job",
        "dataType": "Any",
        "required": false
      }
    ],
    "params": [
      {
        "key": "_kreaAuth",
        "label": "Krea connection",
        "type": "enum",
        "required": false,
        "options": [
          {
            "value": "api-token",
            "label": "API token · API balance"
          },
          {
            "value": "mcp",
            "label": "Krea account · workspace compute"
          }
        ],
        "default": "api-token"
      },
      {
        "key": "prompt",
        "label": "Prompt",
        "required": true,
        "type": "textarea"
      },
      {
        "key": "music_length_ms",
        "label": "Music length ms",
        "required": false,
        "type": "integer",
        "min": 3000,
        "max": 600000,
        "step": 1
      },
      {
        "key": "force_instrumental",
        "label": "Force instrumental",
        "required": false,
        "type": "boolean",
        "default": false
      }
    ],
    "docUrl": "docs/model-providers/krea/krea-gateway.md"
  },
  // END GENERATED KREA CATALOG
};

export function getNodeDefinition(definitionId: string): ModelNodeDefinition | undefined {
  return NODE_DEFINITIONS[definitionId];
}

// Display order for categories in the node library panel. Categories not listed
// here fall to the bottom in the order they're first encountered.
const CATEGORY_ORDER: readonly string[] = [
  'utility',
  'cinematic',
  'character',
  'text-gen',
  'image-gen',
  'video-gen',
  'audio-gen',
  'transform',
  'analyzer',
  'universal',
];

export function getNodesByCategory(): Record<string, ModelNodeDefinition[]> {
  const grouped: Record<string, ModelNodeDefinition[]> = {};
  for (const def of Object.values(NODE_DEFINITIONS)) {
    if (!grouped[def.category]) {
      grouped[def.category] = [];
    }
    grouped[def.category].push(def);
  }
  // Rebuild the object so Object.entries iterates in CATEGORY_ORDER.
  const ordered: Record<string, ModelNodeDefinition[]> = {};
  for (const cat of CATEGORY_ORDER) {
    if (grouped[cat]) ordered[cat] = grouped[cat];
  }
  for (const [cat, defs] of Object.entries(grouped)) {
    if (!(cat in ordered)) ordered[cat] = defs;
  }
  return ordered;
}
