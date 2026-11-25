import type {ImageAspectRatio, ImageStylePreset} from '../types/chat';

export const IMAGE_STYLE_OPTIONS: Array<{
  id: ImageStylePreset;
  label: string;
  promptSuffix: string;
}> = [
  {id: 'auto', label: 'Auto', promptSuffix: ''},
  {
    id: 'photorealistic',
    label: 'Photorealistic',
    promptSuffix:
      'photorealistic DSLR photography, natural lighting, sharp focus, ultra realistic, 8k detail',
  },
  {
    id: 'cinematic',
    label: 'Cinematic',
    promptSuffix:
      'cinematic film still, dramatic moody lighting, shallow depth of field, anamorphic lens, rich color grading',
  },
  {
    id: 'anime',
    label: 'Anime',
    promptSuffix:
      'high quality anime illustration, crisp clean linework, vibrant cel shading, detailed background',
  },
  {
    id: 'cartoon',
    label: 'Cartoon',
    promptSuffix:
      'charming stylized 2D cartoon illustration, expressive character design, clean outlines, vibrant colors',
  },
  {
    id: '3d-render',
    label: '3D Render',
    promptSuffix:
      'octane 3D render, blender studio lighting, smooth materials, global illumination, high detail',
  },
  {
    id: 'product',
    label: 'Product Photo',
    promptSuffix:
      'commercial luxury product photography, studio softbox lighting, clean composition, crisp reflections, macro detail',
  },
  {
    id: 'fashion',
    label: 'Fashion Photo',
    promptSuffix:
      'editorial fashion photography, studio lighting, tailored garment texture, Vogue aesthetic, crisp focus',
  },
  {
    id: 'digital-art',
    label: 'Digital Art',
    promptSuffix:
      'detailed digital concept art, painterly brushwork, atmospheric lighting, rich textures',
  },
  {
    id: 'logo',
    label: 'Logo Concept',
    promptSuffix:
      'clean minimalist vector logo concept, modern flat emblem, balanced geometry, solid clean background, high contrast',
  },
  {
    id: 'wallpaper',
    label: 'Wallpaper',
    promptSuffix:
      'stunning scenic widescreen wallpaper, crisp detail, balanced negative space, vivid atmospheric depth',
  },
];

export const IMAGE_ASPECT_RATIOS: Array<{
  id: ImageAspectRatio;
  label: string;
  width: number;
  height: number;
}> = [
  {id: '1:1', label: '1:1', width: 1024, height: 1024},
  {id: '16:9', label: '16:9', width: 1024, height: 576},
  {id: '9:16', label: '9:16', width: 576, height: 1024},
  {id: '4:3', label: '4:3', width: 1024, height: 768},
];

export function getDimensionsForAspectRatio(ratio: ImageAspectRatio): {
  width: number;
  height: number;
} {
  return (
    IMAGE_ASPECT_RATIOS.find((item) => item.id === ratio) ?? {
      width: 1024,
      height: 1024,
    }
  );
}

const QUESTION_OR_CODE_PREFIX =
  /^(?:how\s+(?:do|can|to)|what\s+is|why\s+(?:is|does|do)|explain|write\s+(?:code|a\s+script|a\s+function|html|css|react|python|js|ts)|debug|fix|compare|list\s+\d+\s+ways|can\s+you\s+explain)\b/i;

const CODE_OR_TEXT_TARGET =
  /\b(?:code|script|function|component|css|html|svg\s+code|react|python|typescript|javascript|prompt\s+template|api|essay|paragraph|email|caption)\b/i;

const EXPLICIT_COMMAND_PREFIX = /^\/(?:imagine|image|img|draw)\s+(.+)$/i;

