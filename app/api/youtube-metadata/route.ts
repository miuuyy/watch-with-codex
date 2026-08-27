import { NextRequest, NextResponse } from 'next/server';

const YOUTUBE_VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;

export async function GET(request: NextRequest) {
  const videoId = request.nextUrl.searchParams.get('videoId');
  if (!videoId || !YOUTUBE_VIDEO_ID.test(videoId)) {
    return NextResponse.json({ error: 'Invalid YouTube video ID.' }, { status: 400 });
  }

  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const endpoint = new URL('https://www.youtube.com/oembed');
  endpoint.searchParams.set('url', watchUrl);
  endpoint.searchParams.set('format', 'json');

  const response = await fetch(endpoint, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    return NextResponse.json({ error: 'YouTube metadata is unavailable.' }, { status: 502 });
  }

  const payload = (await response.json()) as {
    title?: unknown;
    author_name?: unknown;
  };
  const title = typeof payload.title === 'string' ? payload.title : null;
  const authorName =
    typeof payload.author_name === 'string' ? payload.author_name : null;

  if (!title) {
    return NextResponse.json({ error: 'YouTube metadata is incomplete.' }, { status: 502 });
  }

  return NextResponse.json(
    { title, authorName },
    { headers: { 'Cache-Control': 'public, max-age=3600' } },
  );
}
