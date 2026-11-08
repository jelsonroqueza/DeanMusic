import { useEffect, useMemo, useRef, useState, type FormEvent, type CSSProperties } from 'react';

type Track = {
  id: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  duration: number;
  plays: number;
};
type Playlist = { id: string; name: string; description: string | null; is_public: number };
type User = { id: string; name: string; email: string };
type Page = 'home' | 'search' | 'library' | 'profile';

const demoTrack: Track = {
  id: 'demo-midnight',
  title: 'Midnight Reverie',
  artist: 'DeanMusic Originals',
  album: 'Signal One',
  genre: 'Electronic',
  duration: 24,
  plays: 1280,
};

const collections = [
  { title: 'OPM Hits', search: 'OPM', image: 'https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&w=600&q=85', className: 'opm' },
  { title: 'Party Vibes', search: 'Dance', image: 'https://images.unsplash.com/photo-1506157786151-b8491531f063?auto=format&fit=crop&w=600&q=85', className: 'party' },
  { title: 'Acoustic Chill', search: 'Acoustic', image: 'https://images.unsplash.com/photo-1510915361894-db8b60106cb1?auto=format&fit=crop&w=600&q=85', className: 'acoustic' },
  { title: 'Pop Essentials', search: 'Pop', image: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=600&q=85', className: 'pop' },
  { title: 'Chill & Relax', search: 'Chill', image: 'https://images.unsplash.com/photo-1448375240586-882707db888b?auto=format&fit=crop&w=600&q=85', className: 'chill' },
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      typeof payload === 'object' && payload !== null && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : typeof payload === 'object' && payload !== null && 'error' in payload
          ? String((payload as { error: unknown }).error)
          : 'Request failed (' + response.status + ').';
    throw new Error(detail);
  }
  return payload as T;
}

function asTrack(row: Record<string, unknown>): Track {
  return {
    id: String(row.id),
    title: String(row.title ?? 'Untitled track'),
    artist: String(row.artist_name ?? row.artist ?? 'Unknown artist'),
    album: String(row.album_title ?? row.album ?? 'Single'),
    genre: String(row.genre ?? 'Other'),
    duration: Number(row.duration_seconds ?? row.duration ?? 24),
    plays: Number(row.plays_count ?? row.plays ?? 0),
  };
}

function formatTime(value: number): string {
  const safe = Math.max(0, Math.floor(value));
  return Math.floor(safe / 60) + ':' + String(safe % 60).padStart(2, '0');
}

type IconName =
  | 'home' | 'search' | 'library' | 'heart' | 'download' | 'playlist' | 'plus'
  | 'bell' | 'user' | 'chevron' | 'play' | 'pause' | 'shuffle' | 'previous'
  | 'next' | 'repeat' | 'volume' | 'queue' | 'menu' | 'close' | 'more'
  | 'logout' | 'music' | 'check' | 'clock';

