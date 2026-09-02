'use client';

import {
  FormEvent,
  MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

const PRIMARY_REACTION_EMOJIS = ['😂', '❓', '💀', '😭', '❤️'] as const;
const REACTION_EMOJIS = [
  ...PRIMARY_REACTION_EMOJIS,
  '🤣',
  '😮',
  '😱',
  '😍',
  '🥹',
  '👀',
  '🤔',
  '😡',
  '🤯',
  '👏',
  '🔥',
  '👍',
  '👎',
  '🎉',
  '😬',
] as const;
const OBSERVATION_INTERVALS_SECONDS = [5, 10, 15] as const;
const DEFAULT_OBSERVATION_INTERVAL_SECONDS = 5;
const VIEWER_REACTION_COOLDOWN_MS = 3_000;
const MAX_AGENT_REACTIONS = 5;

const WATCH_PROTOCOL = {
  role: 'Share the open video with the user as a natural viewing companion.',
  userIntent:
    'The user decides what kind of company they want. Follow their current request; watching together does not require a fixed amount of commentary or reactions.',
  observation:
    'When the user asks you to actively watch, run every observation as one programmatic browser call: preselect the rendered .player-frame, await watch_observe_next_moment, capture that frame in the very next browser operation, and return the structured observation and image to the model together. Never yield to model reasoning between the WebMCP result and frame capture, and never invoke the observer as a standalone call during active watching. Repeat this paired operation in the same turn. Each observer resolves when the configured observation interval elapses or immediately when the user sends a live signal. A live signal interrupts the wait, not the watch-along: handle it and immediately continue observing while playback is active. Stop only when the user asks you to stop watching or playback pauses, ends, or becomes unavailable.',
  behavior: [
    'Stay quiet by default.',
    'Do not comment on every observation.',
    'Every viewer emoji is intentional input. Acknowledge it in context with a brief comment, answer, or reaction; do not end the watch-along after acknowledging it.',
    'Do not pause playback solely because the viewer sent an emoji.',
    'Prefer a lightweight reaction when that communicates enough.',
    'Keep comments and reactions tied to the current playback moment.',
    'Do not infer or reveal events beyond the current playback position.',
    'Pause playback before a longer response when video and conversation would compete.',
  ],
  reactions: REACTION_EMOJIS,
} as const;

type SourceKind = 'youtube' | 'direct' | 'embed';
type PlaybackStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'unavailable';

type VideoSource =
  | { kind: 'youtube'; url: string; videoId: string }
  | { kind: 'direct'; url: string }
  | { kind: 'embed'; url: string };

type MediaMetadata = {
  sessionId: string;
  sourceKind: SourceKind;
  sourceId: string;
  providerName: string | null;
  title: string | null;
  authorName: string | null;
  publishedAt: string | null;
  viewCount: string | null;
  status: 'loading' | 'partial' | 'unavailable';
  missingFields: string[];
};

type PlaybackSnapshot = {
  sourceUrl: string | null;
  sourceKind: SourceKind | null;
  status: PlaybackStatus;
  currentTime: number | null;
  duration: number | null;
  controllable: boolean;
};

type PlayerController = {
  play: () => Promise<boolean>;
  pause: () => Promise<boolean>;
};

type ReactionEmoji = (typeof REACTION_EMOJIS)[number];
type ObservationIntervalSeconds = (typeof OBSERVATION_INTERVALS_SECONDS)[number];

type UserSignal = {
  id: string;
  kind: 'emoji';
  emoji: ReactionEmoji;
  createdAt: string;
  playbackTime: number | null;
  timecode: string | null;
};

type ObservationWake =
  | { reason: 'interval' }
  | { reason: 'user_signal'; signal: UserSignal }
  | { reason: 'cancelled' };

type ObservationWaiter = {
  timerId: number;
  resolve: (wake: ObservationWake) => void;
};

type ObservationCursor = {
  sourceUrl: string;
  intervalSeconds: ObservationIntervalSeconds;
  previousPlaybackTime: number;
  nextCheckpointTime: number;
  discontinuitySequence: number;
};

type PlaybackSample = {
  mediaTime: number;
  sampledAt: number;
  sourceUrl: string | null;
};

type ReactionEvent = {
  id: string;
  emoji: ReactionEmoji;
  source: 'user' | 'agent';
  createdAt: string;
  playbackTime: number | null;
  timecode: string | null;
  left: number;
};

type WebMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execute: (input?: unknown) => unknown | Promise<unknown>;
};

type ModelContext = {
  registerTool: (tool: WebMcpTool) => void | Promise<void>;
  unregisterTool?: (name: string) => void | Promise<void>;
};

type YouTubePlayer = {
  playVideo: () => void;
  pauseVideo: () => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
  destroy: () => void;
};

type YouTubeNamespace = {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      playerVars: Record<string, string | number>;
      events: {
        onReady: (event: { target: YouTubePlayer }) => void;
        onStateChange: () => void;
        onError: () => void;
      };
    },
  ) => YouTubePlayer;
};

declare global {
  interface Document {
    modelContext?: ModelContext;
  }

  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const EMPTY_PLAYBACK: PlaybackSnapshot = {
  sourceUrl: null,
  sourceKind: null,
  status: 'idle',
  currentTime: null,
  duration: null,
  controllable: false,
};

let youtubeApiPromise: Promise<YouTubeNamespace> | null = null;

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

function finiteTime(value: number) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 10) / 10 : null;
}

