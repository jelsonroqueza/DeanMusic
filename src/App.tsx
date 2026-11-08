import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

type Track = { id: string; title: string; artist: string; album: string; genre: string; duration: number; plays: number };
type Playlist = { id: string; name: string; description: string | null; is_public: number };
type User = { id: string; name: string; email: string };
type Page = 'home' | 'search' | 'library';

const demoTrack: Track = { id: 'demo-midnight', title: 'Midnight Reverie', artist: 'DeanMusic Originals', album: 'Signal One', genre: 'Electronic', duration: 24, plays: 1280 };
const categories = [{ name: 'Electronic', icon: '⌁' }, { name: 'Chill', icon: '☼' }, { name: 'Ambient', icon: '☁' }, { name: 'Synthwave', icon: '✧' }];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'include', headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) } });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof payload === 'object' && payload !== null && 'message' in payload ? String((payload as { message: unknown }).message) : typeof payload === 'object' && payload !== null && 'error' in payload ? String((payload as { error: unknown }).error) : 'Request failed (' + response.status + ').';
    throw new Error(detail);
  }
  return payload as T;
}

function formatTime(value: number): string {
  const safe = Math.max(0, Math.floor(value));
  return Math.floor(safe / 60) + ':' + String(safe % 60).padStart(2, '0');
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
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signup');
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
  const audioContext = useRef<AudioContext | null>(null);
  const soundNodes = useRef<OscillatorNode[]>([]);
  const gainNode = useRef<GainNode | null>(null);
  const ticker = useRef<number | null>(null);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2600);
  };

  const stopSound = () => {
    if (ticker.current !== null) window.clearInterval(ticker.current);
    ticker.current = null;
    soundNodes.current.forEach((node) => { try { node.stop(); } catch { /* already stopped */ } });
    soundNodes.current = [];
    gainNode.current?.disconnect();
    gainNode.current = null;
    setPlaying(false);
  };

  const startSound = async (from = seconds) => {
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
        if (next >= (active?.duration ?? 24)) {
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
    soundNodes.current.forEach((node) => { try { node.stop(); } catch { /* already stopped */ } });
    void audioContext.current?.close();
  }, []);

  useEffect(() => { if (gainNode.current) gainNode.current.gain.value = volume * 0.12; }, [volume]);

  const loadLibrary = async (current: User) => {
    try {
      const [likes, lists] = await Promise.all([api<{ tracks: Array<{ id: string }> }>('/api/liked-tracks'), api<{ playlists: Playlist[] }>('/api/playlists')]);
      setLiked(likes.tracks.map((item) => item.id));
      setPlaylists(lists.playlists);
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not load your library.'); }
    setUser(current);
  };

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const result = await api<{ tracks: Array<Record<string, unknown>> }>('/api/catalog');
        if (alive && result.tracks.length) setTracks(result.tracks.map((row) => ({ id: String(row.id), title: String(row.title), artist: String(row.artist_name ?? 'Unknown artist'), album: String(row.album_title ?? 'Single'), genre: String(row.genre ?? 'Other'), duration: Number(row.duration_seconds ?? 24), plays: Number(row.plays_count ?? 0) })));
      } catch { /* use the local demo catalog until the D1 database is connected */ }
      try {
        const result = await api<{ user: User | null }>('/api/me');
        if (alive && result.user) await loadLibrary(result.user);
      } catch { /* public browsing does not require an account */ }
    })();
    return () => { alive = false; };
  }, []);

  const visibleTracks = useMemo(() => tracks.filter((track) => {
    const text = [track.title, track.artist, track.album, track.genre].join(' ').toLowerCase();
    return (!query || text.includes(query.trim().toLowerCase())) && (filter === 'All' || (filter === 'Liked Songs' ? liked.includes(track.id) : track.genre === filter));
  }), [tracks, query, filter, liked]);

  const chooseTrack = (track: Track) => {
    stopSound();
    setActive(track);
    setSeconds(0);
    void api('/api/plays/' + encodeURIComponent(track.id), { method: 'POST', body: '{}' }).catch(() => undefined);
    void startSound(0).catch(() => notify('Tap play again to enable audio.'));
  };

  const toggleLike = async (id: string) => {
    if (!user) { setAuthMode('signin'); setAuthOpen(true); notify('Sign in to save songs.'); return; }
    const wasLiked = liked.includes(id);
    setLiked((current) => wasLiked ? current.filter((item) => item !== id) : [...current, id]);
    try { await api('/api/likes/' + encodeURIComponent(id), { method: wasLiked ? 'DELETE' : 'POST', body: '{}' }); }
    catch (error) { setLiked((current) => wasLiked ? [...current, id] : current.filter((item) => item !== id)); notify(error instanceof Error ? error.message : 'Could not update likes.'); }
  };

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setAuthError('');
    try {
      const endpoint = authMode === 'signup' ? '/api/auth/sign-up/email' : '/api/auth/sign-in/email';
      const payload = authMode === 'signup' ? { name: name.trim(), email: email.trim().toLowerCase(), password } : { email: email.trim().toLowerCase(), password };
      const result = await api<{ user: User }>(endpoint, { method: 'POST', body: JSON.stringify(payload) });
      await loadLibrary(result.user);
      setAuthOpen(false);
      setPassword('');
      notify('Welcome to DeanMusic, ' + result.user.name + '!');
    } catch (error) { setAuthError(error instanceof Error ? error.message : 'Could not complete sign in.'); }
    finally { setBusy(false); }
  };

  const signOut = async () => {
    try {
      await api('/api/auth/sign-out', { method: 'POST', body: '{}' });
      stopSound(); setUser(null); setLiked([]); setPlaylists([]); notify('Signed out.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not sign out.'); }
  };

  const createPlaylist = async () => {
    if (!user) { setPlaylistOpen(false); setAuthMode('signin'); setAuthOpen(true); return; }
    const clean = playlistName.trim();
    if (!clean) return;
    try {
      const result = await api<{ playlist: Playlist }>('/api/playlists', { method: 'POST', body: JSON.stringify({ name: clean }) });
      setPlaylists((current) => [result.playlist, ...current]);
      setPlaylistName(''); setPlaylistOpen(false); notify('Playlist created.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not create playlist.'); }
  };

  const togglePlay = () => {
    if (!active) { if (tracks[0]) chooseTrack(tracks[0]); return; }
    if (playing) stopSound();
    else void startSound(seconds).catch(() => notify('Audio playback is unavailable in this browser.'));
  };

  const progress = active ? Math.min(100, (seconds / Math.max(1, active.duration)) * 100) : 0;

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => { setPage('home'); setFilter('All'); }}><span className="brand-icon">♫</span><span>dean<span className="brand-soft">music</span><small>YOUR SOUND. YOUR SPACE.</small></span></button>
      <p className="nav-label">DISCOVER</p>
      <button className={page === 'home' ? 'nav-link selected' : 'nav-link'} onClick={() => setPage('home')}>⌂ <span>Home</span></button>
      <button className={page === 'search' ? 'nav-link selected' : 'nav-link'} onClick={() => setPage('search')}>⌕ <span>Search</span></button>
      <button className={page === 'library' ? 'nav-link selected' : 'nav-link'} onClick={() => setPage('library')}>▤ <span>Your Library</span></button>
      <div className="sidebar-divider"></div>
      <div className="playlist-title"><span>YOUR PLAYLISTS</span><button onClick={() => setPlaylistOpen(true)}>＋</button></div>
      <div className="side-playlists">{playlists.length ? playlists.map((list) => <button key={list.id} onClick={() => { setPage('library'); notify(list.name); }}>♫ {list.name}</button>) : <p>Your saved playlists will appear here.</p>}</div>
      <div className="side-bottom"><b>DEANMUSIC ORIGINALS</b><span>Small sounds, big feelings.</span><em>Public beta · Free</em></div>
    </aside>
    <main className="main-panel">
      <header className="topbar">
        <div className="top-search"><span>⌕</span><input value={query} onChange={(event) => { setQuery(event.target.value); if (event.target.value) setPage('search'); }} placeholder="What do you want to hear?" aria-label="Search music" /></div>
        <div className="top-actions"><span className="beta-badge">● BETA</span>{user ? <><span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span><span className="username">{user.name}</span><button className="ghost-button" onClick={() => void signOut()}>Sign out</button></> : <><button className="ghost-button" onClick={() => { setAuthMode('signin'); setAuthOpen(true); }}>Log in</button><button className="primary-button small" onClick={() => { setAuthMode('signup'); setAuthOpen(true); }}>Sign up</button></>}</div>
      </header>
      <div className="content">
        {page === 'home' && <>
          <section className="hero"><div><p className="eyebrow">A PLACE FOR YOUR NEXT FAVORITE</p><h1>Good music.<br />Good moments<span>.</span></h1><p>Find a sound that feels like yours.</p><button className="primary-button" onClick={() => setPage('search')}>Explore music <b>→</b></button></div><div className="hero-art"><div className="vinyl"><i></i></div><span>♪</span></div></section>
          <section className="section"><div className="section-heading"><div><p className="eyebrow">MADE FOR YOUR MOMENTS</p><h2>Made for you</h2></div><button className="text-button" onClick={() => setPage('library')}>Your library →</button></div><div className="mix-grid">{categories.map((item, index) => <button className={'mix-card mix-' + index} key={item.name} onClick={() => { setFilter(item.name); setPage('search'); }}><span>{item.icon}</span><b>{['A Little More Calm', 'Golden Feelings', 'Night Drive', 'The Focus Room'][index]}</b><small>{item.name}</small></button>)}</div></section>
          <section className="section"><div className="section-heading"><div><p className="eyebrow">FRESH FROM DEANMUSIC</p><h2>Popular right now</h2></div><span className="track-count">{tracks.length} tracks</span></div><TrackList tracks={tracks} liked={liked} active={active} onChoose={chooseTrack} onLike={toggleLike} playing={playing} /></section>
        </>}
        {page === 'search' && <section className="section page-section"><p className="eyebrow">DISCOVER SOMETHING GOOD</p><h1>Find your sound<span>.</span></h1><div className="big-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search songs, artists, albums, or genres" /></div><div className="filter-list">{['All', 'Liked Songs', 'Electronic', 'Chill', 'Ambient', 'Synthwave'].map((item) => <button className={filter === item ? 'filter-chip active' : 'filter-chip'} key={item} onClick={() => setFilter(item)}>{item}</button>)}</div><div className="section-heading"><h2>{query ? 'Search results' : 'Explore tracks'}</h2><span className="track-count">{visibleTracks.length} tracks</span></div>{visibleTracks.length ? <TrackList tracks={visibleTracks} liked={liked} active={active} onChoose={chooseTrack} onLike={toggleLike} playing={playing} /> : <div className="empty-state"><span>⌕</span><b>No music found</b><p>Try another search or category.</p></div>}</section>}
        {page === 'library' && <section className="section page-section"><p className="eyebrow">YOUR PERSONAL COLLECTION</p><h1>Your Library<span>.</span></h1><div className="filter-list"><button className={filter === 'All' ? 'filter-chip active' : 'filter-chip'} onClick={() => setFilter('All')}>All</button><button className={filter === 'Liked Songs' ? 'filter-chip active' : 'filter-chip'} onClick={() => setFilter('Liked Songs')}>Liked Songs</button><button className="filter-chip" onClick={() => setPlaylistOpen(true)}>＋ Create playlist</button></div>{filter === 'Liked Songs' ? <TrackList tracks={tracks.filter((item) => liked.includes(item.id))} liked={liked} active={active} onChoose={chooseTrack} onLike={toggleLike} playing={playing} /> : <div className="library-grid"><button className="library-card" onClick={() => setFilter('Liked Songs')}><span>♥</span><b>Liked Songs</b><small>{liked.length} songs</small></button>{playlists.map((item) => <div className="library-card" key={item.id}><span>♫</span><b>{item.name}</b><small>Playlist · Your collection</small></div>)}</div>}{!user && <p className="library-hint">Create a free account to sync your liked songs and playlists across devices.</p>}</section>}
      </div>
    </main>
    <footer className="player">
      <div className="now-playing"><div className="album-art">♫</div><div><b>{active?.title ?? 'Choose a track'}</b><small>{active?.artist ?? 'Your next favorite is here'}</small></div><button className={active && liked.includes(active.id) ? 'heart liked' : 'heart'} onClick={() => active && void toggleLike(active.id)}>♥</button></div>
      <div className="player-controls"><div className="control-buttons"><button className={shuffle ? 'control-on' : ''} onClick={() => setShuffle(!shuffle)} title="Shuffle">⤨</button><button onClick={() => setSeconds(0)} title="Restart">|◀</button><button className="play-button" onClick={togglePlay} title={playing ? 'Pause' : 'Play'}>{playing ? 'Ⅱ' : '▶'}</button><button onClick={() => { if (active) setSeconds(Math.min(active.duration, seconds + 5)); }} title="Skip ahead">▶|</button><button className={repeat ? 'control-on' : ''} onClick={() => setRepeat(!repeat)} title="Repeat">↻</button></div><div className="progress-row"><span>{formatTime(seconds)}</span><input type="range" min="0" max={active?.duration ?? 24} value={Math.min(seconds, active?.duration ?? 24)} onChange={(event) => { const next = Number(event.target.value); setSeconds(next); if (playing) void startSound(next); }} /><span>{formatTime(active?.duration ?? 24)}</span></div></div>
      <div className="volume-control"><span>◖</span><input aria-label="Volume" type="range" min="0" max="1" step="0.01" value={volume} onChange={(event) => setVolume(Number(event.target.value))} /></div>
    </footer>
    <nav className="mobile-nav"><button onClick={() => setPage('home')}>⌂ <span>Home</span></button><button onClick={() => setPage('search')}>⌕ <span>Search</span></button><button onClick={() => setPage('library')}>▤ <span>Library</span></button></nav>
    {authOpen && <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setAuthOpen(false); }}><form className="dialog" onSubmit={submitAuth}><button type="button" className="close" onClick={() => setAuthOpen(false)}>×</button><div className="dialog-logo">♫</div><p className="eyebrow">YOUR SOUND. YOUR SPACE.</p><h2>{authMode === 'signup' ? 'Join DeanMusic' : 'Welcome back'}</h2><p className="dialog-copy">Save songs and keep your playlists close wherever you listen.</p>{authMode === 'signup' && <label>Your name<input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} required autoComplete="name" /></label>}<label>Email address<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" /></label><label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} maxLength={128} required autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'} /></label>{authError && <p className="form-error">{authError}</p>}<button type="submit" className="primary-button full" disabled={busy}>{busy ? 'Please wait…' : authMode === 'signup' ? 'Create free account' : 'Log in'}</button><p className="switch-auth">{authMode === 'signup' ? 'Already have an account?' : 'New to DeanMusic?'} <button type="button" onClick={() => { setAuthMode(authMode === 'signup' ? 'signin' : 'signup'); setAuthError(''); }}>{authMode === 'signup' ? 'Log in' : 'Sign up'}</button></p></form></div>}
    {playlistOpen && <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setPlaylistOpen(false); }}><form className="dialog" onSubmit={(event) => { event.preventDefault(); void createPlaylist(); }}><button type="button" className="close" onClick={() => setPlaylistOpen(false)}>×</button><p className="eyebrow">YOUR COLLECTION</p><h2>Create playlist</h2><label>Playlist name<input value={playlistName} onChange={(event) => setPlaylistName(event.target.value)} minLength={1} maxLength={80} required placeholder="Give it a name" /></label><button type="submit" className="primary-button full">Create playlist</button></form></div>}
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

function TrackList({ tracks, liked, active, onChoose, onLike, playing }: { tracks: Track[]; liked: string[]; active: Track | null; onChoose: (track: Track) => void; onLike: (id: string) => void; playing: boolean }) {
  return <div className="track-list"><div className="track-head"><span>#</span><span>Title</span><span>Album</span><span>Genre</span><span>♥</span></div>{tracks.map((track, index) => <div className={active?.id === track.id ? 'track-line current' : 'track-line'} key={track.id}><span className="track-index">{active?.id === track.id && playing ? '♫' : String(index + 1).padStart(2, '0')}</span><button className="track-info" onClick={() => onChoose(track)}><span className="track-cover">♫</span><span><b>{track.title}</b><small>{track.artist}</small></span></button><span>{track.album}</span><span>{track.genre}</span><button className={liked.includes(track.id) ? 'heart liked' : 'heart'} onClick={() => void onLike(track.id)} aria-label="Like track">♥</button></div>)}</div>;
}
