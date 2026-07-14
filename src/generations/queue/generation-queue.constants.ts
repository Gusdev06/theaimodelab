export const GENERATION_QUEUE = 'generation';
export const GENERATION_UNLIMITED_QUEUE = 'generation-unlimited';

export enum GenerationJobName {
  IMAGE = 'image',
  IMAGE_WITH_FALLBACK = 'image-with-fallback',
  IMAGE_NANO_BANANA = 'image-nano-banana',
  TEXT_TO_VIDEO = 'text-to-video',
  IMAGE_TO_VIDEO = 'image-to-video',
  REFERENCE_VIDEO = 'reference-video',
  MOTION_CONTROL = 'motion-control',
  VIRTUAL_TRY_ON = 'virtual-try-on',
  FACE_SWAP = 'face-swap',
  TEXT_TO_VIDEO_KIE = 'text-to-video-kie',
  IMAGE_TO_VIDEO_KIE = 'image-to-video-kie',
  REFERENCE_TO_VIDEO_KIE = 'reference-to-video-kie',
  IMAGE_TO_VIDEO_GROK = 'image-to-video-grok',
  TEXT_TO_VIDEO_GROK = 'text-to-video-grok',
  OMNI_VIDEO = 'omni-video',
  SEEDANCE_VIDEO = 'seedance-video',
  KLING_IMAGE_TO_VIDEO = 'kling-image-to-video',
  COMFYDEPLOY_IMAGE_TO_VIDEO = 'comfydeploy-image-to-video',
  WAVESPEED_IMAGE_TO_VIDEO = 'wavespeed-image-to-video',
  WAVESPEED_SEEDANCE_IMAGE_TO_VIDEO = 'wavespeed-seedance-image-to-video',
}

interface BaseJobData {
  generationId: string;
  userId: string;
  creditsConsumed: number;
  usedFreeGeneration?: boolean;
}

export interface ImageJobData extends BaseJobData {
  prompt: string;
  model: string;
  resolution: string;
  aspectRatio?: string;
  mimeType?: string;
  hasInputImages: boolean;
}

export interface ImageNanoBananaJobData extends BaseJobData {
  prompt: string;
  model: string;
  resolution: string;
  aspectRatio?: string;
  outputFormat?: string;
  googleSearch?: boolean;
  imageUrls?: string[];
}

export interface TextToVideoJobData extends BaseJobData {
  prompt: string;
  model: string;
  resolution: string;
  durationSeconds?: number;
  aspectRatio?: string;
  generateAudio: boolean;
  sampleCount?: number;
  negativePrompt?: string;
}

export interface ImageToVideoJobData extends TextToVideoJobData {
  resolvedModel: string;
}

export interface ReferenceVideoJobData extends TextToVideoJobData {
  resolvedModel: string;
}

export interface MotionControlJobData extends BaseJobData {
  videoUrl: string;
  imageUrl: string;
  resolution: string;
}

export interface VirtualTryOnJobData extends BaseJobData {
  prompt: string;
  model: string;
  resolution: string;
  aspectRatio?: string;
  mimeType?: string;
}

export interface FaceSwapJobData extends BaseJobData {
  sourceImageUrl: string;
  targetImageUrl: string;
  resolution: string;
}

export interface TextToVideoKieJobData extends BaseJobData {
  prompt: string;
  model: string;
  resolution: string;
  aspectRatio?: string;
  generateAudio: boolean;
  seed?: number;
}

export interface ImageToVideoKieJobData extends TextToVideoKieJobData {
  imageUrls: string[];
}

export interface ReferenceToVideoKieJobData extends TextToVideoKieJobData {
  imageUrls: string[];
}

export interface ImageToVideoGrokJobData extends BaseJobData {
  prompt?: string;
  resolution: string;
  durationSeconds: number;
  aspectRatio?: string;
  imageUrls: string[];
  mode?: 'fun' | 'normal' | 'spicy';
}

export interface TextToVideoGrokJobData extends BaseJobData {
  prompt: string;
  resolution: string;
  durationSeconds: number;
  aspectRatio?: string;
  mode?: 'fun' | 'normal' | 'spicy';
}

export interface OmniVideoClipData {
  url: string;
  start: number;
  ends: number;
}

export interface OmniVideoJobData extends BaseJobData {
  prompt: string;
  resolution: string;
  durationSeconds: number;
  aspectRatio?: string;
  imageUrls?: string[];
  videoList?: OmniVideoClipData[];
  hasVideoInput: boolean;
}

export interface SeedanceVideoJobData extends BaseJobData {
  prompt: string;
  resolution: string;
  durationSeconds: number;
  aspectRatio?: string;
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
  generateAudio: boolean;
  hasVideoInput: boolean;
}

export interface KlingImageToVideoJobData extends BaseJobData {
  prompt?: string;
  resolution: string;
  durationSeconds: number;
  imageUrls: string[];
  /** Proporção do vídeo: '16:9' | '9:16' | '1:1' (UI ou detectada da imagem). */
  aspectRatio: string;
  /** Gerar com áudio nativo (Kling V3 Turbo inclui áudio sem custo extra). */
  generateAudio: boolean;
}

export interface ComfyDeployImageToVideoJobData extends BaseJobData {
  prompt: string;
  resolution: string;
  durationSeconds: number;
  imageUrl: string;
}

export interface WavespeedImageToVideoJobData extends BaseJobData {
  prompt: string;
  /** Resolução DB (RES_480P | RES_720P | RES_1080P). */
  resolution: string;
  durationSeconds: number;
  imageUrl: string;
  /** Preset LTX: 'tuned' (recomendado) | 'original'. */
  preset?: 'tuned' | 'original';
}

export interface WavespeedSeedanceImageToVideoJobData extends BaseJobData {
  prompt: string;
  /** Resolução DB (RES_480P | RES_720P | RES_1080P | RES_4K). */
  resolution: string;
  durationSeconds: number;
  imageUrl: string;
  /** Proporção do vídeo (opcional — Seedance adapta à imagem se ausente). */
  aspectRatio?: string;
  /** Áudio nativo (Seedance 2.0 Fast suporta; muda o custo). */
  generateAudio: boolean;
}


// Audio job shapes — no longer queued via BullMQ. Kept here as parameter
// types for the GenerationProcessor's runTextToSpeechDirectly /
// runVoiceCloneDirectly methods, which are invoked synchronously
// (fire-and-forget) from generations.service.
export interface TextToSpeechJobData extends BaseJobData {
  text: string;
  voiceId: string;
  language?: string;
  speed?: number;
}

export interface VoiceCloneJobData extends BaseJobData {
  text: string;
  audioUrl: string;
  language?: string;
}

export type GenerationJobData =
  | ImageJobData
  | ImageNanoBananaJobData
  | TextToVideoJobData
  | ImageToVideoJobData
  | ReferenceVideoJobData
  | MotionControlJobData
  | VirtualTryOnJobData
  | FaceSwapJobData
  | TextToVideoKieJobData
  | ImageToVideoKieJobData
  | ReferenceToVideoKieJobData
  | ImageToVideoGrokJobData
  | TextToVideoGrokJobData
  | OmniVideoJobData
  | SeedanceVideoJobData
  | KlingImageToVideoJobData
  | ComfyDeployImageToVideoJobData
  | WavespeedImageToVideoJobData
  | WavespeedSeedanceImageToVideoJobData;

export const IMAGE_JOB_TIMEOUT = 5 * 60 * 1000; // 5 min
export const VIDEO_JOB_TIMEOUT = 12 * 60 * 1000; // 12 min