function finiteDelta(value: number) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function formatTimecode(value: number | null) {
  if (value === null || !Number.isFinite(value) || value < 0) return null;

  const totalTenths = Math.round(value * 10);
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

function publicPlaybackState(snapshot: PlaybackSnapshot) {
  const currentTime = snapshot.currentTime === null ? null : finiteTime(snapshot.currentTime);
  const duration = snapshot.duration === null ? null : finiteTime(snapshot.duration);

  return {
    ...snapshot,
    currentTime,
    timecode: formatTimecode(currentTime),
    duration,
    durationTimecode: formatTimecode(duration),
  };
}

function readablePathSegment(value: string | undefined) {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function initialMediaMetadata(source: VideoSource, sessionId: string): MediaMetadata {
  if (source.kind === 'youtube') {
    return {
      sessionId,
      sourceKind: source.kind,
      sourceId: source.videoId,
      providerName: 'YouTube',
      title: null,
      authorName: null,
      publishedAt: null,
      viewCount: null,
      status: 'loading',
      missingFields: ['title', 'authorName', 'publishedAt', 'viewCount'],
    };
  }

  const url = new URL(source.url);
  const directTitle =
    source.kind === 'direct'
      ? readablePathSegment(url.pathname.split('/').filter(Boolean).at(-1))
      : null;

  return {
    sessionId,
    sourceKind: source.kind,
    sourceId: source.url,
    providerName: url.hostname || null,
    title: directTitle,
    authorName: null,
    publishedAt: null,
    viewCount: null,
    status: source.kind === 'direct' ? 'partial' : 'unavailable',
    missingFields: [
      ...(directTitle ? [] : ['title']),
      'authorName',
      'publishedAt',
      'viewCount',
    ],
  };
}

function webMcpError(code: string, message: string, snapshot: PlaybackSnapshot) {
  return {
    ok: false,
    error: { code, message },
    playback: publicPlaybackState(snapshot),
  };
}

function parseVideoSource(value: string): VideoSource {
  let url: URL;

  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Enter a complete video URL.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only http and https video links are supported.');
  }

  if (url.origin === window.location.origin) {
    throw new Error('Paste a video URL, not the Watch with GPT site URL.');
  }

  const hostname = url.hostname.toLowerCase();
  const isYouTube =
    hostname === 'youtu.be' ||
    hostname === 'youtube.com' ||
    hostname.endsWith('.youtube.com') ||
    hostname === 'youtube-nocookie.com' ||
    hostname.endsWith('.youtube-nocookie.com');

  if (isYouTube) {
    const pathParts = url.pathname.split('/').filter(Boolean);
    const videoId =
      hostname === 'youtu.be'
        ? pathParts[0]
        : url.searchParams.get('v') ??
          (['embed', 'shorts', 'live'].includes(pathParts[0] ?? '') ? pathParts[1] : null);

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      throw new Error('This YouTube link does not contain a valid video ID.');
    }

    return { kind: 'youtube', url: url.toString(), videoId };
  }

  if (/\.(mp4|webm|ogg|ogv|m4v|mov)$/i.test(url.pathname)) {
    return { kind: 'direct', url: url.toString() };
  }

  return { kind: 'embed', url: url.toString() };
}

function loadYouTubeApi() {
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }

  if (youtubeApiPromise) {
    return youtubeApiPromise;
  }

  youtubeApiPromise = new Promise<YouTubeNamespace>((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    const timeoutId = window.setTimeout(() => {
      reject(new Error('YouTube player API did not load.'));
    }, 12_000);

    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      window.clearTimeout(timeoutId);
      if (window.YT?.Player) {
        resolve(window.YT);
      } else {
        reject(new Error('YouTube player API is unavailable.'));
      }
    };

    if (!document.querySelector('script[data-youtube-iframe-api]')) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.dataset.youtubeIframeApi = 'true';
      script.addEventListener(
        'error',
        () => {
          window.clearTimeout(timeoutId);
          reject(new Error('YouTube player API could not be loaded.'));
        },
        { once: true },
      );
      document.head.appendChild(script);
    }
  });

  return youtubeApiPromise;
}

function youtubeStatus(state: number): PlaybackStatus {
  if (state === 1) return 'playing';
  if (state === 2) return 'paused';
  if (state === 0) return 'ended';
  if (state === 3) return 'loading';
  return 'ready';
}

