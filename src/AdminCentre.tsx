import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import './admin.css';

type Album = {
  id: string;
  title: string;
  description: string | null;
  cover_url: string | null;
  release_date: string | null;
  genre: string | null;
  is_published: number;
  created_at: string;
  artist_name: string;
  track_count: number;
};

type Track = {
  id: string;
  album_id: string | null;
  title: string;
  duration_seconds: number;
  track_number: number | null;
  genre: string | null;
  audio_path: string | null;
  is_published: number;
  plays_count: number;
  artist_name: string;
  album_title: string | null;
};

type ApiResult<T> = T;

async function adminApi<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const isForm = typeof FormData !== 'undefined' && init?.body instanceof FormData;
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(!isForm && init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : typeof payload === 'object' && payload !== null && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : 'Admin request failed (' + response.status + ').';
    throw new Error(message);
  }
  return payload as T;
}

function durationLabel(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds || 0));
  return Math.floor(value / 60) + ':' + String(value % 60).padStart(2, '0');
}

async function uploadMedia(file: File, kind: 'audio' | 'image'): Promise<string> {
  const form = new FormData();
  form.set('file', file);
  form.set('kind', kind);
  const result = await adminApi<{ url: string }>('/api/admin/media', { method: 'POST', body: form });
  return result.url;
}

