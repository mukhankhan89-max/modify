import {
  AlertCircle,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  Send,
  Square,
  Volume2,
  X,
} from 'lucide-react';
import {useCallback, useEffect, useRef, useState} from 'react';
import {useSpeechSynthesis} from '../hooks/useSpeechSynthesis';
import type {SpeechLanguage, SpeechRate} from '../types/chat';
import {loadSpeechLanguage, saveSpeechLanguage} from '../utils/storage';

type VoicePhase =
  | 'initializing'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'muted'
  | 'error';

interface VoiceConversationModalProps {
  isOpen: boolean;
  streamingText: string;
  onSendVoiceTurn: (transcript: string) => Promise<string | null>;
  onStopGeneration: () => void;
  onClose: () => void;
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
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
}

interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

function getBestAudioMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm';
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return 'audio/webm';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.includes(',') ? result.split(',')[1] ?? '' : result);
    };
    reader.onerror = () => reject(new Error('Failed to read recorded audio.'));
    reader.readAsDataURL(blob);
  });
}

const SPEECH_RATES: SpeechRate[] = [0.75, 1, 1.25, 1.5];

export function VoiceConversationModal({
  isOpen,
  streamingText,
  onSendVoiceTurn,
  onStopGeneration,
  onClose,
}: VoiceConversationModalProps) {
  const [phase, setPhase] = useState<VoicePhase>('initializing');
  const [language, setLanguage] = useState<SpeechLanguage>(() => loadSpeechLanguage());
  const [liveTranscript, setLiveTranscript] = useState('');
  const [lastUserTranscript, setLastUserTranscript] = useState('');
  const [lastAssistantReply, setLastAssistantReply] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [audioBars, setAudioBars] = useState<number[]>(() => Array(12).fill(0.15));

  const {
    rate,
    setRate,
    speak,
    stop: stopSpeech,
  } = useSpeechSynthesis();

  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const phaseRef = useRef<VoicePhase>(phase);
  phaseRef.current = phase;
  const languageRef = useRef<SpeechLanguage>(language);
  languageRef.current = language;

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recorderChunksRef = useRef<Blob[]>([]);
  const silenceTimerRef = useRef<number | null>(null);
  const webSpeechFailedRef = useRef(false);
  const transcriptBufferRef = useRef('');
  const turnActiveRef = useRef(false);

  useEffect(() => {
    saveSpeechLanguage(language);
  }, [language]);

  const clearTimersAndCapture = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // Ignore abort errors
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
        // Ignore stop errors
      }
      mediaRecorderRef.current = null;
    }
  }, []);

  const teardownAllAudio = useCallback(() => {
    clearTimersAndCapture();
    stopSpeech();
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioCtxRef.current) {
      try {
        void audioCtxRef.current.close();
      } catch {
        // Ignore close errors
      }
      audioCtxRef.current = null;
      analyserRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
  }, [clearTimersAndCapture, stopSpeech]);

  const startVisualizerLoop = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
    }

    const updateBars = () => {
      if (!isOpenRef.current) return;
      const currentPhase = phaseRef.current;

      if (currentPhase === 'listening' && analyserRef.current) {
        const analyser = analyserRef.current;
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        const nextBars: number[] = [];
        const step = Math.max(1, Math.floor(data.length / 12));
        for (let i = 0; i < 12; i++) {
          const val = data[i * step] ?? 0;
          nextBars.push(Math.max(0.15, Math.min(1, val / 180)));
        }
        setAudioBars(nextBars);
      } else if (currentPhase === 'speaking') {
        const now = performance.now() / 160;
        const nextBars = Array.from({length: 12}, (_, i) =>
          0.25 + 0.55 * Math.abs(Math.sin(now + i * 0.6))
        );
        setAudioBars(nextBars);
      } else {
        setAudioBars(Array(12).fill(0.15));
      }

      rafRef.current = window.requestAnimationFrame(updateBars);
    };

    rafRef.current = window.requestAnimationFrame(updateBars);
  }, []);

  const submitVoiceTranscriptRef = useRef<(text: string) => Promise<void>>(
    async () => {}
  );
  const startListeningTurnRef = useRef<() => void>(() => {});

  const startListeningTurn = useCallback(() => {
    if (!isOpenRef.current || !streamRef.current) return;
    if (phaseRef.current === 'muted') return;

    clearTimersAndCapture();
    transcriptBufferRef.current = '';
    turnActiveRef.current = false;
    setLiveTranscript('');
    setErrorMsg(null);
    setPhase('listening');

    const SpeechCtor = getSpeechRecognitionCtor();
    if (SpeechCtor && !webSpeechFailedRef.current) {
      try {
        const recognition = new SpeechCtor();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = languageRef.current;

        const resetSilenceCommit = () => {
          if (silenceTimerRef.current !== null) {
            window.clearTimeout(silenceTimerRef.current);
          }
          silenceTimerRef.current = window.setTimeout(() => {
            const committed = transcriptBufferRef.current.trim();
            if (committed && phaseRef.current === 'listening') {
              clearTimersAndCapture();
              void submitVoiceTranscriptRef.current(committed);
            }
          }, 1350);
        };

        recognition.onresult = (event) => {
          let fullFinal = '';
          let fullInterim = '';
          for (let i = 0; i < event.results.length; i++) {
            const res = event.results[i];
            const txt = res?.[0]?.transcript ?? '';
            if (res.isFinal) {
              fullFinal += `${txt} `;
            } else {
              fullInterim += txt;
            }
          }
          const combined = `${fullFinal}${fullInterim}`.trim();
          transcriptBufferRef.current = combined;
          setLiveTranscript(combined);
          if (combined) {
            resetSilenceCommit();
          }
        };

        recognition.onerror = (event) => {
          if (event.error === 'aborted' || event.error === 'no-speech') return;
          if (
            event.error === 'not-allowed' ||
            event.error === 'service-not-allowed' ||
            event.error === 'audio-capture'
          ) {
            setErrorMsg('Microphone permission is required for voice conversation.');
            setPhase('error');
            return;
          }
          if (event.error === 'network') {
            webSpeechFailedRef.current = true;
            startListeningTurnRef.current();
          }
        };

        recognition.onend = () => {
          if (!isOpenRef.current) return;
          if (phaseRef.current === 'listening') {
            const pending = transcriptBufferRef.current.trim();
            if (pending) {
              void submitVoiceTranscriptRef.current(pending);
            } else {
              // Keep listening seamlessly if speech recognition timed out silently
              try {
                recognition.start();
              } catch {
                // Ignore restart errors if torn down
              }
            }
          }
        };

        recognitionRef.current = recognition;
        recognition.start();
        return;
      } catch {
        webSpeechFailedRef.current = true;
      }
    }

    // Fallback: MediaRecorder + Gemini Transcribe
    if (typeof MediaRecorder !== 'undefined' && streamRef.current) {
      const mimeType = getBestAudioMimeType();
      const recorder = new MediaRecorder(streamRef.current, {mimeType});
      recorderChunksRef.current = [];
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          recorderChunksRef.current.push(ev.data);
        }
      };

      recorder.start(200);
    }
  }, [clearTimersAndCapture]);

  startListeningTurnRef.current = startListeningTurn;

  const commitManualRecorderTurn = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      const buffered = transcriptBufferRef.current.trim();
      if (buffered) {
        clearTimersAndCapture();
        await submitVoiceTranscriptRef.current(buffered);
      }
      return;
    }

    const mimeType = recorder.mimeType || 'audio/webm';
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    mediaRecorderRef.current = null;

    const chunks = recorderChunksRef.current;
    recorderChunksRef.current = [];
    if (chunks.length === 0) return;

    const blob = new Blob(chunks, {type: mimeType});
    if (blob.size < 400) return;

    setPhase('transcribing');
    try {
      const base64Audio = await blobToBase64(blob);
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          audio: base64Audio,
          mimeType,
          language: languageRef.current,
        }),
      });
      const data = (await res.json()) as {text?: string; error?: string};
      if (!res.ok) {
        throw new Error(data.error || 'Transcription failed.');
      }
      const text = (data.text ?? '').trim();
      if (text) {
        await submitVoiceTranscriptRef.current(text);
      } else if (isOpenRef.current) {
        startListeningTurnRef.current();
      }
    } catch (err) {
      if (isOpenRef.current) {
        setErrorMsg(err instanceof Error ? err.message : 'Unable to transcribe audio.');
        setPhase('error');
      }
    }
  }, [clearTimersAndCapture]);

  const submitVoiceTranscript = useCallback(
    async (transcript: string) => {
      const clean = transcript.trim();
      if (!clean || turnActiveRef.current || !isOpenRef.current) return;
      turnActiveRef.current = true;
      setLastUserTranscript(clean);
      setLiveTranscript('');
      setLastAssistantReply('');
      setPhase('thinking');

      try {
        const reply = await onSendVoiceTurn(clean);
        if (!isOpenRef.current) return;
        if (!reply || !reply.trim()) {
          turnActiveRef.current = false;
          if (phaseRef.current !== 'muted') {
            startListeningTurnRef.current();
          }
          return;
        }

        setLastAssistantReply(reply);
        setPhase('speaking');
        await speak(`voice-turn-${Date.now()}`, reply, {
          onComplete: () => {
            turnActiveRef.current = false;
            if (isOpenRef.current && phaseRef.current !== 'muted') {
              startListeningTurnRef.current();
            }
          },
        });
      } catch (err) {
        turnActiveRef.current = false;
        if (isOpenRef.current) {
          setErrorMsg(
            err instanceof Error ? err.message : 'Voice response failed. Please retry.'
          );
          setPhase('error');
        }
      }
    },
    [onSendVoiceTurn, speak]
  );

  submitVoiceTranscriptRef.current = submitVoiceTranscript;

  const initVoiceSession = useCallback(async () => {
    setErrorMsg(null);
    setPhase('initializing');

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      setErrorMsg(
        'Microphone capture is not supported in this browser.'
      );
      setPhase('error');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: true});
      if (!isOpenRef.current) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      streamRef.current = stream;

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as {webkitAudioContext: typeof AudioContext})
          .webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        source.connect(analyser);
        audioCtxRef.current = ctx;
        analyserRef.current = analyser;
      }

      startVisualizerLoop();
      startListeningTurn();
    } catch (err) {
      const message =
        err && typeof err === 'object' && 'name' in err && (err as {name: string}).name === 'NotAllowedError'
          ? 'Microphone permission was denied. Please allow microphone access to use Voice Mode.'
          : 'Could not start microphone for Voice Mode.';
      setErrorMsg(message);
      setPhase('error');
    }
  }, [startListeningTurn, startVisualizerLoop]);

  useEffect(() => {
    if (isOpen) {
      setLastUserTranscript('');
      setLastAssistantReply('');
      setLiveTranscript('');
      turnActiveRef.current = false;
      void initVoiceSession();
    } else {
      teardownAllAudio();
    }

    return () => {
      teardownAllAudio();
    };
  }, [initVoiceSession, isOpen, teardownAllAudio]);

  if (!isOpen) return null;

  const handleToggleMute = () => {
    if (phase === 'muted') {
      setPhase('listening');
      startListeningTurn();
    } else {
      clearTimersAndCapture();
      stopSpeech();
      turnActiveRef.current = false;
      setPhase('muted');
    }
  };

  const handleInterruptOrSend = () => {
    if (phase === 'speaking') {
      stopSpeech();
      turnActiveRef.current = false;
      startListeningTurn();
      return;
    }
    if (phase === 'thinking') {
      onStopGeneration();
      turnActiveRef.current = false;
      startListeningTurn();
      return;
    }
    if (phase === 'listening') {
      void commitManualRecorderTurn();
      return;
    }
    if (phase === 'error') {
      void initVoiceSession();
    }
  };

  const handleExit = () => {
    if (phase === 'thinking') {
      onStopGeneration();
    }
    teardownAllAudio();
    onClose();
  };

  const displayedReply =
    phase === 'thinking' && streamingText ? streamingText : lastAssistantReply;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Lumen Voice Conversation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
    >
      <div className="relative flex w-full max-w-lg flex-col rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0F172A] shadow-2xl overflow-hidden">
        {/* Top bar */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                phase === 'listening'
                  ? 'bg-emerald-500 animate-pulse'
                  : phase === 'speaking'
                    ? 'bg-teal-500 animate-pulse'
                    : phase === 'thinking' || phase === 'transcribing'
                      ? 'bg-amber-500 animate-pulse'
                      : phase === 'error'
                        ? 'bg-red-500'
                        : 'bg-slate-400'
              }`}
            />
            <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Lumen Voice
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const next = language === 'en-US' ? 'ur-PK' : 'en-US';
                setLanguage(next);
                languageRef.current = next;
                if (phase === 'listening') {
                  startListeningTurn();
                }
              }}
              className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              {language === 'ur-PK' ? 'Urdu' : 'English / Roman'}
            </button>

            <select
              aria-label="Voice speed"
              value={rate}
              onChange={(e) => setRate(Number(e.target.value) as SpeechRate)}
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 focus:outline-none"
            >
              {SPEECH_RATES.map((r) => (
                <option key={r} value={r}>
                  {r}x
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={handleExit}
              aria-label="Close voice conversation"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Visualizer & Transcript Area */}
        <div className="flex flex-col items-center justify-center px-6 py-8 text-center space-y-6 min-h-[300px]">
          {/* Animated Waveform Bars */}
          <div
            aria-hidden="true"
            className="flex h-20 items-center justify-center gap-1.5"
          >
            {audioBars.map((level, idx) => (
              <span
                key={idx}
                style={{height: `${Math.round(level * 68)}px`}}
                className={`w-2 rounded-full transition-[height] duration-75 ${
                  phase === 'speaking'
                    ? 'bg-teal-600 dark:bg-teal-400'
                    : phase === 'listening'
                      ? 'bg-slate-900 dark:bg-teal-400'
                      : 'bg-slate-300 dark:bg-slate-700'
                }`}
              />
            ))}
          </div>

          <div className="space-y-1">
            <p className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {phase === 'initializing' && 'Connecting microphone...'}
              {phase === 'listening' && 'Listening — speak naturally'}
              {phase === 'transcribing' && 'Transcribing your voice...'}
              {phase === 'thinking' && 'Lumen is thinking...'}
              {phase === 'speaking' && 'Lumen is speaking'}
              {phase === 'muted' && 'Microphone muted'}
              {phase === 'error' && 'Voice session paused'}
            </p>
            {phase === 'listening' && webSpeechFailedRef.current && (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Tap Send when you finish speaking
              </p>
            )}
          </div>

          {errorMsg && (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-950/40 px-3.5 py-2.5 text-left text-xs text-red-800 dark:text-red-200 max-w-md">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Live Q&A Preview */}
          <div className="w-full space-y-3 text-left max-h-44 overflow-y-auto px-1">
            {(liveTranscript || lastUserTranscript) && (
              <div className="rounded-xl bg-slate-100 dark:bg-slate-800/80 px-3.5 py-2.5 text-sm text-slate-800 dark:text-slate-100">
                <span className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-0.5">
                  You
                </span>
                {liveTranscript || lastUserTranscript}
              </div>
            )}
            {displayedReply && (
              <div className="rounded-xl border border-teal-500/20 bg-teal-50/70 dark:bg-teal-950/30 px-3.5 py-2.5 text-sm text-slate-800 dark:text-slate-100">
                <span className="block text-[11px] font-semibold uppercase tracking-wider text-teal-600 dark:text-teal-400 mb-0.5">
                  Lumen
                </span>
                {displayedReply}
              </div>
            )}
          </div>
        </div>

        {/* Bottom Controls */}
        <div className="flex items-center justify-center gap-4 px-6 py-5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-[#111827]">
          <button
            type="button"
            onClick={handleToggleMute}
            aria-label={phase === 'muted' ? 'Unmute microphone' : 'Mute microphone'}
            title={phase === 'muted' ? 'Unmute' : 'Mute'}
            className={`inline-flex h-12 w-12 items-center justify-center rounded-full border transition-colors ${
              phase === 'muted'
                ? 'border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'
            }`}
          >
            {phase === 'muted' ? (
              <MicOff className="h-5 w-5" />
            ) : (
              <Mic className="h-5 w-5" />
            )}
          </button>

          <button
            type="button"
            onClick={handleInterruptOrSend}
            disabled={phase === 'initializing' || phase === 'transcribing' || phase === 'muted'}
            aria-label={
              phase === 'speaking'
                ? 'Interrupt AI speech'
                : phase === 'thinking'
                  ? 'Stop generating'
                  : phase === 'error'
                    ? 'Retry voice mode'
                    : 'Send spoken turn'
            }
            className={`inline-flex h-14 items-center gap-2 px-6 rounded-full font-semibold text-sm transition-colors shadow-sm disabled:opacity-40 ${
              phase === 'speaking' || phase === 'thinking'
                ? 'bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900'
                : 'bg-teal-600 text-white hover:bg-teal-500'
            }`}
          >
            {phase === 'initializing' || phase === 'transcribing' ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Working</span>
              </>
            ) : phase === 'speaking' ? (
              <>
                <Volume2 className="h-4 w-4" />
                <span>Interrupt</span>
              </>
            ) : phase === 'thinking' ? (
              <>
                <Square className="h-4 w-4 fill-current" />
                <span>Stop</span>
              </>
            ) : phase === 'error' ? (
              <span>Retry Mic</span>
            ) : (
              <>
                <Send className="h-4 w-4" />
                <span>Send Turn</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleExit}
            aria-label="End voice conversation"
            title="Exit voice mode"
            className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-red-600 text-white hover:bg-red-700 transition-colors"
          >
            <PhoneOff className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
