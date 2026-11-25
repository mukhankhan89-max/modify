import {useCallback, useEffect, useRef, useState} from 'react';
import type {SpeechRate} from '../types/chat';
import {loadSpeechRate, saveSpeechRate} from '../utils/storage';

export type SpeechPlaybackState = 'idle' | 'loading' | 'playing' | 'paused';

export function sanitizeMarkdownForSpeech(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, ' Code snippet omitted. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsUrduScript(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

function splitSpeechChunks(text: string, maxLen = 220): string[] {
  const sentences = text.match(/[^.!?؟۔\n]+[.!?؟۔\n]*/g) ?? [text];
  const chunks: string[] = [];
  let current = '';

  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim();
    if (!sentence) continue;
    if ((current ? `${current} ${sentence}` : sentence).length <= maxLen) {
      current = current ? `${current} ${sentence}` : sentence;
    } else {
      if (current) chunks.push(current);
      if (sentence.length <= maxLen) {
        current = sentence;
      } else {
        const words = sentence.split(/\s+/);
        let wordBuf = '';
        for (const w of words) {
          if ((wordBuf ? `${wordBuf} ${w}` : w).length <= maxLen) {
            wordBuf = wordBuf ? `${wordBuf} ${w}` : w;
          } else {
            if (wordBuf) chunks.push(wordBuf);
            wordBuf = w;
          }
        }
        current = wordBuf;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function pickBestSystemVoice(
  voices: SpeechSynthesisVoice[],
  isUrdu: boolean
): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;
  if (isUrdu) {
    return (
      voices.find((v) => v.lang.toLowerCase().startsWith('ur')) ??
      null
    );
  }
  const englishVoices = voices.filter((v) =>
    v.lang.toLowerCase().startsWith('en')
  );
  if (englishVoices.length === 0) return voices[0] ?? null;

  const preferred = englishVoices.find((v) =>
    /natural|neural|google|samantha|aria|jenny|daniel|serena/i.test(v.name)
  );
  return preferred ?? englishVoices.find((v) => v.default) ?? englishVoices[0];
}

export function useSpeechSynthesis() {
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [playbackState, setPlaybackState] = useState<SpeechPlaybackState>('idle');
  const [rate, setRateState] = useState<SpeechRate>(() => loadSpeechRate());
  const [error, setError] = useState<string | null>(null);

  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const sessionTokenRef = useRef(0);
  const activeTextRef = useRef('');
  const rateRef = useRef<SpeechRate>(rate);
  rateRef.current = rate;
  const onCompleteRef = useRef<(() => void) | null>(null);
  const useCloudAudioRef = useRef(false);
  const queueIndexRef = useRef(0);
  const chunksRef = useRef<string[]>([]);

  useEffect(() => {
    saveSpeechRate(rate);
  }, [rate]);

  const stop = useCallback(() => {
    sessionTokenRef.current += 1;
    onCompleteRef.current = null;
    useCloudAudioRef.current = false;
    chunksRef.current = [];
    queueIndexRef.current = 0;

    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore browser cancel errors
      }
    }

    if (audioElRef.current) {
      try {
        audioElRef.current.pause();
        audioElRef.current.src = '';
      } catch {
        // Ignore audio element cleanup errors
      }
      audioElRef.current = null;
    }

    setSpeakingMessageId(null);
    setPlaybackState('idle');
  }, []);

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  const playWithCloudTts = useCallback(
    async (
      messageId: string,
      cleanText: string,
      token: number,
      onComplete?: () => void
    ) => {
      useCloudAudioRef.current = true;
      setSpeakingMessageId(messageId);
      setPlaybackState('loading');
      setError(null);

      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({text: cleanText, voiceName: 'Kore'}),
        });
        const data = (await res.json()) as {
          audio?: string;
          mimeType?: string;
          error?: string;
        };

        if (sessionTokenRef.current !== token) return;

        if (!res.ok || !data.audio) {
          throw new Error(data.error || 'Voice playback failed.');
        }

        const audio = new Audio(`data:${data.mimeType || 'audio/wav'};base64,${data.audio}`);
        audio.playbackRate = rateRef.current;
        audioElRef.current = audio;

        audio.onended = () => {
          if (sessionTokenRef.current !== token) return;
          audioElRef.current = null;
          setSpeakingMessageId(null);
          setPlaybackState('idle');
          onComplete?.();
        };

        audio.onerror = () => {
          if (sessionTokenRef.current !== token) return;
          audioElRef.current = null;
          setSpeakingMessageId(null);
          setPlaybackState('idle');
          setError('Unable to play generated speech audio.');
        };

        await audio.play();
        if (sessionTokenRef.current === token) {
          setPlaybackState('playing');
        }
      } catch (err) {
        if (sessionTokenRef.current !== token) return;
        setSpeakingMessageId(null);
        setPlaybackState('idle');
        setError(
          err instanceof Error ? err.message : 'Speech synthesis failed.'
        );
      }
    },
    []
  );

  const speakNextChunk = useCallback(
    (
      messageId: string,
      isUrdu: boolean,
      voice: SpeechSynthesisVoice | null,
      token: number,
      onComplete?: () => void
    ) => {
      if (sessionTokenRef.current !== token) return;
      const chunks = chunksRef.current;
      const idx = queueIndexRef.current;

      if (idx >= chunks.length) {
        setSpeakingMessageId(null);
        setPlaybackState('idle');
        onComplete?.();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(chunks[idx]);
      utterance.lang = isUrdu ? 'ur-PK' : voice?.lang || 'en-US';
      if (voice) utterance.voice = voice;
      utterance.rate = rateRef.current;
      utterance.pitch = 1;

      utterance.onend = () => {
        if (sessionTokenRef.current !== token) return;
        queueIndexRef.current += 1;
        speakNextChunk(messageId, isUrdu, voice, token, onComplete);
      };

      utterance.onerror = (e) => {
        if (sessionTokenRef.current !== token) return;
        if (e.error === 'interrupted' || e.error === 'canceled') return;
        // Fallback to cloud TTS if browser voice errors mid-playback
        void playWithCloudTts(
          messageId,
          chunks.slice(idx).join(' '),
          token,
          onComplete
        );
      };

      window.speechSynthesis.speak(utterance);
    },
    [playWithCloudTts]
  );

  const speak = useCallback(
    async (
      messageId: string,
      rawText: string,
      options?: {preferCloud?: boolean; onComplete?: () => void}
    ) => {
      const cleanText = sanitizeMarkdownForSpeech(rawText);
      if (!cleanText) return;

      stop();
      const token = sessionTokenRef.current;
      activeTextRef.current = cleanText;
      onCompleteRef.current = options?.onComplete ?? null;
      setError(null);

      const isUrdu = containsUrduScript(cleanText);
      const hasBrowserTts =
        typeof window !== 'undefined' && 'speechSynthesis' in window;

      if (!hasBrowserTts || options?.preferCloud) {
        await playWithCloudTts(messageId, cleanText, token, options?.onComplete);
        return;
      }

      let voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) {
        // Wait briefly for async browser voices list on first trigger
        await new Promise<void>((resolve) => {
          const timeout = window.setTimeout(resolve, 180);
          const onVoices = () => {
            window.clearTimeout(timeout);
            window.speechSynthesis.removeEventListener('voiceschanged', onVoices);
            resolve();
          };
          window.speechSynthesis.addEventListener('voiceschanged', onVoices);
        });
        if (sessionTokenRef.current !== token) return;
        voices = window.speechSynthesis.getVoices();
      }

      const bestVoice = pickBestSystemVoice(voices, isUrdu);

      // If Urdu text has no system Urdu voice, use Gemini cloud TTS for clear Urdu pronunciation
      if (isUrdu && !bestVoice) {
        await playWithCloudTts(messageId, cleanText, token, options?.onComplete);
        return;
      }

      useCloudAudioRef.current = false;
      chunksRef.current = splitSpeechChunks(cleanText);
      queueIndexRef.current = 0;
      setSpeakingMessageId(messageId);
      setPlaybackState('playing');
      speakNextChunk(messageId, isUrdu, bestVoice, token, options?.onComplete);
    },
    [playWithCloudTts, speakNextChunk, stop]
  );

  const pause = useCallback(() => {
    if (playbackState !== 'playing') return;
    if (useCloudAudioRef.current && audioElRef.current) {
      audioElRef.current.pause();
      setPlaybackState('paused');
      return;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.pause();
      setPlaybackState('paused');
    }
  }, [playbackState]);

  const resume = useCallback(() => {
    if (playbackState !== 'paused') return;
    if (useCloudAudioRef.current && audioElRef.current) {
      void audioElRef.current.play();
      setPlaybackState('playing');
      return;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.resume();
      setPlaybackState('playing');
    }
  }, [playbackState]);

  const setRate = useCallback(
    (nextRate: SpeechRate) => {
      setRateState(nextRate);
      rateRef.current = nextRate;

      if (useCloudAudioRef.current && audioElRef.current) {
        audioElRef.current.playbackRate = nextRate;
        return;
      }

      // If browser speechSynthesis is actively playing, restart current chunk at new rate
      if (
        speakingMessageId &&
        playbackState === 'playing' &&
        typeof window !== 'undefined' &&
        'speechSynthesis' in window
      ) {
        const msgId = speakingMessageId;
        const remaining = chunksRef.current.slice(queueIndexRef.current).join(' ');
        const onDone = onCompleteRef.current ?? undefined;
        if (remaining.trim()) {
          void speak(msgId, remaining, {onComplete: onDone});
        }
      }
    },
    [playbackState, speak, speakingMessageId]
  );

  const togglePlayPause = useCallback(
    (messageId: string, rawText: string) => {
      if (speakingMessageId === messageId) {
        if (playbackState === 'playing') {
          pause();
          return;
        }
        if (playbackState === 'paused') {
          resume();
          return;
        }
        if (playbackState === 'loading') {
          stop();
          return;
        }
      }
      void speak(messageId, rawText);
    },
    [pause, playbackState, resume, speak, speakingMessageId, stop]
  );

  const dismissError = useCallback(() => {
    setError(null);
  }, []);

  return {
    speakingMessageId,
    playbackState,
    rate,
    error,
    speak,
    pause,
    resume,
    stop,
    setRate,
    togglePlayPause,
    dismissError,
  };
}