function YouTubeSurface({
  source,
  controllerRef,
  onPlayback,
}: {
  source: Extract<VideoSource, { kind: 'youtube' }>;
  controllerRef: MutableRefObject<PlayerController | null>;
  onPlayback: (snapshot: Partial<PlaybackSnapshot>) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let player: YouTubePlayer | null = null;
    let intervalId: number | null = null;

    onPlayback({ status: 'loading', controllable: false });

    void loadYouTubeApi()
      .then((youtube) => {
        if (disposed || !hostRef.current) return;

        const report = () => {
          if (!player || disposed) return;
          onPlayback({
            status: youtubeStatus(player.getPlayerState()),
            currentTime: finiteTime(player.getCurrentTime()),
            duration: finiteTime(player.getDuration()),
            controllable: true,
          });
        };

        player = new youtube.Player(hostRef.current, {
          videoId: source.videoId,
          playerVars: {
            autoplay: 0,
            controls: 1,
            enablejsapi: 1,
            playsinline: 1,
            rel: 0,
            origin: window.location.origin,
          },
          events: {
            onReady: (event) => {
              player = event.target;
              controllerRef.current = {
                play: async () => {
                  player?.playVideo();
                  return true;
                },
                pause: async () => {
                  player?.pauseVideo();
                  return true;
                },
              };
              report();
              intervalId = window.setInterval(report, 250);
            },
            onStateChange: report,
            onError: () => {
              onPlayback({ status: 'unavailable', controllable: false });
            },
          },
        });
      })
      .catch(() => {
        if (!disposed) {
          onPlayback({ status: 'unavailable', controllable: false });
        }
      });

    return () => {
      disposed = true;
      controllerRef.current = null;
      if (intervalId !== null) window.clearInterval(intervalId);
      player?.destroy();
    };
  }, [controllerRef, onPlayback, source.videoId]);

  return <div className="youtube-host" ref={hostRef} />;
}

function DirectVideoSurface({
  source,
  controllerRef,
  onPlayback,
}: {
  source: Extract<VideoSource, { kind: 'direct' }>;
  controllerRef: MutableRefObject<PlayerController | null>;
  onPlayback: (snapshot: Partial<PlaybackSnapshot>) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const report = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const status: PlaybackStatus = video.ended
      ? 'ended'
      : video.paused
        ? video.readyState >= 2
          ? 'paused'
          : 'loading'
        : 'playing';

    onPlayback({
      status,
      currentTime: finiteTime(video.currentTime),
      duration: finiteTime(video.duration),
      controllable: true,
    });
  }, [onPlayback]);

  useEffect(() => {
    controllerRef.current = {
      play: async () => {
        const video = videoRef.current;
        if (!video) return false;
        try {
          await video.play();
          return true;
        } catch {
          return false;
        }
      },
      pause: async () => {
        const video = videoRef.current;
        if (!video) return false;
        video.pause();
        return true;
      },
    };

    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef]);

  return (
    <video
      ref={videoRef}
      src={source.url}
      controls
      playsInline
      preload="metadata"
      onCanPlay={report}
      onDurationChange={report}
      onEnded={report}
      onPause={report}
      onPlay={report}
      onTimeUpdate={report}
    />
  );
}

function PlayerSurface({
  source,
  controllerRef,
  onPlayback,
}: {
  source: VideoSource;
  controllerRef: MutableRefObject<PlayerController | null>;
  onPlayback: (snapshot: Partial<PlaybackSnapshot>) => void;
}) {
  useEffect(() => {
    if (source.kind === 'embed') {
      controllerRef.current = null;
      onPlayback({
        status: 'unavailable',
        currentTime: null,
        duration: null,
        controllable: false,
      });
    }
  }, [controllerRef, onPlayback, source.kind]);

  if (source.kind === 'youtube') {
    return (
      <YouTubeSurface
        source={source}
        controllerRef={controllerRef}
        onPlayback={onPlayback}
      />
    );
  }

  if (source.kind === 'direct') {
    return (
      <DirectVideoSurface
        source={source}
        controllerRef={controllerRef}
        onPlayback={onPlayback}
      />
    );
  }

  return (
    <iframe
      src={source.url}
      title="Shared video player"
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
      allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin"
    />
  );
}

