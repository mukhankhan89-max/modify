import process from 'node:process';

export interface ImageGenerationRequest {
  prompt: string;
  width: number;
  height: number;
  seed?: number;
}

export interface GeneratedImageResult {
  imageBase64: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  provider: string;
  model: string;
  width: number;
  height: number;
  remoteUrl?: string;
  durationMs: number;
}

export class ImageGenerationError extends Error {
  status: number;
  code: string;
  fallbackClientUrl?: string;

  constructor(
    message: string,
    status = 502,
    code = 'IMAGE_GENERATION_FAILED',
    fallbackClientUrl?: string
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.fallbackClientUrl = fallbackClientUrl;
  }
}

let pollinationsCooldownUntil = 0;

function clampDimension(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const clamped = Math.max(512, Math.min(1024, Math.round(num / 64) * 64));
  return clamped;
}

export function normalizeImageRequest(body: unknown): {
  req?: ImageGenerationRequest;
  error?: string;
} {
  if (!body || typeof body !== 'object') {
    return {error: 'Invalid JSON request body.'};
  }
  const raw = body as Record<string, unknown>;
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) {
    return {error: 'An image prompt is required.'};
  }
  if (prompt.length > 1200) {
    return {error: 'Image prompt must be 1200 characters or fewer.'};
  }
  const width = clampDimension(raw.width, 1024);
  const height = clampDimension(raw.height, 1024);
  const seed =
    typeof raw.seed === 'number' && Number.isFinite(raw.seed)
      ? Math.abs(Math.floor(raw.seed))
      : Math.floor(Math.random() * 2_000_000_000);

  return {req: {prompt, width, height, seed}};
}

function buildPollinationsPublicUrl(req: ImageGenerationRequest): string {
  const encoded = encodeURIComponent(req.prompt);
  return `https://image.pollinations.ai/prompt/${encoded}?model=flux&width=${req.width}&height=${req.height}&nologo=true&seed=${req.seed}`;
}

async function generateWithCloudflare(
  req: ImageGenerationRequest,
  signal?: AbortSignal
): Promise<GeneratedImageResult | null> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !token) return null;

  const t0 = Date.now();
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: req.prompt,
        steps: 4,
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(22_000)])
        : AbortSignal.timeout(22_000),
    }
  );

  if (!res.ok) {
    throw new Error(`Cloudflare AI error (${res.status})`);
  }

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const json = (await res.json()) as {
      result?: {image?: string};
      errors?: Array<{message?: string}>;
    };
    const b64 = json.result?.image;
    if (!b64) {
      throw new Error(json.errors?.[0]?.message || 'Cloudflare returned no image.');
    }
    return {
      imageBase64: b64,
      mimeType: 'image/jpeg',
      provider: 'Cloudflare Workers AI',
      model: 'FLUX.1-schnell',
      width: req.width,
      height: req.height,
      durationMs: Date.now() - t0,
    };
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1000) {
    throw new Error('Cloudflare returned empty image bytes.');
  }

  return {
    imageBase64: bytes.toString('base64'),
    mimeType: ct.includes('png') ? 'image/png' : 'image/jpeg',
    provider: 'Cloudflare Workers AI',
    model: 'FLUX.1-schnell',
    width: req.width,
    height: req.height,
    durationMs: Date.now() - t0,
  };
}

async function generateWithPollinations(
  req: ImageGenerationRequest,
  signal?: AbortSignal
): Promise<GeneratedImageResult> {
  const apiKey = process.env.POLLINATIONS_API_KEY?.trim();
  if (!apiKey && Date.now() < pollinationsCooldownUntil) {
    throw new Error('Pollinations anonymous cooldown active');
  }

  const t0 = Date.now();
  const encoded = encodeURIComponent(req.prompt);
  const url = apiKey
    ? `https://gen.pollinations.ai/image/${encoded}?model=flux&width=${req.width}&height=${req.height}&nologo=true&seed=${req.seed}`
    : buildPollinationsPublicUrl(req);

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, {
    headers,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000),
  });

  if (res.status === 402 || res.status === 429) {
    if (!apiKey) {
      pollinationsCooldownUntil = Date.now() + 45_000;
    }
    throw new Error(`Pollinations rate limit (${res.status})`);
  }

  if (!res.ok) {
    throw new Error(`Pollinations returned ${res.status}`);
  }

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('image/')) {
    throw new Error(`Pollinations returned non-image response (${ct})`);
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1500) {
    throw new Error('Pollinations returned empty image data.');
  }

  const mimeType = ct.includes('png')
    ? 'image/png'
    : ct.includes('webp')
      ? 'image/webp'
      : 'image/jpeg';

  return {
    imageBase64: bytes.toString('base64'),
    mimeType,
    provider: 'Pollinations AI',
    model: 'FLUX',
    width: req.width,
    height: req.height,
    remoteUrl: apiKey ? undefined : url,
    durationMs: Date.now() - t0,
  };
}