function Icon({ name, size = 21, className = '' }: { name: IconName; size?: number; className?: string }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true as const,
  };
  switch (name) {
    case 'home': return <svg {...common}><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" /></svg>;
    case 'search': return <svg {...common}><circle cx="10.8" cy="10.8" r="7.3" /><path d="m16.2 16.2 4.3 4.3" /></svg>;
    case 'library': return <svg {...common}><path d="m12 3 9 4.5-9 4.5-9-4.5z" /><path d="m3 12 9 4.5 9-4.5M3 16.5 12 21l9-4.5" /></svg>;
    case 'heart': return <svg {...common}><path d="M20.8 8.8c0 5.1-8.8 11-8.8 11s-8.8-5.9-8.8-11a4.7 4.7 0 0 1 8.8-2.2 4.7 4.7 0 0 1 8.8 2.2Z" /></svg>;
    case 'download': return <svg {...common}><path d="M12 3v12m-5-5 5 5 5-5M4 20h16" /></svg>;
    case 'playlist': return <svg {...common}><path d="M4 6h12M4 11h12M4 16h7" /><path d="M17 14v6l4-2v-6" /></svg>;
    case 'plus': return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
    case 'bell': return <svg {...common}><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>;
    case 'user': return <svg {...common}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
    case 'chevron': return <svg {...common}><path d="m6 9 6 6 6-6" /></svg>;
    case 'play': return <svg {...common}><path d="m8 5 12 7-12 7z" fill="currentColor" stroke="none" /></svg>;
    case 'pause': return <svg {...common}><path d="M8 5v14M16 5v14" strokeWidth="3" /></svg>;
    case 'shuffle': return <svg {...common}><path d="m16 3 4 4-4 4M4 7h2.5a5 5 0 0 1 4 2l3 4a5 5 0 0 0 4 2H20M16 17l4 4-4 0M4 17h2.5a5 5 0 0 0 3.7-1.7" /></svg>;
    case 'previous': return <svg {...common}><path d="M6 5v14M19 6l-9 6 9 6z" fill="currentColor" stroke="none" /></svg>;
    case 'next': return <svg {...common}><path d="M18 5v14M5 6l9 6-9 6z" fill="currentColor" stroke="none" /></svg>;
    case 'repeat': return <svg {...common}><path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" /></svg>;
    case 'volume': return <svg {...common}><path d="M4 10v4h4l5 4V6l-5 4zM17 9a5 5 0 0 1 0 6M19 5a9 9 0 0 1 0 14" /></svg>;
    case 'queue': return <svg {...common}><path d="M4 6h16M4 11h16M4 16h10M18 15v6m-3-3h6" /></svg>;
    case 'menu': return <svg {...common}><path d="M3 6h18M3 12h18M3 18h18" /></svg>;
    case 'close': return <svg {...common}><path d="m6 6 12 12M18 6 6 18" /></svg>;
    case 'more': return <svg {...common}><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></svg>;
    case 'logout': return <svg {...common}><path d="M10 17l5-5-5-5M15 12H3M12 3h6a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-6" /></svg>;
    case 'music': return <svg {...common}><path d="M9 18V5l12-2v13M9 18a3 2 0 1 1-6 0 3 2 0 0 1 6 0Zm12-2a3 2 0 1 1-6 0 3 2 0 0 1 6 0Z" /></svg>;
    case 'check': return <svg {...common}><path d="m5 12 4 4L19 6" /></svg>;
    case 'clock': return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
    default: return null;
  }
}

function BrandLogo({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? 'brand brand-compact' : 'brand'}>
      <svg className="brand-mark" viewBox="0 0 74 52" role="img" aria-label="DeanMusic logo">
        <rect x="2" y="28" width="6" height="17" rx="3" fill="#00E51A" />
        <rect x="11" y="17" width="6" height="28" rx="3" fill="#00E51A" />
        <rect x="20" y="8" width="6" height="37" rx="3" fill="#00E51A" />
        <path d="M31 4h16c15 0 24 9 24 22s-9 22-24 22H31z" fill="#fff" />
        <path d="M39 12h7c10 0 16 5 16 14s-6 14-16 14h-7z" fill="#080808" />
        <path d="m43 17 17 9-17 10z" fill="#FF1424" />
      </svg>
      <span className="brand-word"><span>Dean</span><b>Music</b></span>
    </span>
  );
}

function mapCollectionSearch(term: string, setQuery: (value: string) => void, setFilter: (value: string) => void, setPage: (value: Page) => void) {
  setFilter('All');
  setQuery(term);
  setPage('search');
}

