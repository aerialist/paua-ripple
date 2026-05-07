'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    umami?: {
      track: (eventName: string, data?: Record<string, string | number | boolean>) => void;
    };
  }
}

type Status = 'idle' | 'recording' | 'transcribing' | 'editing' | 'done' | 'error';
type LanguageOption = 'auto' | 'en' | 'ja';
type RecordingMode = 'ptt' | 'toggle';

type AppSettings = {
  aquaApiKey: string;
  openaiApiKey: string;
  aquaBaseUrl: string;
  openaiBaseUrl: string;
  aquaModel: string;
  openaiModel: string;
  language: LanguageOption;
};

const STATUS_LABEL: Record<Status, string> = {
  idle: 'Ready',
  recording: 'Recording…',
  transcribing: 'Transcribing…',
  editing: 'Applying AI edit…',
  done: 'Done',
  error: 'Error',
};

const STATUS_CLASS: Record<Status, string> = {
  idle: 'bg-gray-800 text-gray-400',
  recording: 'bg-red-500/20 text-red-400',
  transcribing: 'bg-yellow-500/20 text-yellow-400',
  editing: 'bg-purple-500/20 text-purple-400',
  done: 'bg-green-500/20 text-green-400',
  error: 'bg-red-500/20 text-red-400',
};

const DEFAULT_SETTINGS: AppSettings = {
  aquaApiKey: '',
  openaiApiKey: '',
  aquaBaseUrl: 'https://api.aquavoice.com/api/v1',
  openaiBaseUrl: 'https://api.openai.com/v1',
  aquaModel: 'avalon-v1.5',
  openaiModel: 'gpt-4.1-nano',
  language: 'auto',
};

const SETTINGS_STORAGE_KEY = 'paua-ripple-settings';
const LANGUAGE_OPTIONS: Array<{ value: LanguageOption; label: string }> = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: 'Japanese' },
];
const WAVEFORM_POINTS = 200;
const WAVEFORM_MIN_DB = -60;

interface EditRange {
  start: number;
  end: number;
  selectedText: string;
}

interface CaretRange {
  start: number;
  end: number;
}

type TrackProps = Record<string, string | number | boolean>;

function track(eventName: string, data?: TrackProps) {
  try {
    window.umami?.track(eventName, data);
  } catch {
    // noop
  }
}

function classifyError(err: unknown) {
  const msg = err instanceof Error ? err.message.toLowerCase() : '';

  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid api key')) {
    return 'auth_error';
  }
  if (msg.includes('429') || msg.includes('rate')) {
    return 'rate_limit';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'network_error';
  }

  return 'unknown';
}

function maskSecret(secret: string) {
  return secret ? '••••••' : 'not set';
}