function extractGradioResultUrl(sseText: string): {
  url?: string;
  error?: string;
} {
  if (sseText.includes('event: error')) {
    const dataLine = sseText
      .split('\n')
      .find((line) => line.startsWith('data:'));
    if (dataLine) {
      try {
        const parsed = JSON.parse(dataLine.slice(5).trim()) as {
          error?: string;
        } | null;
        return {
          error: parsed?.error || 'Hugging Face Space returned an error.',
        };
      } catch {
        return {error: 'Hugging Face Space returned an error.'};
      }
    }
    return {error: 'Hugging Face Space returned an error.'};
  }

  const lines = sseText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'event: complete') {
      const next = lines[i + 1]?.trim();
      if (next?.startsWith('data:')) {
        try {
          const parsed = JSON.parse(next.slice(5).trim()) as Array<
            {url?: string} | number | string
          >;
          const fileObj = parsed?.[0];
          if (
            fileObj &&
            typeof fileObj === 'object' &&
            typeof fileObj.url === 'string'
          ) {
            return {url: fileObj.url};
          }
        } catch {
          // Ignore malformed complete payload
        }
      }
    }
  }
  return {error: 'Hugging Face Space did not return an image URL.'};
}

async function generateWithHfRouter(
  req: ImageGenerationRequest,
  signal?: AbortSignal
): Promise<GeneratedImageResult | null> {
  const hfToken = process.env.HF_TOKEN?.trim();
  if (!hfToken) return null;

  const t0 = Date.now();
  const res = await fetch(
    'https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${hfToken}`,
        'Content-Type': 'application/json',
        Accept: 'image/jpeg',
      },
      body: JSON.stringify({
        inputs: req.prompt,
        parameters: {
          width: req.width,
          height: req.height,
          num_inference_steps: 4,
        },
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(22_000)])
        : AbortSignal.timeout(22_000),
    }
  );

  if (!res.ok) {
    throw new Error(`HF Router error (${res.status})`);
  }

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('image/')) {
    throw new Error(`HF Router returned non-image response (${ct})`);
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1500) {
    throw new Error('HF Router returned empty image.');
  }

  return {
    imageBase64: bytes.toString('base64'),
    mimeType: ct.includes('png')
      ? 'image/png'
      : ct.includes('webp')
        ? 'image/webp'
        : 'image/jpeg',
    provider: 'Hugging Face Inference',
    model: 'FLUX.1-schnell',
    width: req.width,
    height: req.height,
    durationMs: Date.now() - t0,
  };
}

async function generateWithGradioSpace(
  params: {
    spaceBaseUrl: string;
    providerLabel: string;
    modelLabel: string;
    payloadData: unknown[];
    req: ImageGenerationRequest;
  },
  signal?: AbortSignal
): Promise<GeneratedImageResult> {
  const t0 = Date.now();
  const hfToken = process.env.HF_TOKEN?.trim();
  const headers: Record<string, string> = {'Content-Type': 'application/json'};
  if (hfToken) {
    headers.Authorization = `Bearer ${hfToken}`;
  }

  const callUrl = `${params.spaceBaseUrl}/gradio_api/call/infer`;
  const postRes = await fetch(callUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({data: params.payloadData}),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(12_000)])
      : AbortSignal.timeout(12_000),
  });

  if (!postRes.ok) {
    throw new Error(`${params.modelLabel} POST failed (${postRes.status})`);
  }

  const postJson = (await postRes.json()) as {event_id?: string};
  if (!postJson.event_id) {
    throw new Error(`${params.modelLabel} did not return event_id`);
  }

  const sseRes = await fetch(`${callUrl}/${postJson.event_id}`, {
    headers: hfToken ? {Authorization: `Bearer ${hfToken}`} : undefined,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(24_000)])
      : AbortSignal.timeout(24_000),
  });

  if (!sseRes.ok) {
    throw new Error(`${params.modelLabel} stream failed (${sseRes.status})`);
  }

  const sseText = await sseRes.text();
  const extracted = extractGradioResultUrl(sseText);
  if (!extracted.url) {
    throw new Error(extracted.error || `${params.modelLabel} failed`);
  }

  const fileRes = await fetch(extracted.url, {
    headers: hfToken ? {Authorization: `Bearer ${hfToken}`} : undefined,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(12_000)])
      : AbortSignal.timeout(12_000),
  });

  if (!fileRes.ok) {
    throw new Error(`Failed to fetch generated image (${fileRes.status})`);
  }

  const ct = (fileRes.headers.get('content-type') || '').toLowerCase();
  const bytes = Buffer.from(await fileRes.arrayBuffer());
  if (bytes.length < 1500) {
    throw new Error(`${params.modelLabel} returned empty image file`);
  }

  const mimeType = ct.includes('png')
    ? 'image/png'
    : ct.includes('jpeg') || ct.includes('jpg')
      ? 'image/jpeg'
      : 'image/webp';

  return {
    imageBase64: bytes.toString('base64'),
    mimeType,
    provider: params.providerLabel,
    model: params.modelLabel,
    width: params.req.width,
    height: params.req.height,
    remoteUrl: extracted.url,
    durationMs: Date.now() - t0,
  };
}