const VISUAL_GENERATION_VERB_NOUN =
  /\b(?:generate|create|make|draw|paint|render|design|illustrate|sketch|imagine|produce|banao|bana\s+do|dikhao)\b[\s\w,'"-]{0,40}\b(?:image|picture|pic|photo|photograph|artwork|art|illustration|wallpaper|logo|emblem|avatar|portrait|painting|drawing|sketch|poster|banner|thumbnail|cartoon|anime|render|mockup|concept|tasveer)\b/i;

const LEADING_IMAGE_PHRASE =
  /^(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:generate|create|make|draw|paint|render|design|illustrate|sketch|imagine)\s+(?:me\s+)?(?:a|an|the)?\s*(?:realistic|cinematic|cute|futuristic|beautiful|professional|minimalist|3d|anime|cartoon|luxury|vintage|modern|epic|hyperrealistic|photorealistic)?\s*(?:image|picture|photo|logo|wallpaper|portrait|artwork|illustration|gaming\s+setup|cat|dog|sunset|beach|perfume|dress|product|car|city|landscape|scene|character|avatar|banner|poster)\b/i;

const IMAGE_OF_PREFIX =
  /^(?:an?\s+)?(?:image|picture|photo|drawing|painting|illustration|wallpaper|logo\s+concept|3d\s+render|cartoon)\s+(?:of|showing|depicting|with)\s+/i;

export function detectImageGenerationIntent(rawInput: string): {
  isImageIntent: boolean;
  prompt: string;
  inferredStyle: ImageStylePreset;
  inferredRatio: ImageAspectRatio;
} {
  const trimmed = rawInput.trim();
  if (!trimmed || trimmed.length > 900) {
    return {
      isImageIntent: false,
      prompt: trimmed,
      inferredStyle: 'auto',
      inferredRatio: '1:1',
    };
  }

  const slashMatch = trimmed.match(EXPLICIT_COMMAND_PREFIX);
  if (slashMatch?.[1]) {
    const clean = slashMatch[1].trim();
    return {
      isImageIntent: true,
      prompt: clean,
      inferredStyle: inferStyleFromPrompt(clean),
      inferredRatio: inferAspectRatioFromPrompt(clean),
    };
  }

  if (QUESTION_OR_CODE_PREFIX.test(trimmed) || CODE_OR_TEXT_TARGET.test(trimmed)) {
    return {
      isImageIntent: false,
      prompt: trimmed,
      inferredStyle: 'auto',
      inferredRatio: '1:1',
    };
  }

  const matches =
    VISUAL_GENERATION_VERB_NOUN.test(trimmed) ||
    LEADING_IMAGE_PHRASE.test(trimmed) ||
    IMAGE_OF_PREFIX.test(trimmed);

  if (!matches) {
    return {
      isImageIntent: false,
      prompt: trimmed,
      inferredStyle: 'auto',
      inferredRatio: '1:1',
    };
  }

  const cleanedPrompt = cleanImagePrompt(trimmed);
  return {
    isImageIntent: true,
    prompt: cleanedPrompt || trimmed,
    inferredStyle: inferStyleFromPrompt(trimmed),
    inferredRatio: inferAspectRatioFromPrompt(trimmed),
  };
}

export function cleanImagePrompt(rawPrompt: string): string {
  return rawPrompt
    .replace(/^\/(?:imagine|image|img|draw)\s+/i, '')
    .replace(
      /^(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:generate|create|make|draw|paint|render|design|illustrate|sketch|imagine)\s+(?:for\s+me\s+|me\s+)?(?:an?\s+)?(?:image|picture|pic|photo|photograph|artwork|illustration)?\s*(?:of\s+)?/i,
      ''
    )
    .replace(/\s+(?:image|picture|pic|photo)\s*$/i, '')
    .trim();
}

export function inferStyleFromPrompt(prompt: string): ImageStylePreset {
  const lower = prompt.toLowerCase();
  if (/\blogo\b|\bemblem\b|\bbrand mark\b/.test(lower)) return 'logo';
  if (/\bwallpaper\b|\bdesktop background\b/.test(lower)) return 'wallpaper';
  if (/\banime\b|\bmanga\b/.test(lower)) return 'anime';
  if (/\bcartoon\b|\bchibi\b|\bcomic\b/.test(lower)) return 'cartoon';
  if (/\b3d\b|\boctane\b|\bblender\b|\bpixar\b/.test(lower)) return '3d-render';
  if (/\bperfume\b|\bproduct\b|\bbottle\b|\bpackaging\b|\bwatch\b|\bsneaker\b/.test(lower))
    return 'product';
  if (/\bfashion\b|\bdress\b|\bgown\b|\brunway\b|\boutfit\b|\bmodel\b/.test(lower))
    return 'fashion';
  if (/\bcinematic\b|\bmovie\b|\bfilm still\b/.test(lower)) return 'cinematic';
  if (/\bphotorealistic\b|\brealistic\b|\bphoto\b|\bportrait\b/.test(lower))
    return 'photorealistic';
  if (/\bdigital art\b|\bconcept art\b|\bfantasy\b/.test(lower)) return 'digital-art';
  return 'auto';
}

export function inferAspectRatioFromPrompt(prompt: string): ImageAspectRatio {
  const lower = prompt.toLowerCase();
  if (/\bwallpaper\b|\bwidescreen\b|\b16:9\b|\bbanner\b|\byoutube thumbnail\b/.test(lower)) {
    return '16:9';
  }
  if (/\b9:16\b|\bphone background\b|\bmobile wallpaper\b|\bportrait story\b|\btiktok\b/.test(lower)) {
    return '9:16';
  }
  if (/\b4:3\b/.test(lower)) {
    return '4:3';
  }
  return '1:1';
}

export function composeStyledImagePrompt(
  prompt: string,
  style: ImageStylePreset
): string {
  const base = prompt.trim();
  const preset = IMAGE_STYLE_OPTIONS.find((s) => s.id === style);
  if (!preset || !preset.promptSuffix) return base;
  return `${base}, ${preset.promptSuffix}`;
}