export function AdminCentre({ onExit, onNotice }: { onExit: () => void; onNotice: (message: string) => void }) {
  const [tab, setTab] = useState<'overview' | 'albums' | 'tracks'>('overview');
  const [albums, setAlbums] = useState<Album[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [trackQuery, setTrackQuery] = useState('');

  const [albumTitle, setAlbumTitle] = useState('');
  const [artistName, setArtistName] = useState('');
  const [albumGenre, setAlbumGenre] = useState('');
  const [albumDescription, setAlbumDescription] = useState('');
  const [releaseDate, setReleaseDate] = useState('');
  const [coverFile, setCoverFile] = useState<File | null>(null);

  const [selectedAlbum, setSelectedAlbum] = useState('');
  const [trackTitle, setTrackTitle] = useState('');
  const [trackGenre, setTrackGenre] = useState('');
  const [trackNumber, setTrackNumber] = useState('1');
  const [trackDuration, setTrackDuration] = useState('0');
  const [audioFile, setAudioFile] = useState<File | null>(null);

  const [editingTrack, setEditingTrack] = useState<Track | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editGenre, setEditGenre] = useState('');
  const [editNumber, setEditNumber] = useState('1');
  const [editDuration, setEditDuration] = useState('0');

  const loadData = async () => {
    setError('');
    try {
      const [albumResult, trackResult] = await Promise.all([
        adminApi<{ albums: Album[] }>('/api/admin/albums'),
        adminApi<{ tracks: Track[] }>('/api/admin/tracks'),
      ]);
      setAlbums(albumResult.albums);
      setTracks(trackResult.tracks);
      setSelectedAlbum((current) => current || albumResult.albums[0]?.id || '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load the music library.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadData(); }, []);

  const publishedAlbums = albums.filter((album) => album.is_published === 1).length;
  const publishedTracks = tracks.filter((track) => track.is_published === 1).length;
  const totalPlays = tracks.reduce((sum, track) => sum + (Number(track.plays_count) || 0), 0);
  const visibleTracks = useMemo(() => {
    const term = trackQuery.trim().toLowerCase();
    return tracks.filter((track) => !term || [track.title, track.artist_name, track.album_title ?? '', track.genre ?? ''].join(' ').toLowerCase().includes(term));
  }, [tracks, trackQuery]);

  const submitAlbum = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!albumTitle.trim()) return;
    setBusy(true);
    setError('');
    try {
      const coverUrl = coverFile ? await uploadMedia(coverFile, 'image') : '';
      await adminApi('/api/admin/albums', {
        method: 'POST',
        body: JSON.stringify({
          title: albumTitle.trim(),
          artistName: artistName.trim(),
          genre: albumGenre.trim(),
          description: albumDescription.trim(),
          releaseDate,
          coverUrl,
        }),
      });
      setAlbumTitle('');
      setArtistName('');
      setAlbumGenre('');
      setAlbumDescription('');
      setReleaseDate('');
      setCoverFile(null);
      await loadData();
      onNotice('Album saved as a draft. Publish it when it is ready.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the album.');
    } finally {
      setBusy(false);
    }
  };

  const onAudioSelected = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setAudioFile(file);
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration)) setTrackDuration(String(Math.floor(audio.duration)));
      URL.revokeObjectURL(objectUrl);
    };
    audio.onerror = () => URL.revokeObjectURL(objectUrl);
    audio.src = objectUrl;
  };

  const submitTrack = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedAlbum || !trackTitle.trim() || !audioFile) {
      setError('Choose an album, enter a track title, and select an audio file.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const audioPath = await uploadMedia(audioFile, 'audio');
      await adminApi('/api/admin/tracks', {
        method: 'POST',
        body: JSON.stringify({
          albumId: selectedAlbum,
          title: trackTitle.trim(),
          genre: trackGenre.trim(),
          duration: Number(trackDuration) || 0,
          trackNumber: Number(trackNumber),
          audioPath,
        }),
      });
      setTrackTitle('');
      setTrackGenre('');
      setTrackNumber('1');
      setTrackDuration('0');
      setAudioFile(null);
      const input = document.getElementById('admin-audio-file') as HTMLInputElement | null;
      if (input) input.value = '';
      await loadData();
      onNotice('Track uploaded. It is now saved in the selected album.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not upload the track.');
    } finally {
      setBusy(false);
    }
  };

  const toggleAlbumPublish = async (album: Album) => {
    setBusy(true);
    setError('');
    try {
      const action = album.is_published === 1 ? 'unpublish' : 'publish';
      await adminApi('/api/admin/albums/' + encodeURIComponent(album.id) + '/' + action, { method: 'POST', body: '{}' });
      await loadData();
      onNotice(action === 'publish' ? 'Album and its tracks are now public.' : 'Album and its tracks are now hidden from the public catalog.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update album visibility.');
    } finally {
      setBusy(false);
    }
  };

  const removeTrack = async (track: Track) => {
    if (!window.confirm('Delete "' + track.title + '" and its uploaded audio file? This cannot be undone.')) return;
    setBusy(true);
    setError('');
    try {
      await adminApi('/api/admin/tracks/' + encodeURIComponent(track.id), { method: 'DELETE' });
      await loadData();
      onNotice('Track deleted.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete the track.');
    } finally {
      setBusy(false);
    }
  };

  const beginEditTrack = (track: Track) => {
    setEditingTrack(track);
    setEditTitle(track.title);
    setEditGenre(track.genre ?? '');
    setEditNumber(String(track.track_number ?? 1));
    setEditDuration(String(track.duration_seconds ?? 0));
  };

  const saveTrackEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingTrack) return;
    setBusy(true);
    setError('');
    try {
      await adminApi('/api/admin/tracks/' + encodeURIComponent(editingTrack.id), {
        method: 'PATCH',
        body: JSON.stringify({
          title: editTitle.trim(),
          genre: editGenre.trim(),
          trackNumber: Number(editNumber),
          duration: Number(editDuration),
        }),
      });
      setEditingTrack(null);
      await loadData();
      onNotice('Track details updated.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the track.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-centre">
      <div className="admin-heading">
        <div>
          <p className="admin-eyebrow">DEANMUSIC CONTROL ROOM</p>
          <h1>Admin Centre</h1>
          <p className="admin-subtitle">Manage your albums, tracks, and public music catalog.</p>
        </div>
        <button className="admin-secondary-button" type="button" onClick={onExit}>Back to storefront</button>
      </div>

      {error && <div className="admin-alert" role="alert">{error}</div>}

      <div className="admin-tabs" role="tablist" aria-label="Admin sections">
        <button type="button" className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button>
        <button type="button" className={tab === 'albums' ? 'active' : ''} onClick={() => setTab('albums')}>Albums</button>
        <button type="button" className={tab === 'tracks' ? 'active' : ''} onClick={() => setTab('tracks')}>Tracks</button>
      </div>

      {loading ? (
        <div className="admin-loading">Loading your music library…</div>
      ) : tab === 'overview' ? (
        <>
          <div className="admin-metrics">
            <article className="admin-metric"><span>Total albums</span><strong>{albums.length}</strong></article>
            <article className="admin-metric"><span>Total tracks</span><strong>{tracks.length}</strong></article>
            <article className="admin-metric"><span>Published tracks</span><strong>{publishedTracks}</strong></article>
            <article className="admin-metric"><span>Total plays</span><strong>{totalPlays.toLocaleString()}</strong></article>
          </div>
          <div className="admin-overview-grid">
            <article className="admin-panel">
              <div className="admin-panel-heading"><div><h2>Catalog status</h2><p>What's currently visible to listeners.</p></div></div>
              <div className="admin-status-row"><span>Public albums</span><strong>{publishedAlbums} / {albums.length}</strong></div>
              <div className="admin-status-row"><span>Public tracks</span><strong>{publishedTracks} / {tracks.length}</strong></div>
              <div className="admin-status-row"><span>Draft tracks</span><strong>{tracks.length - publishedTracks}</strong></div>
            </article>
            <article className="admin-panel">
              <div className="admin-panel-heading"><div><h2>Quick actions</h2><p>Continue building your music catalog.</p></div></div>
              <button type="button" className="admin-action-card" onClick={() => setTab('albums')}><span className="admin-action-symbol">＋</span><span><strong>Create an album</strong><small>Add artwork, artist, genre, and details.</small></span></button>
              <button type="button" className="admin-action-card" onClick={() => setTab('tracks')}><span className="admin-action-symbol">♫</span><span><strong>Upload a track</strong><small>Add audio to one of your albums.</small></span></button>
            </article>
          </div>
          <div className="admin-storage-note">
            <strong>Music file storage</strong>
            <p>Uploaded audio is delivered from DeanMusic's Cloudflare media storage (up to 20 MB per audio file). Keep your original master files in your private Google Drive archive. Automatic Google Drive backup is not connected yet.</p>
          </div>
          <div className="admin-rights-note">Only upload music and artwork you own or have permission to distribute and stream.</div>
        </>
      ) : tab === 'albums' ? (
        <div className="admin-workspace">
          <article className="admin-panel admin-create-panel">
            <div className="admin-panel-heading"><div><h2>Create album</h2><p>New albums start as drafts and stay hidden until you publish them.</p></div></div>
            <form onSubmit={submitAlbum} className="admin-form">
              <label>Album title<input value={albumTitle} onChange={(event) => setAlbumTitle(event.target.value)} maxLength={120} required placeholder="Enter album title" /></label>
              <div className="admin-form-row">
                <label>Artist name<input value={artistName} onChange={(event) => setArtistName(event.target.value)} maxLength={120} placeholder="Your artist name" /></label>
                <label>Genre<input value={albumGenre} onChange={(event) => setAlbumGenre(event.target.value)} maxLength={60} placeholder="OPM, Pop, Acoustic…" /></label>
              </div>
              <label>Description<textarea value={albumDescription} onChange={(event) => setAlbumDescription(event.target.value)} maxLength={1000} rows={3} placeholder="Tell listeners about this album." /></label>
              <label>Release date<input type="date" value={releaseDate} onChange={(event) => setReleaseDate(event.target.value)} /></label>
              <label>Cover artwork <span className="admin-field-hint">JPG, PNG, or WebP · max 2 MB</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setCoverFile(event.target.files?.[0] ?? null)} /></label>
              {coverFile && <p className="admin-file-name">Selected: {coverFile.name}</p>}
              <button type="submit" className="admin-primary-button" disabled={busy}>{busy ? 'Saving…' : 'Create draft album'}</button>
            </form>
          </article>

          <div className="admin-list-panel">
            <div className="admin-panel-heading"><div><h2>Your albums</h2><p>{albums.length} album{albums.length === 1 ? '' : 's'} in your catalog.</p></div></div>
            {albums.length ? albums.map((album) => (
              <article className="admin-album-row" key={album.id}>
                <div className="admin-album-cover">{album.cover_url ? <img src={album.cover_url} alt="" /> : <span>♫</span>}</div>
                <div className="admin-album-copy"><strong>{album.title}</strong><small>{album.artist_name} · {album.track_count} tracks · {album.genre || 'Uncategorized'}</small></div>
                <span className={album.is_published === 1 ? 'admin-pill published' : 'admin-pill draft'}>{album.is_published === 1 ? 'Published' : 'Draft'}</span>
                <button type="button" className="admin-secondary-button" disabled={busy} onClick={() => void toggleAlbumPublish(album)}>{album.is_published === 1 ? 'Unpublish' : 'Publish'}</button>
              </article>
            )) : <div className="admin-empty">No albums yet. Create your first album using the form.</div>}
          </div>
        </div>
      ) : (
        <div className="admin-workspace">
          <article className="admin-panel admin-create-panel">
            <div className="admin-panel-heading"><div><h2>Upload a track</h2><p>Add an audio file to an existing album.</p></div></div>
            {!albums.length ? <div className="admin-empty">Create an album before uploading tracks.</div> : (
              <form onSubmit={submitTrack} className="admin-form">
                <label>Album<select value={selectedAlbum} onChange={(event) => setSelectedAlbum(event.target.value)} required>{albums.map((album) => <option key={album.id} value={album.id}>{album.title} — {album.artist_name}</option>)}</select></label>
                <label>Track title<input value={trackTitle} onChange={(event) => setTrackTitle(event.target.value)} maxLength={120} required placeholder="Enter track title" /></label>
                <div className="admin-form-row">
                  <label>Track number<input type="number" min="1" step="1" value={trackNumber} onChange={(event) => setTrackNumber(event.target.value)} required /></label>
                  <label>Genre<input value={trackGenre} onChange={(event) => setTrackGenre(event.target.value)} maxLength={60} placeholder="Leave blank to use album genre" /></label>
                </div>
                <label>Audio file <span className="admin-field-hint">MP3, M4A, AAC, OGG, WAV, or WebM · max 20 MB</span><input id="admin-audio-file" type="file" accept="audio/mpeg,audio/mp4,audio/aac,audio/ogg,audio/wav,audio/x-wav,audio/webm,.mp3,.m4a,.aac,.ogg,.wav,.webm" onChange={onAudioSelected} required /></label>
                {audioFile && <p className="admin-file-name">Selected: {audioFile.name}</p>}
                <label>Duration in seconds <span className="admin-field-hint">Detected automatically when supported; you can adjust it.</span><input type="number" min="0" max="86400" value={trackDuration} onChange={(event) => setTrackDuration(event.target.value)} /></label>
                <button type="submit" className="admin-primary-button" disabled={busy || !albums.length}>{busy ? 'Uploading…' : 'Upload track'}</button>
              </form>
            )}
          </article>

          <div className="admin-list-panel">
            <div className="admin-panel-heading admin-track-list-heading"><div><h2>Music library</h2><p>{tracks.length} track{tracks.length === 1 ? '' : 's'} uploaded.</p></div><input aria-label="Search tracks" className="admin-search" value={trackQuery} onChange={(event) => setTrackQuery(event.target.value)} placeholder="Search tracks…" /></div>
            {editingTrack && (
              <form className="admin-edit-track" onSubmit={saveTrackEdit}>
                <div><strong>Edit track details</strong><button type="button" className="admin-text-button" onClick={() => setEditingTrack(null)}>Cancel</button></div>
                <div className="admin-form-row">
                  <label>Title<input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} required maxLength={120} /></label>
                  <label>Genre<input value={editGenre} onChange={(event) => setEditGenre(event.target.value)} maxLength={60} /></label>
                  <label>Track number<input type="number" min="1" step="1" value={editNumber} onChange={(event) => setEditNumber(event.target.value)} required /></label>
                  <label>Duration (seconds)<input type="number" min="0" max="86400" value={editDuration} onChange={(event) => setEditDuration(event.target.value)} required /></label>
                </div>
                <button type="submit" className="admin-primary-button" disabled={busy}>Save track details</button>
              </form>
            )}
            {visibleTracks.length ? (
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead><tr><th>Track</th><th>Album</th><th>Duration</th><th>Plays</th><th>Status</th><th>Actions</th></tr></thead>
                  <tbody>{visibleTracks.map((track) => (
                    <tr key={track.id}>
                      <td><strong>{track.title}</strong><small>{track.artist_name}</small></td>
                      <td>{track.album_title || 'Single'}</td>
                      <td>{durationLabel(track.duration_seconds)}</td>
                      <td>{Number(track.plays_count || 0).toLocaleString()}</td>
                      <td><span className={track.is_published === 1 ? 'admin-pill published' : 'admin-pill draft'}>{track.is_published === 1 ? 'Public' : 'Draft'}</span></td>
                      <td><div className="admin-row-actions"><button type="button" className="admin-text-button" onClick={() => beginEditTrack(track)}>Edit</button><button type="button" className="admin-danger-button" disabled={busy} onClick={() => void removeTrack(track)}>Delete</button></div></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : <div className="admin-empty">{tracks.length ? 'No tracks match your search.' : 'No tracks uploaded yet.'}</div>}
          </div>
        </div>
      )}

      <div className="admin-footer-actions"><button type="button" className="admin-secondary-button" onClick={() => void loadData()}>Refresh catalog</button><span>Changes are saved to your DeanMusic catalog.</span></div>
    </section>
  );
}