export default function Home() {
  const [videoUrl, setVideoUrl] = useState('');
  const [source, setSource] = useState<VideoSource | null>(null);
  const [error, setError] = useState('');
  const [reactions, setReactions] = useState<ReactionEvent[]>([]);
  const [reactionMenuOpen, setReactionMenuOpen] = useState(false);
  const [viewerReactionCoolingDown, setViewerReactionCoolingDown] = useState(false);
  const [playbackStatus, setPlaybackStatus] = useState<PlaybackStatus>('idle');
  const [mediaMetadata, setMediaMetadata] = useState<MediaMetadata | null>(null);
  const [observationIntervalSeconds, setObservationIntervalSeconds] =
    useState<ObservationIntervalSeconds>(DEFAULT_OBSERVATION_INTERVAL_SECONDS);
  const playbackRef = useRef<PlaybackSnapshot>(EMPTY_PLAYBACK);
  const mediaMetadataRef = useRef(mediaMetadata);
  const observationIntervalRef = useRef(observationIntervalSeconds);
  const controllerRef = useRef<PlayerController | null>(null);
  const reactionSequenceRef = useRef(0);
  const signalSequenceRef = useRef(0);
  const mediaSessionSequenceRef = useRef(0);
  const pendingSignalsRef = useRef<UserSignal[]>([]);
  const observationWaiterRef = useRef<ObservationWaiter | null>(null);
  const observationCursorRef = useRef<ObservationCursor | null>(null);
  const playbackSampleRef = useRef<PlaybackSample | null>(null);
  const playbackDiscontinuitySequenceRef = useRef(0);
  const reactionMenuRef = useRef<HTMLDivElement>(null);
  const lastViewerReactionAtRef = useRef(0);
  const viewerReactionCooldownTimerRef = useRef<number | null>(null);

  useEffect(() => {
    mediaMetadataRef.current = mediaMetadata;
  }, [mediaMetadata]);

  useEffect(() => {
    observationIntervalRef.current = observationIntervalSeconds;
  }, [observationIntervalSeconds]);

  useEffect(() => {
    if (!source || source.kind !== 'youtube') return;

    const sessionId = mediaMetadataRef.current?.sessionId;
    let disposed = false;
    void fetch(`/api/youtube-metadata?videoId=${encodeURIComponent(source.videoId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('YouTube metadata is unavailable.');
        return (await response.json()) as {
          title?: unknown;
          authorName?: unknown;
        };
      })
      .then((metadata) => {
        if (disposed) return;
        setMediaMetadata((current) => {
          if (!current || current.sessionId !== sessionId) return current;
          const title = typeof metadata.title === 'string' ? metadata.title : null;
          const authorName =
            typeof metadata.authorName === 'string' ? metadata.authorName : null;
          return {
            ...current,
            title,
            authorName,
            status: title ? 'partial' : 'unavailable',
            missingFields: [
              ...(title ? [] : ['title']),
              ...(authorName ? [] : ['authorName']),
              'publishedAt',
              'viewCount',
            ],
          };
        });
      })
      .catch(() => {
        if (disposed) return;
        setMediaMetadata((current) =>
          current && current.sessionId === sessionId
            ? { ...current, status: 'unavailable' }
            : current,
        );
      });

    return () => {
      disposed = true;
    };
  }, [source]);

  useEffect(() => {
    if (!reactionMenuOpen) return;

    const closeOnOutsidePress = (event: PointerEvent) => {
      if (
        reactionMenuRef.current &&
        event.target instanceof Node &&
        !reactionMenuRef.current.contains(event.target)
      ) {
        setReactionMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setReactionMenuOpen(false);
    };

    document.addEventListener('pointerdown', closeOnOutsidePress);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [reactionMenuOpen]);

  useEffect(
    () => () => {
      if (viewerReactionCooldownTimerRef.current !== null) {
        window.clearTimeout(viewerReactionCooldownTimerRef.current);
      }
    },
    [],
  );

  const updatePlayback = useCallback((next: Partial<PlaybackSnapshot>) => {
    const previous = playbackRef.current;
    const current = { ...previous, ...next };
    const sampledAt = performance.now();

    if (current.currentTime !== null) {
      const previousSample = playbackSampleRef.current;
      if (
        previousSample &&
        previousSample.sourceUrl === current.sourceUrl &&
        previous.status === 'playing' &&
        current.status === 'playing'
      ) {
        const wallDeltaSeconds = Math.max(0, (sampledAt - previousSample.sampledAt) / 1_000);
        const mediaDeltaSeconds = current.currentTime - previousSample.mediaTime;
        const largestExpectedAdvance = Math.max(2, wallDeltaSeconds * 4 + 1);
        if (mediaDeltaSeconds < -1 || mediaDeltaSeconds > largestExpectedAdvance) {
          playbackDiscontinuitySequenceRef.current += 1;
        }
      }

      playbackSampleRef.current = {
        mediaTime: current.currentTime,
        sampledAt,
        sourceUrl: current.sourceUrl,
      };
    }

    playbackRef.current = current;
    if (current.status !== previous.status) {
      setPlaybackStatus(current.status);
    }
  }, []);

  const publishVisualReactions = useCallback(
    (emojis: readonly ReactionEmoji[], eventSource: 'user' | 'agent') => {
      const createdAt = new Date().toISOString();
      const playbackTime = finiteTime(playbackRef.current.currentTime ?? Number.NaN);
      const events = emojis.map((emoji) => {
        const sequence = reactionSequenceRef.current++;
        return {
          id: `${Date.now()}-${sequence}`,
          emoji,
          source: eventSource,
          createdAt,
          playbackTime,
          timecode: formatTimecode(playbackTime),
          left: 28 + ((sequence * 17) % 45),
        } satisfies ReactionEvent;
      });
      const eventIds = new Set(events.map((event) => event.id));

      setReactions((current) => [...current, ...events]);
      window.setTimeout(() => {
        setReactions((current) => current.filter((reaction) => !eventIds.has(reaction.id)));
      }, 2_200);

      return events;
    },
    [],
  );

  const releaseObservation = useCallback((wake: ObservationWake) => {
    const waiter = observationWaiterRef.current;
    if (!waiter) {
      return false;
    }

    window.clearTimeout(waiter.timerId);
    observationWaiterRef.current = null;
    waiter.resolve(wake);
    return true;
  }, []);

  const publishUserSignal = useCallback(
    (emoji: ReactionEmoji) => {
      const playbackTime = finiteTime(playbackRef.current.currentTime ?? Number.NaN);
      const signal: UserSignal = {
        id: `signal-${Date.now()}-${signalSequenceRef.current++}`,
        kind: 'emoji',
        emoji,
        createdAt: new Date().toISOString(),
        playbackTime,
        timecode: formatTimecode(playbackTime),
      };

      if (!releaseObservation({ reason: 'user_signal', signal })) {
        pendingSignalsRef.current = [...pendingSignalsRef.current.slice(-19), signal];
      }
    },
    [releaseObservation],
  );

  const publishUserReaction = useCallback(
    (emoji: ReactionEmoji) => {
      const now = Date.now();
      if (now - lastViewerReactionAtRef.current < VIEWER_REACTION_COOLDOWN_MS) return;

      lastViewerReactionAtRef.current = now;
      setViewerReactionCoolingDown(true);
      if (viewerReactionCooldownTimerRef.current !== null) {
        window.clearTimeout(viewerReactionCooldownTimerRef.current);
      }
      viewerReactionCooldownTimerRef.current = window.setTimeout(() => {
        setViewerReactionCoolingDown(false);
        viewerReactionCooldownTimerRef.current = null;
      }, VIEWER_REACTION_COOLDOWN_MS);

      publishVisualReactions([emoji], 'user');
      publishUserSignal(emoji);
    },
    [publishUserSignal, publishVisualReactions],
  );

  const waitForObservationWake = useCallback(
    (startPlaybackTime: number, targetPlaybackTime: number) => {
      const queuedSignal = pendingSignalsRef.current.shift();
      if (queuedSignal) {
        return Promise.resolve<ObservationWake>({
          reason: 'user_signal',
          signal: queuedSignal,
        });
      }

      const initial = playbackRef.current;
      if (
        initial.status !== 'playing' ||
        initial.currentTime === null ||
        initial.currentTime < startPlaybackTime - 1 ||
        initial.currentTime >= targetPlaybackTime
      ) {
        return Promise.resolve<ObservationWake>({ reason: 'interval' });
      }

      return new Promise<ObservationWake>((resolve) => {
        const checkPlaybackTime = () => {
          const waiter = observationWaiterRef.current;
          if (!waiter) return;

          const current = playbackRef.current;
          if (
            current.status !== 'playing' ||
            current.currentTime === null ||
            current.currentTime < startPlaybackTime - 1 ||
            current.currentTime >= targetPlaybackTime
          ) {
            observationWaiterRef.current = null;
            resolve({ reason: 'interval' });
            return;
          }

          const nextTimerId = window.setTimeout(checkPlaybackTime, 100);
          waiter.timerId = nextTimerId;
        };

        const timerId = window.setTimeout(checkPlaybackTime, 100);
        observationWaiterRef.current = { timerId, resolve };
      });
    },
    [],
  );

  useEffect(() => {
    const modelContext = document.modelContext;
    if (!modelContext?.registerTool) {
      document.documentElement.dataset.siteTools = 'unavailable';
      return;
    }

    const noInputSchema = {
      type: 'object',
      properties: {},
      additionalProperties: false,
    };

    const tools: WebMcpTool[] = [
      {
        name: 'watch_get_session',
        description:
          'Read the current shared-video state, session-level media metadata, and viewing protocol. Call this before starting a watch-along. The user’s current request determines the interaction style; do not assume they want constant commentary.',
        inputSchema: noInputSchema,
        annotations: { readOnlyHint: true },
        execute: async () => ({
          ok: true,
          media: mediaMetadataRef.current,
          playback: publicPlaybackState(playbackRef.current),
          protocol: {
            ...WATCH_PROTOCOL,
            observationIntervalSeconds: observationIntervalRef.current,
            observationIntervalBasis: 'video playback time',
            viewerReactionCooldownSeconds: VIEWER_REACTION_COOLDOWN_MS / 1_000,
            maxAgentReactionsPerCall: MAX_AGENT_REACTIONS,
            mediaMetadata:
              'watch_get_session returns session-level media identity once. Observations repeat only mediaSessionId and sourceId alongside timing fields.',
            liveSignals:
              'Any viewer emoji wakes watch_observe_next_moment immediately. It is intentional input inside the active watch-along, never an implicit request to pause or stop. Acknowledge it from the returned emoji, visible frame, and conversation context, then continue observing in the same turn while playback remains active.',
            visualCapture:
              'Use one programmatic browser call for the complete operation: preselect .player-frame, await watch_observe_next_moment, capture the rendered frame in the very next browser operation, and return the observation and image together. Do not invoke the observer as a standalone call and do not yield to model reasoning between the WebMCP result and capture. The frame includes the video, captions, and player overlays.',
          },
        }),
      },
      {
        name: 'watch_observe_next_moment',
        description:
          'Continue an active watch-along on a persistent media-time cursor. IMPORTANT: during active watching, never invoke this observer as a standalone call. Use one programmatic browser call that preselects the rendered .player-frame, awaits this WebMCP tool, captures that frame in the very next browser operation, and returns the structured observation and image to the model together. There must be zero model-reasoning turns between observer resolution and frame capture. The observer returns at the next scheduled checkpoint or immediately for any viewer emoji. At scheduled checkpoints, use the paired frame and conversation to decide whether to stay quiet, react, or comment. For a viewer emoji, always acknowledge the intentional signal in context, do not pause or end the watch-along solely because of it, and repeat the same paired observe-and-capture operation while playback remains active.',
        inputSchema: noInputSchema,
        annotations: { readOnlyHint: true },
        execute: async () => {
          const initial = playbackRef.current;
          if (!initial.sourceUrl) {
            return webMcpError('NO_VIDEO', 'No video is open.', initial);
          }
          if (initial.status !== 'playing') {
            return webMcpError(
              'PLAYBACK_NOT_PLAYING',
              'Observation is available only while playback is active.',
              initial,
            );
          }
          if (initial.currentTime === null) {
            return webMcpError(
              'PLAYER_STATE_UNAVAILABLE',
              'This embedded player does not expose playback timing to the page.',
              initial,
            );
          }

          if (observationWaiterRef.current) {
            return webMcpError(
              'OBSERVATION_ALREADY_PENDING',
              'Another observation call is already waiting for the next moment.',
              initial,
            );
          }

          const observedSource = initial.sourceUrl;
          const intervalSeconds = observationIntervalRef.current;
          const discontinuitySequence = playbackDiscontinuitySequenceRef.current;
          const storedCursor = observationCursorRef.current;
          const canReuseCursor =
            storedCursor?.sourceUrl === observedSource &&
            storedCursor.intervalSeconds === intervalSeconds &&
            storedCursor.discontinuitySequence === discontinuitySequence &&
            initial.currentTime >= storedCursor.previousPlaybackTime - 1;
          const cursor: ObservationCursor = canReuseCursor
            ? storedCursor
            : {
                sourceUrl: observedSource,
                intervalSeconds,
                previousPlaybackTime: initial.currentTime,
                nextCheckpointTime: initial.currentTime + intervalSeconds,
                discontinuitySequence,
              };
          observationCursorRef.current = cursor;

          const wake = await waitForObservationWake(
            initial.currentTime,
            cursor.nextCheckpointTime,
          );
          const current = playbackRef.current;

          if (wake.reason === 'cancelled') {
            return webMcpError(
              'OBSERVATION_CANCELLED',
              'The watch page stopped the pending observation.',
              current,
            );
          }

          if (current.sourceUrl !== observedSource) {
            return webMcpError(
              'SESSION_CHANGED',
              'The user changed the video during observation.',
              current,
            );
          }
          if (current.status !== 'playing') {
            return webMcpError(
              'PLAYBACK_STOPPED',
              'Playback paused or ended. Stop the observation loop.',
              current,
            );
          }

          const currentPlaybackTime = finiteTime(current.currentTime ?? Number.NaN);
          if (currentPlaybackTime === null) {
            return webMcpError(
              'PLAYER_STATE_UNAVAILABLE',
              'The player stopped exposing playback timing during observation.',
              current,
            );
          }

          const currentDiscontinuitySequence = playbackDiscontinuitySequenceRef.current;
          const seekDetected =
            currentDiscontinuitySequence !== cursor.discontinuitySequence ||
            currentPlaybackTime < cursor.previousPlaybackTime - 1;
          const elapsedPlaybackSeconds =
            finiteDelta(currentPlaybackTime - cursor.previousPlaybackTime);
          const crossedCheckpointCount =
            seekDetected || currentPlaybackTime < cursor.nextCheckpointTime
              ? 0
              : Math.floor(
                  (currentPlaybackTime - cursor.nextCheckpointTime) / intervalSeconds,
                ) + 1;
          const nextCheckpointTime = seekDetected
            ? currentPlaybackTime + intervalSeconds
            : cursor.nextCheckpointTime + crossedCheckpointCount * intervalSeconds;

          observationCursorRef.current = {
            sourceUrl: observedSource,
            intervalSeconds,
            previousPlaybackTime: currentPlaybackTime,
            nextCheckpointTime,
            discontinuitySequence: currentDiscontinuitySequence,
          };

          const observationId = `observation-${Date.now()}`;
          const capturedAt = new Date().toISOString();

          return {
            ok: true,
            observation: {
              id: observationId,
              capturedAt,
              wakeReason: wake.reason,
              signal: wake.reason === 'user_signal' ? wake.signal : null,
              observationIntervalSeconds: intervalSeconds,
              observationIntervalBasis: 'video playback time',
              previousPlaybackTime: cursor.previousPlaybackTime,
              previousTimecode: formatTimecode(cursor.previousPlaybackTime),
              elapsedPlaybackSeconds,
              seekDetected,
              cursor: {
                crossedCheckpointCount,
                missedCheckpointCount: Math.max(0, crossedCheckpointCount - 1),
                nextCheckpointPlaybackTime: finiteTime(nextCheckpointTime),
                nextCheckpointTimecode: formatTimecode(nextCheckpointTime),
              },
              mediaSessionId: mediaMetadataRef.current?.sessionId ?? null,
              sourceId: mediaMetadataRef.current?.sourceId ?? null,
              playback: publicPlaybackState(current),
              visualCapture: {
                source: 'browser page observation',
                targetSelector: '.player-frame',
                includes: ['video', 'captions', 'player overlays'],
                requiredBeforeReasoning: true,
                orchestration: 'same programmatic browser call',
                returnWithObservation: true,
                interveningModelTurns: 0,
                sequence: [
                  'await watch_observe_next_moment',
                  'capture .player-frame in the next browser operation',
                  'return the structured observation and image together',
                ],
              },
              visualInstruction:
                'This observation is incomplete without its paired frame. The same browser program that awaited this result must capture the rendered .player-frame in its very next operation and return the structured observation and image together. Do not yield to model reasoning between this result and the capture. Only then use the frame, wake reason, optional user signal, and conversation context to decide whether to stay quiet, react, or respond.',
              continuationInstruction:
                wake.reason === 'user_signal'
                  ? 'This viewer signal is part of the ongoing watch-along, not a stop or pause request. After the paired frame is captured, acknowledge the signal in context, keep playback running, and immediately repeat the same one-program observe-and-capture operation in this turn. Stop only if the user explicitly asks you to stop watching or playback is no longer active.'
                  : 'If the user still wants active watching and playback remains active, immediately repeat the same one-program observe-and-capture operation in this turn. Stop only if the user asks you to stop watching or playback is no longer active.',
            },
          };
        },
      },
      {
        name: 'watch_play',
        description:
          'Start or resume the shared video when the user asks. This changes visible playback. It fails explicitly when the embedded player does not expose controls.',
        inputSchema: noInputSchema,
        execute: async () => {
          const controller = controllerRef.current;
          if (!controller) {
            return webMcpError(
              'PLAYER_NOT_CONTROLLABLE',
              'This player does not expose playback controls to the page.',
              playbackRef.current,
            );
          }
          const played = await controller.play();
          await wait(180);
          return played
            ? { ok: true, playback: publicPlaybackState(playbackRef.current) }
            : webMcpError(
                'PLAY_REJECTED',
                'The browser or player rejected playback.',
                playbackRef.current,
              );
        },
      },
      {
        name: 'watch_pause',
        description:
          'Pause the shared video when the user asks or before a longer response would compete with playback. This changes visible playback. It fails explicitly when the embedded player does not expose controls.',
        inputSchema: noInputSchema,
        execute: async () => {
          const controller = controllerRef.current;
          if (!controller) {
            return webMcpError(
              'PLAYER_NOT_CONTROLLABLE',
              'This player does not expose playback controls to the page.',
              playbackRef.current,
            );
          }
          const paused = await controller.pause();
          await wait(120);
          return paused
            ? { ok: true, playback: publicPlaybackState(playbackRef.current) }
            : webMcpError(
                'PAUSE_REJECTED',
                'The player rejected the pause request.',
                playbackRef.current,
              );
        },
      },
      {
        name: 'watch_react',
        description:
          'Publish between one and five lightweight visual reactions together at the current playback moment. Use a small burst only when it genuinely fits or the user requests it; do not react to every observation. The user’s requested viewing style has priority. This visibly changes the page.',
        inputSchema: {
          type: 'object',
          properties: {
            emojis: {
              type: 'array',
              items: {
                type: 'string',
                enum: REACTION_EMOJIS,
              },
              minItems: 1,
              maxItems: MAX_AGENT_REACTIONS,
              description: 'One to five reactions to show together over the video.',
            },
          },
          required: ['emojis'],
          additionalProperties: false,
        },
        execute: async (input) => {
          if (!playbackRef.current.sourceUrl) {
            return webMcpError('NO_VIDEO', 'No video is open.', playbackRef.current);
          }

          const emojis =
            typeof input === 'object' && input !== null && 'emojis' in input
              ? (input as { emojis?: unknown }).emojis
              : undefined;

          if (
            !Array.isArray(emojis) ||
            emojis.length < 1 ||
            emojis.length > MAX_AGENT_REACTIONS ||
            !emojis.every((emoji) => REACTION_EMOJIS.includes(emoji as ReactionEmoji))
          ) {
            return webMcpError(
              'INVALID_REACTION',
              `Choose between one and ${MAX_AGENT_REACTIONS} reactions declared by this tool.`,
              playbackRef.current,
            );
          }

          const reactionEvents = publishVisualReactions(emojis as ReactionEmoji[], 'agent');
          return {
            ok: true,
            reactions: reactionEvents.map((reaction) => ({
              emoji: reaction.emoji,
              createdAt: reaction.createdAt,
              playbackTime: reaction.playbackTime,
              timecode: reaction.timecode,
              source: reaction.source,
            })),
            playback: publicPlaybackState(playbackRef.current),
          };
        },
      },
    ];

    document.documentElement.dataset.siteTools = 'registering';
    void Promise.all(tools.map((tool) => modelContext.registerTool(tool)))
      .then(() => {
        document.documentElement.dataset.siteTools = 'ready';
      })
      .catch(() => {
        document.documentElement.dataset.siteTools = 'error';
      });

    return () => {
      releaseObservation({ reason: 'cancelled' });
      if (modelContext.unregisterTool) {
        for (const tool of tools) {
          void modelContext.unregisterTool(tool.name);
        }
      }
      delete document.documentElement.dataset.siteTools;
    };
  }, [publishVisualReactions, releaseObservation, waitForObservationWake]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const parsedSource = parseVideoSource(videoUrl);
      const sessionId = `media-${Date.now()}-${mediaSessionSequenceRef.current++}`;
      const nextMetadata = initialMediaMetadata(parsedSource, sessionId);
      const nextPlayback: PlaybackSnapshot = {
        sourceUrl: parsedSource.url,
        sourceKind: parsedSource.kind,
        status: parsedSource.kind === 'embed' ? 'unavailable' : 'loading',
        currentTime: null,
        duration: null,
        controllable: false,
      };
      playbackRef.current = nextPlayback;
      playbackSampleRef.current = null;
      playbackDiscontinuitySequenceRef.current = 0;
      observationCursorRef.current = null;
      setSource(parsedSource);
      setMediaMetadata(nextMetadata);
      mediaMetadataRef.current = nextMetadata;
      setError('');
      setReactions([]);
      setReactionMenuOpen(false);
      pendingSignalsRef.current = [];
      setPlaybackStatus(nextPlayback.status);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : 'Unable to open this link.');
    }
  }

  function reset() {
    controllerRef.current = null;
    pendingSignalsRef.current = [];
    releaseObservation({ reason: 'cancelled' });
    setSource(null);
    setMediaMetadata(null);
    mediaMetadataRef.current = null;
    playbackRef.current = EMPTY_PLAYBACK;
    playbackSampleRef.current = null;
    playbackDiscontinuitySequenceRef.current = 0;
    observationCursorRef.current = null;
    setPlaybackStatus('idle');
    setReactions([]);
    setReactionMenuOpen(false);
    setError('');
  }

  if (!source) {
    return (
      <main className="start-screen">
        <section className="start-content" aria-labelledby="page-title">
          <p className="eyebrow">Watch with GPT</p>
          <h1 id="page-title">Watch something together.</h1>
          <form className="link-form" onSubmit={submit}>
            <label className="sr-only" htmlFor="video-url">
              Video link
            </label>
            <input
              id="video-url"
              type="url"
              value={videoUrl}
              onChange={(event) => setVideoUrl(event.target.value)}
              placeholder="Paste a video link"
              autoComplete="url"
              autoFocus
              aria-describedby={error ? 'video-error' : 'video-support'}
              aria-invalid={Boolean(error)}
              required
            />
            <button type="submit" aria-label="Open video" disabled={!videoUrl.trim()}>
              <span aria-hidden="true">→</span>
            </button>
          </form>
          {error ? (
            <p className="input-message input-error" id="video-error" role="alert">
              {error}
            </p>
          ) : (
            <p className="input-message" id="video-support">
              YouTube, a direct video file, or an embeddable player.
            </p>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="watch-screen">
      <header className="watch-header">
        <button type="button" className="wordmark" onClick={reset}>
          Watch with GPT
        </button>
        <button type="button" className="change-video" onClick={reset}>
          Change video
        </button>
      </header>

      <section className="watch-stage" aria-label="Shared video">
        <div className="player-frame">
          <PlayerSurface
            source={source}
            controllerRef={controllerRef}
            onPlayback={updatePlayback}
          />
          <div className="reaction-layer" aria-live="polite" aria-atomic="false">
            {reactions.map((reaction) => (
              <span
                key={reaction.id}
                className="floating-reaction"
                data-source={reaction.source}
                style={{ left: `${reaction.left}%` }}
              >
                {reaction.emoji}
              </span>
            ))}
          </div>
        </div>

        <div className="watch-controls">
          <div className="reaction-picker-shell" ref={reactionMenuRef}>
            <div className="reaction-picker" aria-label="React to this moment">
              {PRIMARY_REACTION_EMOJIS.map((emoji) => (
                <button
                  type="button"
                  key={emoji}
                  className="reaction-button"
                  aria-label={`React with ${emoji}`}
                  disabled={viewerReactionCoolingDown}
                  onClick={() => publishUserReaction(emoji)}
                >
                  {emoji}
                </button>
              ))}
              <button
                type="button"
                className="reaction-button more-reactions-button"
                aria-label={reactionMenuOpen ? 'Close more reactions' : 'Show more reactions'}
                aria-expanded={reactionMenuOpen}
                aria-controls="more-reactions"
                onClick={() => setReactionMenuOpen((open) => !open)}
              >
                <span aria-hidden="true">…</span>
              </button>
            </div>

            {reactionMenuOpen ? (
              <div
                className="reaction-popover"
                id="more-reactions"
                role="dialog"
                aria-label="More reactions"
              >
                <div className="reaction-popover-header">
                  <span>Reactions</span>
                  <button
                    type="button"
                    className="reaction-popover-close"
                    aria-label="Close reactions"
                    onClick={() => setReactionMenuOpen(false)}
                  >
                    ×
                  </button>
                </div>
                <div className="reaction-grid">
                  {REACTION_EMOJIS.map((emoji) => (
                    <button
                      type="button"
                      key={emoji}
                      className="reaction-button"
                      aria-label={`React with ${emoji}`}
                      disabled={viewerReactionCoolingDown}
                      onClick={() => publishUserReaction(emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <span className="sr-only" aria-live="polite">
              {viewerReactionCoolingDown ? 'You can react again in three seconds.' : ''}
            </span>
          </div>

          <div className="observation-picker" aria-label="GPT observation interval">
            <span>Check every</span>
            {OBSERVATION_INTERVALS_SECONDS.map((seconds) => (
              <button
                type="button"
                key={seconds}
                className="interval-button"
                data-active={seconds === observationIntervalSeconds}
                aria-pressed={seconds === observationIntervalSeconds}
                onClick={() => setObservationIntervalSeconds(seconds)}
              >
                {seconds}s
              </button>
            ))}
          </div>
        </div>

        {source.kind === 'embed' ? (
          <p className="player-note">
            This player is shown as provided. Shared timing and playback controls may be unavailable.
          </p>
        ) : (
          <p className="player-note" data-playback-status={playbackStatus}>
            {playbackStatus === 'playing' ? 'Playing together' : 'Ready when you are'}
          </p>
        )}
      </section>
    </main>
  );
}