async function generateWithAiHorde(
  req: ImageGenerationRequest,
  signal?: AbortSignal
): Promise<GeneratedImageResult> {
  const t0 = Date.now();
  const apiKey = process.env.AI_HORDE_API_KEY?.trim() || '0000000000';
  // Keep anonymous AI Horde size <= 576px so it fits anonymous Kudos limits & fast queue
  const hordeWidth = Math.min(576, Math.max(512, Math.round((req.width / Math.max(req.width, req.height)) * 576 / 64) * 64));
  const hordeHeight = Math.min(576, Math.max(512, Math.round((req.height / Math.max(req.width, req.height)) * 576 / 64) * 64));

  let candidateModels: string[] | undefined;
  try {
    const modelsRes = await fetch('https://aihorde.net/api/v2/status/models?type=image', {
      signal: AbortSignal.timeout(3_500),
    });
    if (modelsRes.ok) {
      const list = (await modelsRes.json()) as Array<{
        name: string;
        count: number;
        eta: number;
        queued: number;
      }>;
      const fastModels = list
        .filter((m) => m.count >= 3 && m.eta <= 20 && m.queued <= 10)
        .sort((a, b) => a.eta - b.eta)
        .slice(0, 4)
        .map((m) => m.name);
      if (fastModels.length > 0) {
        candidateModels = fastModels;
      }
    }
  } catch {
    // Let AI Horde route to any available fast worker
  }

  const submitRes = await fetch('https://aihorde.net/api/v2/generate/async', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: apiKey,
      'Client-Agent': 'LumenChat:1.0:lumen',
    },
    body: JSON.stringify({
      prompt: req.prompt,
      params: {
        width: hordeWidth,
        height: hordeHeight,
        steps: 14,
        n: 1,
      },
      ...(candidateModels ? {models: candidateModels} : {}),
      nsfw: false,
      censor_nsfw: true,
      r2: true,
    }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(8_000)])
      : AbortSignal.timeout(8_000),
  });

  if (!submitRes.ok) {
    throw new Error(`AI Horde submit failed (${submitRes.status})`);
  }

  const submitJson = (await submitRes.json()) as {id?: string};
  const jobId = submitJson.id;
  if (!jobId) {
    throw new Error('AI Horde did not return a job ID');
  }

  const cancelJob = () => {
    fetch(`https://aihorde.net/api/v2/generate/status/${jobId}`, {
      method: 'DELETE',
      headers: {apikey: apiKey, 'Client-Agent': 'LumenChat:1.0:lumen'},
    }).catch(() => {});
  };

  try {
    const deadline = Date.now() + 18_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        cancelJob();
        throw new Error('Aborted');
      }
      await new Promise((r) => setTimeout(r, 1500));
      const checkRes = await fetch(
        `https://aihorde.net/api/v2/generate/check/${jobId}`,
        {signal: AbortSignal.timeout(5_000)}
      );
      if (!checkRes.ok) continue;
      const check = (await checkRes.json()) as {
        done?: boolean;
        faulted?: boolean;
        wait_time?: number;
      };
      if (check.faulted) {
        throw new Error('AI Horde generation faulted');
      }
      if (check.done) {
        const statusRes = await fetch(
          `https://aihorde.net/api/v2/generate/status/${jobId}`,
          {signal: AbortSignal.timeout(6_000)}
        );
        const statusJson = (await statusRes.json()) as {
          generations?: Array<{img?: string; model?: string}>;
        };
        const gen = statusJson.generations?.[0];
        if (!gen?.img) {
          throw new Error('AI Horde returned no generation image');
        }

        if (gen.img.startsWith('http')) {
          const imgRes = await fetch(gen.img, {signal: AbortSignal.timeout(10_000)});
          const bytes = Buffer.from(await imgRes.arrayBuffer());
          const ct = (imgRes.headers.get('content-type') || '').toLowerCase();
          return {
            imageBase64: bytes.toString('base64'),
            mimeType: ct.includes('png')
              ? 'image/png'
              : ct.includes('jpeg')
                ? 'image/jpeg'
                : 'image/webp',
            provider: 'AI Horde',
            model: gen.model || candidateModels?.[0] || 'Stable Diffusion',
            width: hordeWidth,
            height: hordeHeight,
            remoteUrl: gen.img,
            durationMs: Date.now() - t0,
          };
        }

        return {
          imageBase64: gen.img,
          mimeType: 'image/webp',
          provider: 'AI Horde',
          model: gen.model || candidateModels?.[0] || 'Stable Diffusion',
          width: hordeWidth,
          height: hordeHeight,
          durationMs: Date.now() - t0,
        };
      }
      if (typeof check.wait_time === 'number' && check.wait_time > 45) {
        cancelJob();
        throw new Error(`AI Horde queue too long (${check.wait_time}s)`);
      }
    }

    cancelJob();
    throw new Error('AI Horde timed out waiting for volunteer worker');
  } catch (err) {
    cancelJob();
    throw err;
  }
}