export default function Home() {
  const [status, setStatus] = useState<Status>('idle');
  const [transcript, setTranscript] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [copied, setCopied] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [editModeActive, setEditModeActive] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [inputLevel, setInputLevel] = useState(0);
  const [inputDb, setInputDb] = useState(-100);
  const [waveformHistory, setWaveformHistory] = useState<number[]>(() => Array(WAVEFORM_POINTS).fill(WAVEFORM_MIN_DB));
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [micHasSignal, setMicHasSignal] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const isRecordingRef = useRef(false);
  const recordingModeRef = useRef<RecordingMode | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editRangeRef = useRef<EditRange | null>(null);
  const caretPosRef = useRef<number | null>(null);
  const textareaHadFocusRef = useRef(false);
  const pendingCaretRangeRef = useRef<CaretRange | null>(null);
  const prefocusTranscriptRef = useRef('');
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const meterAnimationRef = useRef<number | null>(null);
  const recordingStartedAtRef = useRef<number | null>(null);
  const silenceStartedAtRef = useRef<number | null>(null);
  const waveformFrameCountRef = useRef(0);
  const hadAquaKeyRef = useRef(false);
  const hadOpenAiKeyRef = useRef(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) {
        setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
      } else {
        setSettingsOpen(true);
      }
    } catch {
      setSettings(DEFAULT_SETTINGS);
      setSettingsOpen(true);
    }
    setSettingsReady(true);
  }, []);

  useEffect(() => {
    if (!settingsReady) return;
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settingsReady, settings]);

  useEffect(() => {
    const hasAqua = !!settings.aquaApiKey.trim();
    const hasOpenAi = !!settings.openaiApiKey.trim();

    if (!hadAquaKeyRef.current && hasAqua) {
      track('api_key_saved_aqua');
    }
    if (!hadOpenAiKeyRef.current && hasOpenAi) {
      track('api_key_saved_openai');
    }

    hadAquaKeyRef.current = hasAqua;
    hadOpenAiKeyRef.current = hasOpenAi;
  }, [settings.aquaApiKey, settings.openaiApiKey]);

  const updateSetting = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  const runClientSideEdit = useCallback(
    async (selectedText: string, instruction: string) => {
      const systemPrompt =
        'You are a precise text editor. Given a passage of selected text and a voice edit instruction, return ONLY the revised replacement text. No explanation, no markdown fences, no extra commentary.';

      const res = await fetch(`${settings.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.openaiApiKey.trim()}`,
        },
        body: JSON.stringify({
          model: settings.openaiModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Selected text:\n"${selectedText}"\n\nEdit instruction: ${instruction}` },
          ],
          temperature: 0.3,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message ?? data.error ?? 'Edit failed');
      }

      return (data.choices?.[0]?.message?.content as string | undefined)?.trim() ?? '';
    },
    [settings.openaiApiKey, settings.openaiBaseUrl, settings.openaiModel],
  );

  const checkSelection = useCallback(() => {
    const ta = textareaRef.current;
    setHasSelection(!!ta && ta.selectionStart !== ta.selectionEnd);
  }, []);

  const pushHistory = useCallback((snapshot: string) => {
    setHistory((prev) => {
      if (!snapshot.trim()) return prev;
      if (prev[prev.length - 1] === snapshot) return prev;
      return [...prev.slice(-19), snapshot];
    });
  }, []);

  const handleRestoreSnapshot = useCallback((snapshot: string) => {
    track('history_restore');
    setTranscript(snapshot);
  }, []);

  useEffect(() => {
    const pendingCaretRange = pendingCaretRangeRef.current;
    const ta = textareaRef.current;
    if (!pendingCaretRange || !ta) return;

    ta.focus();
    ta.setSelectionRange(pendingCaretRange.start, pendingCaretRange.end);
    pendingCaretRangeRef.current = null;
  }, [transcript]);

  const clearTextareaSelection = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.blur();
    ta.setSelectionRange(0, 0);
  }, []);

  const stopMicMonitoring = useCallback(() => {
    if (meterAnimationRef.current !== null) {
      cancelAnimationFrame(meterAnimationRef.current);
      meterAnimationRef.current = null;
    }
    sourceNodeRef.current?.disconnect();
    analyserRef.current?.disconnect();
    void audioContextRef.current?.close().catch(() => {});
    sourceNodeRef.current = null;
    analyserRef.current = null;
    audioContextRef.current = null;
    recordingStartedAtRef.current = null;
    silenceStartedAtRef.current = null;
    waveformFrameCountRef.current = 0;
    setInputLevel(0);
    setInputDb(-100);
    setWaveformHistory(Array(WAVEFORM_POINTS).fill(WAVEFORM_MIN_DB));
    setRecordingSeconds(0);
    setMicHasSignal(false);
  }, []);

  const startMicMonitoring = useCallback(
    (stream: MediaStream) => {
      stopMicMonitoring();

      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      const sourceNode = audioContext.createMediaStreamSource(stream);

      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      sourceNode.connect(analyser);

      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      sourceNodeRef.current = sourceNode;
      recordingStartedAtRef.current = performance.now();
      silenceStartedAtRef.current = performance.now();

      const data = new Float32Array(analyser.fftSize);
      const tick = () => {
        const currentAnalyser = analyserRef.current;
        if (!currentAnalyser) return;

        currentAnalyser.getFloatTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i += 1) {
          const sample = Math.abs(data[i]);
          if (sample > peak) peak = sample;
        }

        const db = 20 * Math.log10(Math.max(peak, 1e-5));
        const clampedDb = Math.max(WAVEFORM_MIN_DB, Math.min(0, db));
        const normalizedLevel = Math.min(1, Math.max(0, (clampedDb - WAVEFORM_MIN_DB) / Math.abs(WAVEFORM_MIN_DB)));
        const now = performance.now();
        const hasSignalNow = db > -50;

        if (recordingStartedAtRef.current !== null) {
          setRecordingSeconds((now - recordingStartedAtRef.current) / 1000);
        }
        setInputLevel(normalizedLevel);
        setInputDb(db);
        waveformFrameCountRef.current += 1;
        if (waveformFrameCountRef.current % 3 === 0) {
          setWaveformHistory((prev) => [...prev.slice(1), clampedDb]);
        }

        if (hasSignalNow) {
          silenceStartedAtRef.current = null;
          setMicHasSignal(true);
        } else {
          if (silenceStartedAtRef.current === null) {
            silenceStartedAtRef.current = now;
          }
          setMicHasSignal(now - silenceStartedAtRef.current < 1500);
        }

        meterAnimationRef.current = requestAnimationFrame(tick);
      };

      meterAnimationRef.current = requestAnimationFrame(tick);
    },
    [stopMicMonitoring],
  );

  const startRecording = useCallback(
    async (mode: RecordingMode = 'ptt') => {
      if (isRecordingRef.current) return;
      if (!settings.aquaApiKey.trim()) {
        setErrorMsg('Open Settings and enter your Aqua Voice Avalon API key before recording.');
        setStatus('error');
        setSettingsOpen(true);
        return;
      }

      const ta = textareaRef.current;
      const textareaHasFocus = !!ta && document.activeElement === ta;
      textareaHadFocusRef.current = textareaHasFocus;

      if (textareaHasFocus && ta.selectionStart !== ta.selectionEnd) {
        if (!settings.openaiApiKey.trim()) {
          setErrorMsg('Open Settings and enter your OpenAI API key to use selection-based AI edit.');
          setStatus('error');
          setSettingsOpen(true);
          return;
        }
        editRangeRef.current = {
          start: ta.selectionStart,
          end: ta.selectionEnd,
          selectedText: ta.value.slice(ta.selectionStart, ta.selectionEnd),
        };
        caretPosRef.current = null;
        setEditModeActive(true);
      } else {
        editRangeRef.current = null;
        caretPosRef.current = textareaHasFocus && ta ? ta.selectionStart : null;
        setEditModeActive(false);
      }

      isRecordingRef.current = true;
      recordingModeRef.current = mode;

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        chunksRef.current = [];
        startMicMonitoring(stream);

        const mediaRecorder = new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;

        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };

        mediaRecorder.start();
        track(mode === 'ptt' ? 'record_start_ptt' : 'record_start_toggle', {
          language: settings.language,
          edit_mode: !!editRangeRef.current,
        });
        setStatus('recording');
        setErrorMsg('');
      } catch {
        isRecordingRef.current = false;
        recordingModeRef.current = null;
        editRangeRef.current = null;
        caretPosRef.current = null;
        textareaHadFocusRef.current = false;
        stopMicMonitoring();
        setEditModeActive(false);
        track('mic_permission_denied');
        setErrorMsg('Microphone access denied. Please allow microphone access and try again.');
        setStatus('error');
      }
    },
    [settings.aquaApiKey, settings.language, settings.openaiApiKey, startMicMonitoring, stopMicMonitoring],
  );

  const stopRecording = useCallback(async () => {
    const mediaRecorder = mediaRecorderRef.current;
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      isRecordingRef.current = false;
      recordingModeRef.current = null;
      return;
    }

    const snapshotBeforeEdit = transcript;
    setStatus('transcribing');

    mediaRecorder.onstop = async () => {
      const stoppedMode = recordingModeRef.current;
      isRecordingRef.current = false;
      recordingModeRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      stopMicMonitoring();

      if (!micHasSignal) {
        track('no_mic_signal', { mode: stoppedMode ?? 'unknown' });
      }

      const mimeType = mediaRecorder.mimeType || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type: mimeType });
      const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';

      const formData = new FormData();
      formData.append('file', blob, `recording.${ext}`);
      formData.append('model', settings.aquaModel);
      formData.append('language', settings.language);

      try {
        const res = await fetch(`${settings.aquaBaseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${settings.aquaApiKey.trim()}`,
          },
          body: formData,
        });
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error ?? 'Transcription failed');
        }

        const instruction = data.text as string;
        const range = editRangeRef.current;

        if (!instruction.trim()) {
          track('transcription_empty', {
            mode: stoppedMode ?? 'unknown',
            language: settings.language,
          });
        } else {
          track('transcription_success', {
            mode: stoppedMode ?? 'unknown',
            language: settings.language,
            edit_mode: !!range,
          });
        }

        if (range) {
          setStatus('editing');
          let replacement: string;
          try {
            replacement = await runClientSideEdit(range.selectedText, instruction);
            track('ai_edit_success', { language: settings.language });
          } catch (err) {
            track('ai_edit_error', {
              type: classifyError(err),
              language: settings.language,
            });
            throw err;
          }
          const nextTranscript = snapshotBeforeEdit.slice(0, range.start) + replacement + snapshotBeforeEdit.slice(range.end);
          pendingCaretRangeRef.current = {
            start: range.start + replacement.length,
            end: range.start + replacement.length,
          };
          setTranscript(nextTranscript);
          pushHistory(nextTranscript);
          editRangeRef.current = null;
          caretPosRef.current = null;
          textareaHadFocusRef.current = false;
          setEditModeActive(false);
          setHasSelection(false);
          setStatus('done');

          try {
            await navigator.clipboard.writeText(replacement);
            setCopied(true);
            setTimeout(() => setCopied(false), 3000);
          } catch {
            // clipboard write may fail in non-secure contexts
          }
        } else {
          const caretPos = caretPosRef.current;
          const textareaHadFocus = textareaHadFocusRef.current;
          caretPosRef.current = null;
          textareaHadFocusRef.current = false;

          let nextTranscript: string;
          let nextCaretPos: number | null = null;
          if (!snapshotBeforeEdit || !textareaHadFocus) {
            nextTranscript = instruction;
          } else if (caretPos === null || caretPos >= snapshotBeforeEdit.length) {
            const sep = snapshotBeforeEdit.endsWith(' ') ? '' : ' ';
            nextTranscript = snapshotBeforeEdit + sep + instruction;
            nextCaretPos = nextTranscript.length;
          } else {
            const before = snapshotBeforeEdit.slice(0, caretPos);
            const after = snapshotBeforeEdit.slice(caretPos);
            const prefix = before && !before.endsWith(' ') ? ' ' : '';
            const suffix = after && !after.startsWith(' ') ? ' ' : '';
            nextTranscript = before + prefix + instruction + suffix + after;
            nextCaretPos = before.length + prefix.length + instruction.length;
          }

          if (nextCaretPos !== null) {
            pendingCaretRangeRef.current = { start: nextCaretPos, end: nextCaretPos };
          }
          setTranscript(nextTranscript);
          pushHistory(nextTranscript);
          if (nextCaretPos === null) {
            clearTextareaSelection();
          }
          setEditModeActive(false);
          setStatus('done');

          try {
            await navigator.clipboard.writeText(nextTranscript);
            setCopied(true);
            setTimeout(() => setCopied(false), 3000);
          } catch {
            // clipboard write may fail in non-secure contexts
          }
        }
      } catch (err) {
        editRangeRef.current = null;
        caretPosRef.current = null;
        textareaHadFocusRef.current = false;
        pendingCaretRangeRef.current = null;
        setEditModeActive(false);
        track('transcription_error', {
          type: classifyError(err),
          mode: stoppedMode ?? 'unknown',
        });
        setErrorMsg(err instanceof Error ? err.message : 'Transcription failed');
        setStatus('error');
      }
    };

    mediaRecorder.stop();
  }, [
    clearTextareaSelection,
    pushHistory,
    runClientSideEdit,
    settings.aquaApiKey,
    settings.aquaBaseUrl,
    settings.aquaModel,
    settings.language,
    stopMicMonitoring,
    transcript,
    micHasSignal,
  ]);

  useEffect(() => () => {
    stopMicMonitoring();
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }, [stopMicMonitoring]);

  useEffect(() => {
    const onMouseUp = () => {
      if (isRecordingRef.current && recordingModeRef.current === 'ptt') stopRecording();
    };
    document.addEventListener('mouseup', onMouseUp);
    return () => document.removeEventListener('mouseup', onMouseUp);
  }, [stopRecording]);

  const handleToggleClick = useCallback(() => {
    if (isRecordingRef.current && recordingModeRef.current === 'toggle') {
      stopRecording();
    } else if (!isRecordingRef.current) {
      startRecording('toggle');
    }
  }, [startRecording, stopRecording]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(transcript);
      track('clipboard_copy');
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // noop
    }
  }, [transcript]);

  const buttonDisabled = status === 'transcribing' || status === 'editing' || !settings.aquaApiKey.trim();
  const isToggleRecording = status === 'recording' && recordingModeRef.current === 'toggle';
  const isPttRecording = status === 'recording' && recordingModeRef.current === 'ptt';

  const statusLabel =
    status === 'recording' && editModeActive
      ? recordingModeRef.current === 'toggle'
        ? 'Recording edit instruction… click to stop'
        : 'Recording edit instruction… release to stop'
      : status === 'recording'
        ? recordingModeRef.current === 'toggle'
          ? 'Recording… click to stop'
          : 'Recording… release to stop'
        : STATUS_LABEL[status];

  const formattedRecordingTime = `${Math.floor(recordingSeconds / 60)
    .toString()
    .padStart(2, '0')}:${Math.floor(recordingSeconds % 60)
    .toString()
    .padStart(2, '0')}`;
  const waveformPoints = waveformHistory.map((db, index) => {
    const x = (index / (WAVEFORM_POINTS - 1)) * 100;
    const amplitude = Math.max(0, Math.min(1, (db - WAVEFORM_MIN_DB) / Math.abs(WAVEFORM_MIN_DB)));
    const halfHeight = amplitude * 48;
    return {
      x,
      top: 50 - halfHeight,
      bottom: 50 + halfHeight,
    };
  });
  const waveformFillPath = waveformPoints.length
    ? [
        `M ${waveformPoints[0].x.toFixed(2)} ${waveformPoints[0].top.toFixed(2)}`,
        ...waveformPoints.slice(1).map((point) => `L ${point.x.toFixed(2)} ${point.top.toFixed(2)}`),
        ...waveformPoints.slice().reverse().map((point) => `L ${point.x.toFixed(2)} ${point.bottom.toFixed(2)}`),
        'Z',
      ].join(' ')
    : '';

  const historyEntries = [...history].reverse();

  return (
    <>
      <button
        type="button"
        onClick={() => {
          track('settings_open');
          setSettingsOpen(true);
        }}
        className="fixed left-4 top-4 z-30 rounded-xl border border-gray-800 bg-gray-900/95 px-3 py-2 text-sm text-gray-300 shadow-lg shadow-black/30 transition hover:border-gray-700 hover:text-white"
      >
        ⚙️ Settings
      </button>

      {settingsOpen && (
        <button
          type="button"
          aria-label="Close settings"
          className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm"
          onClick={() => setSettingsOpen(false)}
        />
      )}

      <aside
        className={[
          'fixed inset-y-0 left-0 z-40 w-[22rem] max-w-[88vw] border-r border-gray-800 bg-gray-950/98 p-4 shadow-2xl shadow-black/40 transition-transform duration-200',
          settingsOpen ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
      >
        <div className="flex h-full flex-col gap-4 overflow-y-auto">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-white">Settings</h2>
              <p className="mt-1 text-xs text-gray-500">
                Stored only in this browser. Requests go directly to Aqua/OpenAI.{' '}
                <a
                  href="https://github.com/aerialist/paua-ripple#readme"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-gray-300"
                >
                  How to get API keys →
                </a>
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSettingsOpen(false)}
              className="rounded-lg px-2 py-1 text-gray-500 transition hover:bg-gray-900 hover:text-gray-300"
              aria-label="Close settings"
            >
              ✕
            </button>
          </div>

          <section className="space-y-3">
            <div>
              <label htmlFor="aqua-api-key" className="mb-1 block text-xs text-gray-400">Aqua Voice Avalon API key</label>
              <input
                id="aqua-api-key"
                type="password"
                value={settings.aquaApiKey}
                onChange={(e) => updateSetting('aquaApiKey', e.target.value)}
                placeholder="Enter Aqua Voice Avalon API key"
                autoComplete="off"
                className="w-full rounded-xl border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label htmlFor="openai-api-key" className="mb-1 block text-xs text-gray-400">OpenAI API key</label>
              <input
                id="openai-api-key"
                type="password"
                value={settings.openaiApiKey}
                onChange={(e) => updateSetting('openaiApiKey', e.target.value)}
                placeholder="Optional: for selection-based AI edit"
                autoComplete="off"
                className="w-full rounded-xl border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label htmlFor="language" className="mb-1 block text-xs text-gray-400">Default language</label>
              <select
                id="language"
                value={settings.language}
                onChange={(e) => updateSetting('language', e.target.value as LanguageOption)}
                className="w-full rounded-xl border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </section>

          <section className="space-y-3 border-t border-gray-800 pt-4">
            <div>
              <label htmlFor="aqua-model" className="mb-1 block text-xs text-gray-400">Aqua model</label>
              <input
                id="aqua-model"
                type="text"
                value={settings.aquaModel}
                onChange={(e) => updateSetting('aquaModel', e.target.value)}
                className="w-full rounded-xl border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label htmlFor="openai-model" className="mb-1 block text-xs text-gray-400">OpenAI model</label>
              <input
                id="openai-model"
                type="text"
                value={settings.openaiModel}
                onChange={(e) => updateSetting('openaiModel', e.target.value)}
                className="w-full rounded-xl border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label htmlFor="aqua-base-url" className="mb-1 block text-xs text-gray-400">Aqua base URL</label>
              <input
                id="aqua-base-url"
                type="text"
                value={settings.aquaBaseUrl}
                onChange={(e) => updateSetting('aquaBaseUrl', e.target.value)}
                className="w-full rounded-xl border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label htmlFor="openai-base-url" className="mb-1 block text-xs text-gray-400">OpenAI base URL</label>
              <input
                id="openai-base-url"
                type="text"
                value={settings.openaiBaseUrl}
                onChange={(e) => updateSetting('openaiBaseUrl', e.target.value)}
                className="w-full rounded-xl border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </section>

          <section className="mt-auto space-y-3">
            <div className="rounded-2xl border border-gray-800 bg-gray-900/80 p-3 text-xs text-gray-500">
              <p>Aqua: {maskSecret(settings.aquaApiKey)}</p>
              <p>OpenAI: {maskSecret(settings.openaiApiKey)}</p>
              <p className="mt-2">This app is designed to be static-host friendly: HTML, JavaScript, and CSS only.</p>
            </div>
            <a
              href="https://ko-fi.com/Z8Z11Z232Z"
              target="_blank"
              rel="noreferrer"
              className="flex justify-center"
              onClick={() => track('kofi_click')}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img height="36" style={{ border: '0px', height: '36px' }} src="https://storage.ko-fi.com/cdn/kofi6.png?v=6" alt="Buy Me a Coffee at ko-fi.com" />
            </a>
          </section>
        </div>
      </aside>

      <main className="min-h-screen bg-gray-950 px-4 py-4 text-white">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-0 pt-10">
          <h1 className="mb-0.5 mt-2 text-xl font-semibold tracking-tight">PauaRipple</h1>
          <p className="mb-1 text-xs text-gray-400">Browser voice dictation powered by Aqua Voice Avalon API</p>
          <a
            href="https://github.com/aerialist/paua-ripple"
            target="_blank"
            rel="noreferrer"
            className="mb-3 text-xs text-gray-600 hover:text-gray-400 transition-colors"
            onClick={() => track('github_click')}
          >
            GitHub
          </a>

          <div className="mb-4 flex w-full max-w-xs flex-col items-center gap-1">
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_CLASS[status]}`}>{statusLabel}</span>
            <div className="mt-1 min-h-[88px] w-full rounded-xl border border-gray-800 bg-gray-900 px-3 py-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-xs text-gray-300">Mic input</span>
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-gray-500">{Math.round(inputDb)} dB</span>
                  <span className="text-xs font-mono text-gray-400">{status === 'recording' ? formattedRecordingTime : '00:00'}</span>
                </div>
              </div>
              <div className="h-24 w-full overflow-hidden rounded-lg border border-gray-800 bg-gray-950/80 px-2 py-2">
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
                  {[0, 25, 50, 75, 100].map((y) => (
                    <line key={y} x1="0" y1={y} x2="100" y2={y} stroke="rgba(75,85,99,0.35)" strokeWidth="0.6" />
                  ))}
                  <line x1="0" y1="50" x2="100" y2="50" stroke="rgba(107,114,128,0.5)" strokeWidth="0.8" />
                  <path
                    d={waveformFillPath}
                    fill={status === 'recording' ? (micHasSignal ? '#34d399' : '#f59e0b') : '#4b5563'}
                    stroke="none"
                  />
                </svg>
              </div>
              <p className={`mt-2 text-center text-xs ${status === 'recording' ? (micHasSignal ? 'text-emerald-400' : 'text-yellow-400') : 'text-gray-500'}`}>
                {status === 'recording'
                  ? micHasSignal
                    ? 'Mic input detected.'
                    : 'Recording, but almost no mic input detected yet.'
                  : 'Waveform shows the latest ~10 seconds while recording.'}
              </p>
            </div>
            {status === 'error' && errorMsg && <p className="max-w-xs text-center text-xs text-red-400">{errorMsg}</p>}
            {!settings.aquaApiKey.trim() && (
              <p className="max-w-xs text-center text-xs text-gray-500">Open Settings and enter your Aqua Voice Avalon API key to enable recording.</p>
            )}
            {hasSelection && status === 'idle' && settings.aquaApiKey.trim() && (
              <p className={`max-w-xs text-center text-xs ${settings.openaiApiKey.trim() ? 'text-blue-400' : 'text-yellow-400'}`}>
                {settings.openaiApiKey.trim()
                  ? 'Text selected — hold PTT or click Toggle to dictate an edit instruction.'
                  : 'Selection-based AI edit also needs an OpenAI API key in Settings.'}
              </p>
            )}
          </div>

          <div className="flex items-end gap-8">
            <div className="flex flex-col items-center gap-1.5">
              <button
                aria-label="Hold to record (push-to-talk)"
                disabled={buttonDisabled || isToggleRecording}
                className={[
                  'h-24 w-24 select-none rounded-full font-semibold text-sm transition-all duration-150',
                  'focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-500',
                  buttonDisabled || isToggleRecording
                    ? 'cursor-not-allowed bg-gray-700 opacity-60'
                    : isPttRecording
                      ? 'cursor-pointer scale-110 bg-red-600 shadow-2xl shadow-red-900/60'
                      : 'cursor-pointer bg-blue-600 shadow-xl shadow-blue-900/40 hover:bg-blue-500 active:scale-95',
                ].join(' ')}
                onMouseDown={(e) => {
                  e.preventDefault();
                  startRecording('ptt');
                }}
                onMouseUp={stopRecording}
                onTouchStart={(e) => {
                  e.preventDefault();
                  startRecording('ptt');
                }}
                onTouchEnd={(e) => {
                  e.preventDefault();
                  stopRecording();
                }}
              >
                {isPttRecording ? (
                  <span className="text-2xl">⏹</span>
                ) : status === 'transcribing' || status === 'editing' ? (
                  <span className="animate-pulse text-2xl">⋯</span>
                ) : (
                  <span className="text-2xl">🎤</span>
                )}
              </button>
              <span className="text-xs font-medium uppercase tracking-wide text-gray-500">Hold to talk</span>
            </div>

            <div className="flex flex-col items-center gap-1.5">
              <button
                aria-label={isToggleRecording ? 'Click to stop recording' : 'Click to start recording (toggle)'}
                disabled={buttonDisabled || isPttRecording}
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleToggleClick}
                className={[
                  'h-24 w-24 select-none rounded-full font-semibold text-sm transition-all duration-150',
                  'focus:outline-none focus-visible:ring-4 focus-visible:ring-teal-500',
                  buttonDisabled || isPttRecording
                    ? 'cursor-not-allowed bg-gray-700 opacity-60'
                    : isToggleRecording
                      ? 'cursor-pointer scale-110 animate-pulse bg-red-600 shadow-2xl shadow-red-900/60'
                      : 'cursor-pointer bg-teal-600 shadow-xl shadow-teal-900/40 hover:bg-teal-500 active:scale-95',
                ].join(' ')}
              >
                {isToggleRecording ? (
                  <span className="text-2xl">⏹</span>
                ) : status === 'transcribing' || status === 'editing' ? (
                  <span className="animate-pulse text-2xl">⋯</span>
                ) : (
                  <span className="text-2xl">🎙️</span>
                )}
              </button>
              <span className="text-xs font-medium uppercase tracking-wide text-teal-500">Toggle record</span>
            </div>
          </div>

          <div className="mt-4 flex w-full max-w-3xl flex-col items-start gap-3 md:flex-row">
            <div className="min-w-0 flex-1">
              <label htmlFor="transcript" className="mb-1 block text-xs text-gray-400">
                {transcript
                  ? 'Transcript — click to position caret, or select text to dictate an edit instruction'
                  : 'Transcript'}
              </label>
              <textarea
                id="transcript"
                ref={textareaRef}
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                onFocus={() => {
                  prefocusTranscriptRef.current = transcript;
                }}
                onBlur={() => {
                  if (transcript !== prefocusTranscriptRef.current) {
                    pushHistory(transcript);
                  }
                }}
                onSelect={checkSelection}
                onMouseUp={checkSelection}
                onKeyUp={checkSelection}
                placeholder="Transcript will appear here after recording…"
                rows={4}
                className="w-full resize-y rounded-xl border border-gray-800 bg-gray-900 p-3 text-sm leading-relaxed text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                {transcript && (
                  <button
                    onClick={handleCopy}
                    className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs text-gray-300 transition-colors hover:bg-gray-700"
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                )}
                <button
                  onClick={() => setHistoryOpen((o) => !o)}
                  className={[
                    'rounded-lg px-3 py-1.5 text-xs transition-colors',
                    historyOpen ? 'bg-gray-700 text-gray-200' : 'bg-gray-800 text-gray-400 hover:bg-gray-700',
                  ].join(' ')}
                  aria-expanded={historyOpen}
                >
                  History{history.length > 0 ? ` (${history.length})` : ''}
                </button>
                {copied && <span className="text-xs text-green-400">✓ Auto-copied</span>}
              </div>
            </div>

            {historyOpen && (
              <div className="flex w-full flex-shrink-0 flex-col rounded-xl border border-gray-800 bg-gray-900 md:w-52">
                <div className="flex items-center justify-between gap-2 border-b border-gray-800 px-3 py-2">
                  <span className="text-xs font-medium text-gray-400">History</span>
                  <div className="flex items-center gap-2">
                    {historyEntries.length > 0 && (
                      <button
                        onClick={() => setHistory([])}
                        className="rounded-md bg-gray-800 px-2 py-1 text-[11px] text-gray-400 transition-colors hover:bg-gray-700 hover:text-gray-200"
                      >
                        Clear
                      </button>
                    )}
                    <button
                      onClick={() => setHistoryOpen(false)}
                      className="text-sm leading-none text-gray-500 hover:text-gray-300"
                      aria-label="Close history"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                {historyEntries.length === 0 ? (
                  <p className="px-3 py-3 text-xs text-gray-600">No history yet.</p>
                ) : (
                  <div className="max-h-52 overflow-y-auto divide-y divide-gray-800">
                    {historyEntries.map((snapshot, i) => (
                      <button
                        key={i}
                        onClick={() => handleRestoreSnapshot(snapshot)}
                        className="truncate px-3 py-2 text-left text-xs text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
                        title={snapshot || '(empty)'}
                      >
                        {snapshot.trim() ? snapshot.slice(0, 60) + (snapshot.length > 60 ? '…' : '') : '(empty)'}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
