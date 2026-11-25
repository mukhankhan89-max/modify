import {useCallback, useEffect, useRef, useState} from 'react';
import type {SpeechLanguage} from '../types/chat';
import {loadSpeechLanguage, saveSpeechLanguage} from '../utils/storage';

interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionErrorEventLike {
  error: string;
  message?: string;
}

interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

function getSpeechRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

function getSupportedRecorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return 'audio/webm';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const base64 = result.includes(',') ? result.split(',')[1] ?? '' : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Failed to read recorded audio.'));
    reader.readAsDataURL(blob);
  });
}

function mapMicErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err) {
    const name = String((err as {name: string}).name);
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return 'Microphone permission denied. Please allow microphone access in your browser settings and try again.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No microphone was found on this device.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'Your microphone is currently in use by another app or tab.';
    }
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return 'Could not access the microphone. Please check your browser permissions.';
}

interface UseSpeechRecognitionOptions {
  onFinalTranscript: (text: string) => void;
}

export function useSpeechRecognition({
  onFinalTranscript,
}: UseSpeechRecognitionOptions) {
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState<SpeechLanguage>(() => loadSpeechLanguage());
  const [recordingMode, setRecordingMode] = useState<'web-speech' | 'cloud-recorder'>(
    () => (getSpeechRecognitionCtor() ? 'web-speech' : 'cloud-recorder')
  );

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const webSpeechDisabledRef = useRef(false);
  const manualStopRef = useRef(false);
  const onFinalTranscriptRef = useRef(onFinalTranscript);
  onFinalTranscriptRef.current = onFinalTranscript;

  useEffect(() => {
    saveSpeechLanguage(language);
  }, [language]);

  const cleanupMediaStream = useCallback(() => {
    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        track.stop();
      }
      mediaStreamRef.current = null;
    }
  }, []);

  const stopListening = useCallback(() => {
    manualStopRef.current = true;
    setInterimTranscript('');

    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Ignore already-stopped recognition errors
      }
      recognitionRef.current = null;
    }

    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== 'inactive'
    ) {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        cleanupMediaStream();
      }
    } else {
      cleanupMediaStream();
    }

    setIsListening(false);
  }, [cleanupMediaStream]);

  useEffect(() => {
    return () => {
      manualStopRef.current = true;
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // Ignore unmount abort errors
        }
        recognitionRef.current = null;
      }
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== 'inactive'
      ) {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // Ignore unmount stop errors
        }
      }
      cleanupMediaStream();
    };
  }, [cleanupMediaStream]);

  const startCloudRecorder = useCallback(async () => {
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === 'undefined'
    ) {
      setError(
        'Voice recording is not supported in this browser. Please try Chrome, Edge, or Safari.'
      );
      return;
    }

    setError(null);
    setRecordingMode('cloud-recorder');
    manualStopRef.current = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: true});
      mediaStreamRef.current = stream;
      const mimeType = getSupportedRecorderMimeType();
      const recorder = new MediaRecorder(stream, {mimeType});
      audioChunksRef.current = [];
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        cleanupMediaStream();
        mediaRecorderRef.current = null;
        setIsListening(false);

        const chunks = audioChunksRef.current;
        audioChunksRef.current = [];
        if (chunks.length === 0) return;

        const blob = new Blob(chunks, {type: mimeType});
        if (blob.size < 400) return;

        setIsTranscribing(true);
        try {
          const base64Audio = await blobToBase64(blob);
          const response = await fetch('/api/transcribe', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
              audio: base64Audio,
              mimeType,
              language,
            }),
          });
          const data = (await response.json()) as {text?: string; error?: string};
          if (!response.ok) {
            throw new Error(data.error || 'Unable to transcribe audio.');
          }
          const transcribed = data.text?.trim() ?? '';
          if (transcribed) {
            onFinalTranscriptRef.current(transcribed);
          } else {
            setError('No speech was detected. Please try speaking clearly.');
          }
        } catch (err) {
          setError(
            err instanceof Error ? err.message : 'Failed to transcribe voice recording.'
          );
        } finally {
          setIsTranscribing(false);
        }
      };

      recorder.onerror = () => {
        cleanupMediaStream();
        mediaRecorderRef.current = null;
        setIsListening(false);
        setError('Microphone recording encountered an error. Please try again.');
      };

      recorder.start(250);
      setIsListening(true);
    } catch (err) {
      cleanupMediaStream();
      setIsListening(false);
      setError(mapMicErrorMessage(err));
    }
  }, [cleanupMediaStream, language]);

  const startListening = useCallback(async () => {
    if (isListening || isTranscribing) {
      stopListening();
      return;
    }

    setError(null);
    setInterimTranscript('');
    manualStopRef.current = false;

    const SpeechRecognitionCtor = getSpeechRecognitionCtor();
    if (!SpeechRecognitionCtor || webSpeechDisabledRef.current) {
      await startCloudRecorder();
      return;
    }

    setRecordingMode('web-speech');

    try {
      const recognition = new SpeechRecognitionCtor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.lang = language;

      recognition.onstart = () => {
        setIsListening(true);
        setError(null);
      };

      recognition.onresult = (event) => {
        let finalChunk = '';
        let interimChunk = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result?.[0]?.transcript ?? '';
          if (!text) continue;
          if (result.isFinal) {
            finalChunk += `${text} `;
          } else {
            interimChunk += text;
          }
        }

        if (finalChunk.trim()) {
          onFinalTranscriptRef.current(finalChunk.trim());
        }
        setInterimTranscript(interimChunk.trim());
      };

      recognition.onerror = (event) => {
        const errCode = event.error;
        if (errCode === 'aborted') {
          return;
        }
        if (errCode === 'not-allowed' || errCode === 'service-not-allowed') {
          recognitionRef.current = null;
          setIsListening(false);
          setInterimTranscript('');
          setError(
            'Microphone permission denied. Please allow microphone access in your browser settings.'
          );
          return;
        }
        if (errCode === 'audio-capture') {
          recognitionRef.current = null;
          setIsListening(false);
          setInterimTranscript('');
          setError('No working microphone was detected on this device.');
          return;
        }
        if (errCode === 'network') {
          // Browser speech service blocked/unavailable: fall back cleanly to MediaRecorder + Gemini Transcribe
          webSpeechDisabledRef.current = true;
          recognitionRef.current = null;
          setIsListening(false);
          setInterimTranscript('');
          void startCloudRecorder();
          return;
        }
        if (errCode === 'no-speech') {
          setError('No speech detected. Speak closer to the microphone and try again.');
          return;
        }
        setError(`Voice input error (${errCode}). Please try again.`);
      };

      recognition.onend = () => {
        recognitionRef.current = null;
        setIsListening(false);
        setInterimTranscript('');
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch {
      webSpeechDisabledRef.current = true;
      recognitionRef.current = null;
      await startCloudRecorder();
    }
  }, [isListening, isTranscribing, language, startCloudRecorder, stopListening]);

  const dismissError = useCallback(() => {
    setError(null);
  }, []);

  return {
    isListening,
    isTranscribing,
    interimTranscript,
    error,
    language,
    setLanguage,
    recordingMode,
    startListening,
    stopListening,
    dismissError,
  };
}