export default function App() {
  const [page, setPage] = useState<Page>('home');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All');
  const [tracks, setTracks] = useState<Track[]>([demoTrack]);
  const [liked, setLiked] = useState<string[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [busy, setBusy] = useState(false);
  const [playlistOpen, setPlaylistOpen] = useState(false);
  const [playlistName, setPlaylistName] = useState('');
  const [active, setActive] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [volume, setVolume] = useState(0.55);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [toast, setToast] = useState('');
  const [recentTracks, setRecentTracks] = useState<Track[]>([]);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [selectedPlaylist, setSelectedPlaylist] = useState<{ playlist: Playlist; tracks: Track[] } | null>(null);

  const audioContext = useRef<AudioContext | null>(null);
  const soundNodes = useRef<OscillatorNode[]>([]);
  const gainNode = useRef<GainNode | null>(null);
  const ticker = useRef<number | null>(null);
  const toastTimer = useRef<number | null>(null);

  const notify = (message: string) => {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2600);
  };

  const stopSound = () => {
    if (ticker.current !== null) window.clearInterval(ticker.current);
    ticker.current = null;
    soundNodes.current.forEach((node) => {
      try { node.stop(); } catch { /* already stopped */ }
    });
    soundNodes.current = [];
    gainNode.current?.disconnect();
    gainNode.current = null;
    setPlaying(false);
  };

  const startSound = async (from = seconds, duration = active?.duration ?? 24) => {
    stopSound();
    const Context = window.AudioContext;
    const context = audioContext.current ?? new Context();
    audioContext.current = context;
    await context.resume();
    const master = context.createGain();
    master.gain.value = volume * 0.12;
    master.connect(context.destination);
    gainNode.current = master;
    const notes = [110, 164.81, 220, 329.63];
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      oscillator.type = index === 3 ? 'triangle' : 'sine';
      oscillator.frequency.value = frequency;
      envelope.gain.value = index === 3 ? 0.14 : 0.26;
      oscillator.connect(envelope);
      envelope.connect(master);
      oscillator.start();
      soundNodes.current.push(oscillator);
    });
    setSeconds(from);
    setPlaying(true);
    ticker.current = window.setInterval(() => {
      setSeconds((current) => {
        const next = current + 0.2;
        if (next >= duration) {
          if (repeat) return 0;
          stopSound();
          return 0;
        }
        return next;
      });
    }, 200);
  };

  useEffect(() => () => {
    if (ticker.current !== null) window.clearInterval(ticker.current);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    soundNodes.current.forEach((node) => {
      try { node.stop(); } catch { /* already stopped */ }
    });
    void audioContext.current?.close();
  }, []);

  useEffect(() => {
    if (gainNode.current) gainNode.current.gain.value = volume * 0.12;
  }, [volume]);

  const loadLibrary = async (current: User) => {
    try {
      const [likes, lists] = await Promise.all([
        api<{ tracks: Array<{ id: string }> }>('/api/liked-tracks'),
        api<{ playlists: Playlist[] }>('/api/playlists'),
      ]);
      setLiked(likes.tracks.map((item) => item.id));
      setPlaylists(lists.playlists);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not load your library.');
    }
    setUser(current);
  };

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const result = await api<{ tracks: Array<Record<string, unknown>> }>('/api/catalog');
        if (alive && result.tracks.length) setTracks(result.tracks.map(asTrack));
      } catch {
        /* Keep the local fallback track when the catalog is unavailable. */
      }
      try {
        const result = await api<{ user: User | null }>('/api/me');
        if (alive && result.user) await loadLibrary(result.user);
      } catch {
        /* Public browsing remains available without signing in. */
      }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem('deanmusic:recent') || '[]') as string[];
      if (Array.isArray(stored) && stored.length) {
        setRecentTracks(stored.map((id) => tracks.find((track) => track.id === id)).filter((track): track is Track => Boolean(track)));
      }
    } catch {
      /* Ignore unavailable or malformed local history. */
    }
  }, [tracks]);

  const genres = useMemo(() => ['All', ...Array.from(new Set(tracks.map((track) => track.genre).filter(Boolean)))], [tracks]);
  const visibleTracks = useMemo(() => tracks.filter((track) => {
    const text = [track.title, track.artist, track.album, track.genre].join(' ').toLowerCase();
    return (!query || text.includes(query.trim().toLowerCase())) &&
      (filter === 'All' || (filter === 'Liked Songs' ? liked.includes(track.id) : track.genre.toLowerCase() === filter.toLowerCase()));
  }), [tracks, query, filter, liked]);

  const openPage = (nextPage: Page) => {
    setPage(nextPage);
    setMobileMenuOpen(false);
    setProfileMenuOpen(false);
  };

  const chooseTrack = (track: Track) => {
    stopSound();
    setActive(track);
    setSeconds(0);
    setRecentTracks((current) => {
      const next = [track, ...current.filter((item) => item.id !== track.id)].slice(0, 6);
      try { window.localStorage.setItem('deanmusic:recent', JSON.stringify(next.map((item) => item.id))); } catch { /* Storage is optional. */ }
      return next;
    });
    void api('/api/plays/' + encodeURIComponent(track.id), { method: 'POST', body: '{}' }).catch(() => undefined);
    void startSound(0, track.duration).catch(() => notify('Tap play again to enable audio.'));
  };

  const toggleLike = async (id: string) => {
    if (!user) {
      setAuthMode('signin');
      setAuthOpen(true);
      notify('Sign in to save songs.');
      return;
    }
    const wasLiked = liked.includes(id);
    setLiked((current) => wasLiked ? current.filter((item) => item !== id) : [...current, id]);
    try {
      await api('/api/likes/' + encodeURIComponent(id), { method: wasLiked ? 'DELETE' : 'POST', body: '{}' });
    } catch (error) {
      setLiked((current) => wasLiked ? [...current, id] : current.filter((item) => item !== id));
      notify(error instanceof Error ? error.message : 'Could not update likes.');
    }
  };

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setAuthError('');
    try {
      const endpoint = authMode === 'signup' ? '/api/auth/sign-up/email' : '/api/auth/sign-in/email';
      const payload = authMode === 'signup'
        ? { name: name.trim(), email: email.trim().toLowerCase(), password }
        : { email: email.trim().toLowerCase(), password };
      const result = await api<{ user: User }>(endpoint, { method: 'POST', body: JSON.stringify(payload) });
      await loadLibrary(result.user);
      setAuthOpen(false);
      setPassword('');
      notify('Welcome to DeanMusic, ' + result.user.name + '!');
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Could not complete sign in.');
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    try {
      await api('/api/auth/sign-out', { method: 'POST', body: '{}' });
      stopSound();
      setUser(null);
      setLiked([]);
      setPlaylists([]);
      setSelectedPlaylist(null);
      setProfileMenuOpen(false);
      notify('Signed out.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not sign out.');
    }
  };

  const createPlaylist = async () => {
    if (!user) {
      setPlaylistOpen(false);
      setAuthMode('signin');
      setAuthOpen(true);
      return;
    }
    const clean = playlistName.trim();
    if (!clean) return;
    try {
      const result = await api<{ playlist: Playlist }>('/api/playlists', {
        method: 'POST',
        body: JSON.stringify({ name: clean, isPublic: false }),
      });
      setPlaylists((current) => [result.playlist, ...current]);
      setPlaylistName('');
      setPlaylistOpen(false);
      notify('Playlist created.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not create playlist.');
    }
  };

  const openPlaylist = async (playlist: Playlist) => {
    try {
      const result = await api<{ playlist: Playlist; tracks: Array<Record<string, unknown>> }>('/api/playlists/' + encodeURIComponent(playlist.id));
      setSelectedPlaylist({ playlist: result.playlist, tracks: result.tracks.map(asTrack) });
      setFilter('All');
      openPage('library');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not open playlist.');
    }
  };

  const togglePlay = () => {
    if (!active) {
      if (tracks[0]) chooseTrack(tracks[0]);
      return;
    }
    if (playing) stopSound();
    else void startSound(seconds, active.duration).catch(() => notify('Audio playback is unavailable in this browser.'));
  };

  const playAdjacent = (direction: -1 | 1) => {
    if (!tracks.length) return;
    const currentIndex = active ? tracks.findIndex((track) => track.id === active.id) : -1;
    let nextIndex: number;
    if (shuffle && tracks.length > 1) {
      do {
        nextIndex = Math.floor(Math.random() * tracks.length);
      } while (nextIndex === currentIndex);
    } else if (direction > 0) {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % tracks.length;
    } else {
      nextIndex = currentIndex <= 0 ? tracks.length - 1 : currentIndex - 1;
    }
    chooseTrack(tracks[nextIndex]);
  };

  const seek = (value: number) => {
    const next = Math.max(0, Math.min(active?.duration ?? 24, value));
    setSeconds(next);
    if (playing) void startSound(next, active?.duration ?? 24);
  };

  const handleProfileAction = () => {
    setProfileMenuOpen(false);
    if (user) {
      openPage('profile');
    } else {
      setAuthMode('signin');
      setAuthOpen(true);
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="mobile-menu-button icon-button" aria-label="Open navigation" onClick={() => setMobileMenuOpen(true)}>
          <Icon name="menu" size={25} />
        </button>
        <button className="brand-button" onClick={() => openPage('home')} aria-label="DeanMusic home">
          <BrandLogo />
        </button>
        <form className="top-search" onSubmit={(event) => { event.preventDefault(); openPage('search'); }}>
          <Icon name="search" size={22} />
          <input
            value={query}
            onChange={(event) => { setQuery(event.target.value); if (event.target.value) setPage('search'); }}
            placeholder="Search for songs, artists, or albums..."
            aria-label="Search for songs, artists, or albums"
          />
        </form>
        <div className="top-actions">
          <button className="icon-button notification-button" aria-label="Notifications" onClick={() => notify('Notifications are not connected yet.')}>
            <Icon name="bell" size={24} /><span className="notification-dot" />
          </button>
          <div className="profile-wrap">
            <button className="profile-button" aria-label="Open profile menu" aria-expanded={profileMenuOpen} onClick={() => setProfileMenuOpen((value) => !value)}>
              {user ? <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span> : <Icon name="user" size={23} />}
            </button>
            <button className="profile-chevron" aria-label="Toggle profile menu" onClick={() => setProfileMenuOpen((value) => !value)}><Icon name="chevron" size={18} /></button>
            {profileMenuOpen && (
              <div className="profile-menu">
                {user ? <>
                  <strong>{user.name}</strong><small>{user.email}</small>
                  <button onClick={() => openPage('profile')}><Icon name="user" size={17} /> My profile</button>
                  <button onClick={() => void signOut()}><Icon name="logout" size={17} /> Sign out</button>
                </> : <>
                  <strong>Welcome to DeanMusic</strong>
                  <button onClick={handleProfileAction}><Icon name="user" size={17} /> Sign in</button>
                  <button onClick={() => { setProfileMenuOpen(false); setAuthMode('signup'); setAuthOpen(true); }}><Icon name="plus" size={17} /> Create account</button>
                </>}
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="main-layout">
        <aside className="sidebar">
          <SidebarContent
            page={page}
            playlists={playlists}
            onNavigate={openPage}
            onLiked={() => { setFilter('Liked Songs'); setSelectedPlaylist(null); openPage('library'); }}
            onCreate={() => setPlaylistOpen(true)}
            onPlaylist={openPlaylist}
            onDownloads={() => notify('Downloads are not available yet.')}
          />
        </aside>

        <main className="main-panel">
          <div className="content">
            {page === 'home' && <>
              <section className="hero">
                <div className="hero-copy">
                  <p className="hero-kicker">YOUR SOUND. YOUR SPACE.</p>
                  <h1>Welcome to<br /><strong>Dean<span>Music</span></strong></h1>
                  <p className="hero-subtitle">Your Personal Music Streaming Experience</p>
                  <button className="primary-button listen-button" onClick={() => tracks[0] && chooseTrack(tracks[0])}>
                    <Icon name="play" size={17} /> Listen Now
                  </button>
                </div>
                <div className="headphones-art" aria-hidden="true">
                  <div className="headphone-band" />
                  <div className="headphone-cup headphone-cup-left"><span /></div>
                  <div className="headphone-cup headphone-cup-right"><span /></div>
                  <div className="headphone-wire" />
                </div>
                <div className="hero-dots"><span className="active" /><span /><span /></div>
              </section>

              <section className="section">
                <div className="section-heading">
                  <h2>Trending Now</h2>
                  <button className="see-all" onClick={() => { setQuery(''); setFilter('All'); openPage('search'); }}>See All <span>›</span></button>
                </div>
                <div className="collection-grid">
                  {collections.map((item) => (
                    <button
                      type="button"
                      className="collection-card"
                      key={item.title}
                      onClick={() => mapCollectionSearch(item.search, setQuery, setFilter, openPage)}
                    >
                      <span className={'collection-art ' + item.className} style={{ backgroundImage: 'linear-gradient(180deg, transparent 45%, rgba(0,0,0,.38)), url("' + item.image + '")' } as CSSProperties}>
                        <span className="collection-play"><Icon name="play" size={16} /></span>
                      </span>
                      <strong>{item.title}</strong>
                    </button>
                  ))}
                </div>
              </section>

              <section className="section recently-section">
                <div className="section-heading">
                  <h2>Recently Played</h2>
                  <button className="see-all" onClick={() => { setQuery(''); setFilter('All'); openPage('search'); }}>See All <span>›</span></button>
                </div>
                {recentTracks.length ? (
                  <div className="recent-grid">
                    {recentTracks.slice(0, 5).map((track, index) => (
                      <button className="recent-card" key={track.id} onClick={() => chooseTrack(track)}>
                        <span className={'recent-cover recent-cover-' + (index % 5)}><Icon name="music" size={25} /></span>
                        <strong>{track.title}</strong>
                        <small>{track.artist}</small>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="recent-empty"><Icon name="clock" size={19} /><span>Your recently played songs will appear here.</span></div>
                )}
              </section>
            </>}

            {page === 'search' && (
              <section className="page-section">
                <div className="page-title-row"><div><p className="section-eyebrow">FIND YOUR NEXT FAVORITE</p><h1>Browse music</h1></div><span className="result-count">{visibleTracks.length} tracks</span></div>
                <div className="browse-search"><Icon name="search" size={22} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search songs, artists, albums, or genres..." /></div>
                <div className="filter-list">
                  {genres.map((item) => <button className={filter === item ? 'filter-chip active' : 'filter-chip'} key={item} onClick={() => setFilter(item)}>{item}</button>)}
                  {user && <button className={filter === 'Liked Songs' ? 'filter-chip active' : 'filter-chip'} onClick={() => setFilter('Liked Songs')}>Liked Songs</button>}
                </div>
                <div className="section-heading browse-heading"><h2>{query ? 'Search results' : 'All available tracks'}</h2></div>
                {visibleTracks.length ? <TrackList tracks={visibleTracks} liked={liked} active={active} playing={playing} onChoose={chooseTrack} onLike={toggleLike} /> : (
                  <div className="empty-state"><Icon name="search" size={32} /><strong>No results found</strong><p>Try a different song, artist, album, or genre.</p></div>
                )}
              </section>
            )}

            {page === 'library' && (
              <section className="page-section">
                <div className="page-title-row"><div><p className="section-eyebrow">YOUR PERSONAL COLLECTION</p><h1>My Library</h1></div></div>
                {selectedPlaylist ? (
                  <>
                    <div className="playlist-detail-heading">
                      <button className="back-link" onClick={() => setSelectedPlaylist(null)}>‹ My Playlists</button>
                      <h2>{selectedPlaylist.playlist.name}</h2>
                      <span>{selectedPlaylist.tracks.length} songs · {selectedPlaylist.playlist.is_public ? 'Public' : 'Private'}</span>
                    </div>
                    {selectedPlaylist.tracks.length ? <TrackList tracks={selectedPlaylist.tracks} liked={liked} active={active} playing={playing} onChoose={chooseTrack} onLike={toggleLike} /> : <div className="empty-state"><Icon name="playlist" size={32} /><strong>This playlist is empty</strong><p>Add songs to this playlist as you discover music.</p></div>}
                  </>
                ) : (
                  <>
                    <div className="library-actions">
                      <button className="library-feature" onClick={() => { setFilter('Liked Songs'); }}>
                        <span className="liked-tile"><Icon name="heart" size={28} /></span>
                        <span><strong>Liked Songs</strong><small>{liked.length} saved tracks</small></span>
                      </button>
                      <button className="outline-button" onClick={() => setPlaylistOpen(true)}><Icon name="plus" size={18} /> Create Playlist</button>
                    </div>
                    {filter === 'Liked Songs' ? (
                      <>
                        <div className="section-heading browse-heading"><h2>Liked Songs</h2><button className="text-action" onClick={() => setFilter('All')}>Back to library</button></div>
                        {tracks.filter((track) => liked.includes(track.id)).length
                          ? <TrackList tracks={tracks.filter((track) => liked.includes(track.id))} liked={liked} active={active} playing={playing} onChoose={chooseTrack} onLike={toggleLike} />
                          : <div className="empty-state"><Icon name="heart" size={32} /><strong>No liked songs yet</strong><p>Tap the heart beside a song to save it here.</p></div>}
                      </>
                    ) : (
                      <>
                        <div className="section-heading browse-heading"><h2>My Playlists</h2></div>
                        {playlists.length ? (
                          <div className="user-playlist-grid">
                            {playlists.map((item, index) => (
                              <button className="user-playlist-card" key={item.id} onClick={() => void openPlaylist(item)}>
                                <span className={'playlist-square playlist-square-' + (index % 4)}><Icon name="music" size={26} /></span>
                                <strong>{item.name}</strong>
                                <small>{item.is_public ? 'Public playlist' : 'Private playlist'}</small>
                              </button>
                            ))}
                          </div>
                        ) : <div className="empty-state"><Icon name="playlist" size={32} /><strong>No playlists yet</strong><p>Create a playlist to start building your own music collection.</p><button className="primary-button" onClick={() => setPlaylistOpen(true)}><Icon name="plus" size={17} /> Create Playlist</button></div>}
                      </>
                    )}
                    {!user && <p className="library-hint">Sign in to sync your liked songs and playlists across devices.</p>}
                  </>
                )}
              </section>
            )}

            {page === 'profile' && (
              <section className="page-section profile-page">
                <p className="section-eyebrow">YOUR DEANMUSIC ACCOUNT</p>
                <h1>Profile</h1>
                {user ? (
                  <div className="profile-card">
                    <div className="profile-avatar-large">{user.name.slice(0, 1).toUpperCase()}</div>
                    <div><h2>{user.name}</h2><p>{user.email}</p><span>DeanMusic member</span></div>
                    <button className="outline-button" onClick={() => void signOut()}><Icon name="logout" size={17} /> Sign Out</button>
                  </div>
                ) : (
                  <div className="empty-state"><Icon name="user" size={34} /><strong>Sign in to your account</strong><p>Your saved music and playlists will be available here.</p><button className="primary-button" onClick={() => { setAuthMode('signin'); setAuthOpen(true); }}>Sign In</button></div>
                )}
              </section>
            )}
          </div>
        </main>
      </div>

      {mobileMenuOpen && (
        <div className="mobile-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setMobileMenuOpen(false); }}>
          <aside className="mobile-drawer">
            <div className="drawer-header"><BrandLogo compact /><button className="icon-button" onClick={() => setMobileMenuOpen(false)} aria-label="Close navigation"><Icon name="close" /></button></div>
            <SidebarContent
              page={page}
              playlists={playlists}
              onNavigate={openPage}
              onLiked={() => { setFilter('Liked Songs'); setSelectedPlaylist(null); openPage('library'); }}
              onCreate={() => { setMobileMenuOpen(false); setPlaylistOpen(true); }}
              onPlaylist={(item) => { setMobileMenuOpen(false); void openPlaylist(item); }}
              onDownloads={() => { setMobileMenuOpen(false); notify('Downloads are not available yet.'); }}
            />
          </aside>
        </div>
      )}

      <footer className="player">
        <div className="now-playing">
          <div className="player-cover"><Icon name="music" size={22} /></div>
          <div className="now-playing-copy"><strong>{active?.title ?? 'Choose a track'}</strong><small>{active?.artist ?? 'DeanMusic Originals'}</small></div>
          <button className={active && liked.includes(active.id) ? 'heart-button liked' : 'heart-button'} aria-label="Like current track" onClick={() => active && void toggleLike(active.id)}><Icon name="heart" size={22} /></button>
        </div>
        <div className="player-center">
          <div className="player-controls">
            <button className={shuffle ? 'control-button toggled' : 'control-button'} aria-label="Shuffle" onClick={() => setShuffle((value) => !value)}><Icon name="shuffle" size={19} /></button>
            <button className="control-button" aria-label="Previous track" onClick={() => playAdjacent(-1)}><Icon name="previous" size={19} /></button>
            <button className="main-play-button" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}><Icon name={playing ? 'pause' : 'play'} size={20} /></button>
            <button className="control-button" aria-label="Next track" onClick={() => playAdjacent(1)}><Icon name="next" size={19} /></button>
            <button className={repeat ? 'control-button toggled' : 'control-button'} aria-label="Repeat" onClick={() => setRepeat((value) => !value)}><Icon name="repeat" size={19} /></button>
          </div>
          <div className="progress-row">
            <span>{formatTime(seconds)}</span>
            <input aria-label="Playback progress" type="range" min="0" max={active?.duration ?? 24} value={Math.min(seconds, active?.duration ?? 24)} onChange={(event) => seek(Number(event.target.value))} />
            <span>{formatTime(active?.duration ?? 24)}</span>
          </div>
        </div>
        <div className="volume-control">
          <Icon name="volume" size={20} />
          <input aria-label="Volume" type="range" min="0" max="1" step="0.01" value={volume} onChange={(event) => setVolume(Number(event.target.value))} />
          <button className="queue-button" aria-label="Open queue" onClick={() => notify(active ? 'Queue is not available yet.' : 'Choose a track to start listening.')}><Icon name="queue" size={21} /></button>
          <button className="mobile-play-button" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}><Icon name={playing ? 'pause' : 'play'} size={19} /></button>
        </div>
      </footer>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        <button className={page === 'home' ? 'active' : ''} onClick={() => openPage('home')}><Icon name="home" size={22} /><span>Home</span></button>
        <button className={page === 'search' ? 'active' : ''} onClick={() => openPage('search')}><Icon name="search" size={22} /><span>Browse</span></button>
        <button className={page === 'library' ? 'active' : ''} onClick={() => openPage('library')}><Icon name="library" size={22} /><span>Library</span></button>
        <button className={page === 'profile' ? 'active' : ''} onClick={() => openPage('profile')}><Icon name="user" size={22} /><span>Profile</span></button>
      </nav>

      {authOpen && (
        <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setAuthOpen(false); }}>
          <form className="dialog" onSubmit={submitAuth}>
            <button type="button" className="close-dialog" onClick={() => setAuthOpen(false)} aria-label="Close"><Icon name="close" /></button>
            <BrandLogo compact />
            <p className="section-eyebrow">YOUR SOUND. YOUR SPACE.</p>
            <h2>{authMode === 'signup' ? 'Create your account' : 'Welcome back'}</h2>
            <p className="dialog-copy">Save songs and keep your playlists close wherever you listen.</p>
            {authMode === 'signup' && <label>Your name<input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} required autoComplete="name" /></label>}
            <label>Email address<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" /></label>
            <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} maxLength={128} required autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'} /></label>
            {authError && <p className="form-error">{authError}</p>}
            <button type="submit" className="primary-button full" disabled={busy}>{busy ? 'Please wait…' : authMode === 'signup' ? 'Create Free Account' : 'Sign In'}</button>
            <p className="switch-auth">{authMode === 'signup' ? 'Already have an account?' : 'New to DeanMusic?'} <button type="button" onClick={() => { setAuthMode(authMode === 'signup' ? 'signin' : 'signup'); setAuthError(''); }}>{authMode === 'signup' ? 'Sign In' : 'Create Account'}</button></p>
          </form>
        </div>
      )}

      {playlistOpen && (
        <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setPlaylistOpen(false); }}>
          <form className="dialog playlist-dialog" onSubmit={(event) => { event.preventDefault(); void createPlaylist(); }}>
            <button type="button" className="close-dialog" onClick={() => setPlaylistOpen(false)} aria-label="Close"><Icon name="close" /></button>
            <p className="section-eyebrow">YOUR COLLECTION</p>
            <h2>Create Playlist</h2>
            <p className="dialog-copy">Give your next collection a name.</p>
            <label>Playlist name<input value={playlistName} onChange={(event) => setPlaylistName(event.target.value)} minLength={1} maxLength={80} required placeholder="My favorite songs" /></label>
            <button type="submit" className="primary-button full">Create Playlist</button>
          </form>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function SidebarContent({
  page,
  playlists,
  onNavigate,
  onLiked,
  onCreate,
  onPlaylist,
  onDownloads,
}: {
  page: Page;
  playlists: Playlist[];
  onNavigate: (page: Page) => void;
  onLiked: () => void;
  onCreate: () => void;
  onPlaylist: (playlist: Playlist) => void;
  onDownloads: () => void;
}) {
  return (
    <div className="sidebar-inner">
      <p className="nav-caption">DISCOVER</p>
      <button className={page === 'home' ? 'nav-link selected' : 'nav-link'} onClick={() => onNavigate('home')}><Icon name="home" /><span>Home</span></button>
      <button className={page === 'search' ? 'nav-link selected' : 'nav-link'} onClick={() => onNavigate('search')}><Icon name="search" /><span>Browse</span></button>
      <button className={page === 'library' ? 'nav-link selected' : 'nav-link'} onClick={() => onNavigate('library')}><Icon name="library" /><span>Library</span></button>
      <div className="sidebar-divider" />
      <p className="nav-caption">MY MUSIC</p>
      <button className="nav-link" onClick={onLiked}><Icon name="heart" /><span>Liked Songs</span></button>
      <button className="nav-link" onClick={onDownloads}><Icon name="download" /><span>Downloads</span></button>
      <button className="nav-link" onClick={() => onNavigate('library')}><Icon name="playlist" /><span>My Playlists</span></button>
      <div className="sidebar-divider" />
      <button className="create-playlist-button" onClick={onCreate}><Icon name="plus" size={19} /><span>Create Playlist</span></button>
      <div className="side-playlists">
        {playlists.slice(0, 7).map((item) => <button key={item.id} onClick={() => onPlaylist(item)}>{item.name}</button>)}
      </div>
      <div className="sidebar-foot"><span>DEANMUSIC ORIGINALS</span><small>Your personal music space</small></div>
    </div>
  );
}

function TrackList({
  tracks,
  liked,
  active,
  playing,
  onChoose,
  onLike,
}: {
  tracks: Track[];
  liked: string[];
  active: Track | null;
  playing: boolean;
  onChoose: (track: Track) => void;
  onLike: (id: string) => void;
}) {
  return (
    <div className="track-list">
      <div className="track-head"><span>#</span><span>Title</span><span>Album</span><span>Genre</span><span /></div>
      {tracks.map((track, index) => (
        <div className={active?.id === track.id ? 'track-line current' : 'track-line'} key={track.id}>
          <span className="track-index">{active?.id === track.id && playing ? <span className="playing-bars">▮▮▮</span> : String(index + 1).padStart(2, '0')}</span>
          <button className="track-info" onClick={() => onChoose(track)}>
            <span className="track-cover"><Icon name="music" size={20} /></span>
            <span className="track-copy"><b>{track.title}</b><small>{track.artist}</small></span>
          </button>
          <span className="track-album">{track.album}</span>
          <span className="track-genre">{track.genre}</span>
          <button className={liked.includes(track.id) ? 'heart-button liked' : 'heart-button'} onClick={() => void onLike(track.id)} aria-label="Like track"><Icon name="heart" size={19} /></button>
        </div>
      ))}
    </div>
  );
}