export async function generateFreeImage(
  req: ImageGenerationRequest,
  signal?: AbortSignal
): Promise<GeneratedImageResult> {
  const attempts: Array<{
    name: string;
    run: () => Promise<GeneratedImageResult | null>;
  }> = [
    {
      name: 'Cloudflare Workers AI',
      run: () => generateWithCloudflare(req, signal),
    },
    {
      name: 'Hugging Face Router',
      run: () => generateWithHfRouter(req, signal),
    },
    {
      name: 'Pollinations AI',
      run: () => generateWithPollinations(req, signal),
    },
    {
      name: 'Hugging Face FLUX.1-schnell',
      run: () =>
        generateWithGradioSpace(
          {
            spaceBaseUrl: 'https://black-forest-labs-flux-1-schnell.hf.space',
            providerLabel: 'Hugging Face (Free)',
            modelLabel: 'FLUX.1-schnell',
            payloadData: [req.prompt, req.seed ?? 0, true, req.width, req.height, 4],
            req,
          },
          signal
        ),
    },
    {
      name: 'Hugging Face SD 3.5 Turbo',
      run: () =>
        generateWithGradioSpace(
          {
            spaceBaseUrl: 'https://stabilityai-stable-diffusion-3-5-large-turbo.hf.space',
            providerLabel: 'Hugging Face (Free)',
            modelLabel: 'SD 3.5 Large Turbo',
            payloadData: [
              req.prompt,
              '',
              req.seed ?? 0,
              true,
              req.width,
              req.height,
              0,
              4,
            ],
            req,
          },
          signal
        ),
    },
    {
      name: 'AI Horde',
      run: () => generateWithAiHorde(req, signal),
    },
  ];

  const errors: string[] = [];

  for (const provider of attempts) {
    if (signal?.aborted) {
      throw new ImageGenerationError('Image generation canceled.', 499, 'ABORTED');
    }
    try {
      const result = await provider.run();
      if (result) {
        return result;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${provider.name}: ${msg}`);
      console.warn(`[ImageGen fallback] ${provider.name} failed -> ${msg}`);
    }
  }

  const publicUrl = buildPollinationsPublicUrl(req);
  const hitRateLimit = errors.some(
    (e) =>
      e.includes('402') ||
      e.includes('429') ||
      e.toLowerCase().includes('quota') ||
      e.toLowerCase().includes('cooldown') ||
      e.toLowerCase().includes('limit')
  );

  throw new ImageGenerationError(
    hitRateLimit
      ? 'Free image providers are temporarily rate-limited on the server. Trying direct fallback or please wait ~30 seconds and regenerate.'
      : 'All free image generation providers are temporarily busy. Please try again in a moment.',
    hitRateLimit ? 429 : 503,
    hitRateLimit ? 'FREE_QUOTA_LIMIT' : 'IMAGE_PROVIDERS_UNAVAILABLE',
    publicUrl
  );
}
