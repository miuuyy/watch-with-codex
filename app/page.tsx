'use client';

import {
  FormEvent,
  MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

const REACTION_EMOJIS = ['😂', '😮', '❤️', '😬', '👀'] as const;
const OBSERVATION_INTERVAL_MS = 5_000;

const WATCH_PROTOCOL = {
  role: 'Share the open video with the user as a natural viewing companion.',
  userIntent:
    'The user decides what kind of company they want. Follow their current request; watching together does not require a fixed amount of commentary or reactions.',
  observation:
    'When the user asks you to actively watch, inspect the visible video and call watch_observe_next_moment repeatedly. Each successful call waits about five seconds. Stop when playback pauses or ends.',
  behavior: [
    'Stay quiet by default.',
    'Do not comment on every observation.',
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

type ReactionEvent = {
  id: string;
  emoji: ReactionEmoji;
  source: 'user' | 'agent';
  playbackTime: number | null;
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

function publicPlaybackState(snapshot: PlaybackSnapshot) {
  return {
    ...snapshot,
    currentTime: snapshot.currentTime === null ? null : finiteTime(snapshot.currentTime),
    duration: snapshot.duration === null ? null : finiteTime(snapshot.duration),
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
  const [playback, setPlayback] = useState<PlaybackSnapshot>(EMPTY_PLAYBACK);
  const playbackRef = useRef(playback);
  const controllerRef = useRef<PlayerController | null>(null);
  const reactionSequenceRef = useRef(0);

  useEffect(() => {
    playbackRef.current = playback;
  }, [playback]);

  const updatePlayback = useCallback((next: Partial<PlaybackSnapshot>) => {
    setPlayback((current) => ({ ...current, ...next }));
  }, []);

  const publishReaction = useCallback((emoji: ReactionEmoji, eventSource: 'user' | 'agent') => {
    const sequence = reactionSequenceRef.current++;
    const event: ReactionEvent = {
      id: `${Date.now()}-${sequence}`,
      emoji,
      source: eventSource,
      playbackTime: playbackRef.current.currentTime,
      left: 28 + ((sequence * 17) % 45),
    };

    setReactions((current) => [...current, event]);
    window.setTimeout(() => {
      setReactions((current) => current.filter((reaction) => reaction.id !== event.id));
    }, 2_200);

    return event;
  }, []);

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
          'Read the current shared-video state and viewing protocol. Call this before starting a watch-along. The user’s current request determines the interaction style; do not assume they want constant commentary.',
        inputSchema: noInputSchema,
        annotations: { readOnlyHint: true },
        execute: async () => ({
          ok: true,
          playback: publicPlaybackState(playbackRef.current),
          protocol: WATCH_PROTOCOL,
        }),
      },
      {
        name: 'watch_observe_next_moment',
        description:
          'Continue an active watch-along by waiting about five seconds, then anchor your visual inspection to the updated playback time. Call repeatedly only while the video is playing and the user wants you to watch. Inspect the visible frame, but stay quiet unless the moment merits a reaction or the user requested commentary. Stop when this tool reports that playback paused or ended.',
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

          const observedSource = initial.sourceUrl;
          await wait(OBSERVATION_INTERVAL_MS);
          const current = playbackRef.current;

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

          return {
            ok: true,
            observation: {
              id: `observation-${Date.now()}`,
              capturedAt: new Date().toISOString(),
              playback: publicPlaybackState(current),
              visualInstruction:
                'Inspect the currently visible video frame before deciding whether to stay quiet, react, or respond to the user.',
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
          'Publish one lightweight visual reaction at the current playback moment. Use only when it genuinely fits or the user requests it; do not react to every observation. The user’s requested viewing style has priority. This visibly changes the page.',
        inputSchema: {
          type: 'object',
          properties: {
            emoji: {
              type: 'string',
              enum: REACTION_EMOJIS,
              description: 'The reaction to show over the video.',
            },
          },
          required: ['emoji'],
          additionalProperties: false,
        },
        execute: async (input) => {
          const emoji =
            typeof input === 'object' && input !== null && 'emoji' in input
              ? (input as { emoji?: unknown }).emoji
              : undefined;

          if (!REACTION_EMOJIS.includes(emoji as ReactionEmoji)) {
            return webMcpError(
              'INVALID_REACTION',
              'Choose one of the five reactions declared by this tool.',
              playbackRef.current,
            );
          }

          const reaction = publishReaction(emoji as ReactionEmoji, 'agent');
          return {
            ok: true,
            reaction: {
              emoji: reaction.emoji,
              playbackTime: finiteTime(reaction.playbackTime ?? Number.NaN),
              source: reaction.source,
            },
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
      if (modelContext.unregisterTool) {
        for (const tool of tools) {
          void modelContext.unregisterTool(tool.name);
        }
      }
      delete document.documentElement.dataset.siteTools;
    };
  }, [publishReaction]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const parsedSource = parseVideoSource(videoUrl);
      setSource(parsedSource);
      setError('');
      setReactions([]);
      setPlayback({
        sourceUrl: parsedSource.url,
        sourceKind: parsedSource.kind,
        status: parsedSource.kind === 'embed' ? 'unavailable' : 'loading',
        currentTime: null,
        duration: null,
        controllable: false,
      });
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : 'Unable to open this link.');
    }
  }

  function reset() {
    controllerRef.current = null;
    setSource(null);
    setPlayback(EMPTY_PLAYBACK);
    setReactions([]);
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

        <div className="reaction-picker" aria-label="React to this moment">
          {REACTION_EMOJIS.map((emoji) => (
            <button
              type="button"
              key={emoji}
              className="reaction-button"
              aria-label={`React with ${emoji}`}
              onClick={() => publishReaction(emoji, 'user')}
            >
              {emoji}
            </button>
          ))}
        </div>

        {source.kind === 'embed' ? (
          <p className="player-note">
            This player is shown as provided. Shared timing and playback controls may be unavailable.
          </p>
        ) : (
          <p className="player-note" data-playback-status={playback.status}>
            {playback.status === 'playing' ? 'Playing together' : 'Ready when you are'}
          </p>
        )}
      </section>
    </main>
  );
}
