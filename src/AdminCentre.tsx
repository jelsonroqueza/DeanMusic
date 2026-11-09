import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import './admin.css';

type Album = {
  id: string;
  title: string;
  description: string | null;
  cover_url: string | null;
  banner_url: string | null;
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
  video_path: string | null;
  banner_url: string | null;
  is_published: number;
  plays_count: number;
  artist_name: string;
  album_title: string | null;
};

type ApiResult<T> = T;

const previewAlbums: Album[] = [
  {
    id: 'preview-album-1', title: 'Gabi at Umaga', description: 'A sample OPM collection for the Admin Centre preview.',
    cover_url: null, banner_url: null, release_date: '2026-11-01', genre: 'OPM', is_published: 1,
    created_at: '2026-11-01', artist_name: 'DeanMusic Originals', track_count: 4,
  },
  {
    id: 'preview-album-2', title: 'Midnight Drive', description: 'A sample electronic album shown in read-only preview mode.',
    cover_url: null, banner_url: null, release_date: '2026-11-06', genre: 'Electronic', is_published: 0,
    created_at: '2026-11-06', artist_name: 'DeanMusic Originals', track_count: 3,
  },
];

const previewTracks: Track[] = [
  { id: 'preview-track-1', album_id: 'preview-album-1', title: 'Bituin sa Dilim', duration_seconds: 214, track_number: 1, genre: 'OPM', audio_path: null, video_path: null, banner_url: null, is_published: 1, plays_count: 1240, artist_name: 'DeanMusic Originals', album_title: 'Gabi at Umaga' },
  { id: 'preview-track-2', album_id: 'preview-album-1', title: 'Sa Dulo ng Gabi', duration_seconds: 198, track_number: 2, genre: 'OPM', audio_path: null, video_path: null, banner_url: null, is_published: 1, plays_count: 865, artist_name: 'DeanMusic Originals', album_title: 'Gabi at Umaga' },
  { id: 'preview-track-3', album_id: 'preview-album-2', title: 'Neon Highway', duration_seconds: 232, track_number: 1, genre: 'Electronic', audio_path: null, video_path: null, banner_url: null, is_published: 0, plays_count: 0, artist_name: 'DeanMusic Originals', album_title: 'Midnight Drive' },
];


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

async function uploadMedia(file: File, kind: 'audio' | 'image' | 'video', durationSeconds?: number): Promise<string> {
  const form = new FormData();
  form.set('file', file);
  form.set('kind', kind);
  if (kind === 'video' && durationSeconds !== undefined) form.set('durationSeconds', String(durationSeconds));
  const result = await adminApi<{ url: string }>('/api/admin/media', { method: 'POST', body: form });
  return result.url;
}

async function readCanvasVideoInfo(file: File): Promise<{ duration: number; width: number; height: number }> {
  const objectUrl = URL.createObjectURL(file);
  return await new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const info = { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
      URL.revokeObjectURL(objectUrl);
      if (Number.isFinite(info.duration) && info.duration > 0 && info.width > 0 && info.height > 0) resolve(info);
      else reject(new Error('Could not read the selected Canvas video metadata.'));
    };
    video.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('The selected Canvas video could not be read.'));
    };
    video.src = objectUrl;
  });
}

function validateCanvasVideo(info: { duration: number; width: number; height: number }): void {
  if (info.duration > 15.05) throw new Error('Canvas videos must be 15 seconds or shorter.');
  if (info.width < 720 || info.height < 1280) throw new Error('Use an HD vertical video with at least 720 × 1280 resolution.');
  const ratio = info.width / info.height;
  if (Math.abs(ratio - (9 / 16)) > 0.04) throw new Error('Canvas videos must use a vertical 9:16 aspect ratio.');
}

async function readMediaDuration(file: File, kind: 'audio' | 'video'): Promise<number> {
  const objectUrl = URL.createObjectURL(file);
  return await new Promise<number>((resolve, reject) => {
    const element = kind === 'audio' ? new Audio() : document.createElement('video');
    element.preload = 'metadata';
    element.onloadedmetadata = () => {
      const duration = element.duration;
      URL.revokeObjectURL(objectUrl);
      if (Number.isFinite(duration) && duration > 0) resolve(duration);
      else reject(new Error('Could not read the selected media duration.'));
    };
    element.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('The selected media file could not be read.'));
    };
    element.src = objectUrl;
  });
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return (value / Math.pow(1024, index)).toFixed(index > 1 ? 2 : 0) + ' ' + units[index];
}

export function AdminCentre({ onExit, onNotice, previewOnly = false }: { onExit: () => void; onNotice: (message: string) => void; previewOnly?: boolean }) {
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
  const [albumBannerFile, setAlbumBannerFile] = useState<File | null>(null);

  const [editingAlbum, setEditingAlbum] = useState<Album | null>(null);
  const [editAlbumTitle, setEditAlbumTitle] = useState('');
  const [editArtistName, setEditArtistName] = useState('');
  const [editAlbumGenre, setEditAlbumGenre] = useState('');
  const [editAlbumDescription, setEditAlbumDescription] = useState('');
  const [editReleaseDate, setEditReleaseDate] = useState('');
  const [editCoverFile, setEditCoverFile] = useState<File | null>(null);
  const [editAlbumBannerFile, setEditAlbumBannerFile] = useState<File | null>(null);
  const [removeExistingAlbumBanner, setRemoveExistingAlbumBanner] = useState(false);

  const [selectedAlbum, setSelectedAlbum] = useState('');
  const [trackTitle, setTrackTitle] = useState('');
  const [trackArtistName, setTrackArtistName] = useState('');
  const [trackBannerFile, setTrackBannerFile] = useState<File | null>(null);
  const [publishImmediately, setPublishImmediately] = useState(true);
  const [trackGenre, setTrackGenre] = useState('');
  const [trackNumber, setTrackNumber] = useState('1');
  const [trackDuration, setTrackDuration] = useState('0');
  const [audioFiles, setAudioFiles] = useState<File[]>([]);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState('');
  const [storageUsage, setStorageUsage] = useState<{
    provider: string; r2Connected: boolean; usedBytes: number; limitBytes: number;
    warningBytes: number; percentUsed: number; canUpload: boolean;
  } | null>(null);
  const [reconcilingLegacyMedia, setReconcilingLegacyMedia] = useState(false);
  const [legacyMediaCursor, setLegacyMediaCursor] = useState<string | undefined>(undefined);
  const [legacyMediaScanComplete, setLegacyMediaScanComplete] = useState(false);
  const [legacyMediaScanStatus, setLegacyMediaScanStatus] = useState('');

  const [editingTrack, setEditingTrack] = useState<Track | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editTrackArtistName, setEditTrackArtistName] = useState('');
  const [editBannerFile, setEditBannerFile] = useState<File | null>(null);
  const [removeExistingBanner, setRemoveExistingBanner] = useState(false);
  const [editGenre, setEditGenre] = useState('');
  const [editNumber, setEditNumber] = useState('1');
  const [editDuration, setEditDuration] = useState('0');
  const [editVideoFile, setEditVideoFile] = useState<File | null>(null);
  const [removeExistingVideo, setRemoveExistingVideo] = useState(false);

  const loadData = async () => {
    setError('');
    if (previewOnly) {
      setAlbums(previewAlbums);
      setTracks(previewTracks);
      setStorageUsage({ provider: 'Preview only', r2Connected: false, usedBytes: 0, limitBytes: 0, warningBytes: 0, percentUsed: 0, canUpload: false });
      setSelectedAlbum((current) => current || previewAlbums[0].id);
      setTrackArtistName((current) => current || previewAlbums[0].artist_name);
      setLoading(false);
      return;
    }
    try {
      const [albumResult, trackResult, storageResult] = await Promise.all([
        adminApi<{ albums: Album[] }>('/api/admin/albums'),
        adminApi<{ tracks: Track[] }>('/api/admin/tracks'),
        adminApi<{ provider: string; r2Connected: boolean; usedBytes: number; limitBytes: number; warningBytes: number; percentUsed: number; canUpload: boolean }>('/api/admin/media'),
      ]);
      setAlbums(albumResult.albums);
      setTracks(trackResult.tracks);
      setStorageUsage(storageResult);
      setSelectedAlbum((current) => current || albumResult.albums[0]?.id || '');
      setTrackArtistName((current) => current || albumResult.albums[0]?.artist_name || '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load the music library.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadData(); }, [previewOnly]);

  const reconcileLegacyMedia = async () => {
    if (previewOnly || reconcilingLegacyMedia || legacyMediaScanComplete) return;
    setReconcilingLegacyMedia(true);
    setError('');
    let cursor = legacyMediaCursor;
    let scanned = 0;
    let imported = 0;
    let pages = 0;
    let complete = false;

    try {
      while (!complete && pages < 10) {
        const result = await adminApi<{
          processed: number;
          imported: number;
          skipped: number;
          complete: boolean;
          cursor: string | null;
        }>('/api/admin/media/reconcile', {
          method: 'POST',
          body: JSON.stringify({ cursor }),
        });
        scanned += result.processed;
        imported += result.imported;
        complete = result.complete;
        cursor = result.cursor ?? undefined;
        pages += 1;
        setLegacyMediaScanStatus(
          'Scanned ' + scanned.toLocaleString() + ' legacy KV objects in this batch; ' +
          imported.toLocaleString() + ' inventory records added.'
        );
        if (!complete && !cursor) throw new Error('The KV scan returned an incomplete page without a continuation cursor.');
      }

      setLegacyMediaCursor(complete ? undefined : cursor);
      setLegacyMediaScanComplete(complete);
      await loadData();
      setLegacyMediaScanStatus(
        complete
          ? 'Legacy KV scan complete. ' + scanned.toLocaleString() + ' objects checked; ' + imported.toLocaleString() + ' inventory records added.'
          : 'Batch complete: ' + scanned.toLocaleString() + ' objects checked; ' + imported.toLocaleString() + ' records added. Select Continue to scan the next batch.'
      );
      if (complete) onNotice('Legacy KV storage inventory reconciliation is complete.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not reconcile older KV uploads.');
    } finally {
      setReconcilingLegacyMedia(false);
    }
  };

  const publishedAlbums = albums.filter((album) => album.is_published === 1).length;
  const publishedTracks = tracks.filter((track) => track.is_published === 1).length;
  const totalPlays = tracks.reduce((sum, track) => sum + (Number(track.plays_count) || 0), 0);
  const visibleTracks = useMemo(() => {
    const term = trackQuery.trim().toLowerCase();
    return tracks.filter((track) => !term || [track.title, track.artist_name, track.album_title ?? '', track.genre ?? ''].join(' ').toLowerCase().includes(term));
  }, [tracks, trackQuery]);

  const submitAlbum = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (previewOnly) return;
    if (!albumTitle.trim()) return;
    setBusy(true);
    setError('');
    try {
      const coverUrl = coverFile ? await uploadMedia(coverFile, 'image') : '';
      const bannerUrl = albumBannerFile ? await uploadMedia(albumBannerFile, 'image') : '';
      await adminApi('/api/admin/albums', {
        method: 'POST',
        body: JSON.stringify({
          title: albumTitle.trim(),
          artistName: artistName.trim(),
          genre: albumGenre.trim(),
          description: albumDescription.trim(),
          releaseDate,
          coverUrl,
          bannerUrl,
        }),
      });
      setAlbumTitle('');
      setArtistName('');
      setAlbumGenre('');
      setAlbumDescription('');
      setReleaseDate('');
      setCoverFile(null);
      setAlbumBannerFile(null);
      await loadData();
      onNotice('Album saved as a draft. Publish it when it is ready.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the album.');
    } finally {
      setBusy(false);
    }
  };

  const onAudioSelected = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    setAudioFiles(files);
    setTrackBannerFile(null);
    setTrackTitle(files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') : '');
    setVideoFile(null);
    if (files.length === 1) {
      void readMediaDuration(files[0], 'audio').then((duration) => setTrackDuration(String(Math.floor(duration)))).catch(() => setTrackDuration('0'));
    } else {
      setTrackDuration('0');
    }
  };

  const submitTrack = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (previewOnly) return;
    if (!selectedAlbum || audioFiles.length === 0) {
      setError('Choose an album and select at least one audio file.');
      return;
    }
    if (videoFile && audioFiles.length !== 1) {
      setError('Attach a Canvas video during upload only when selecting one song. For bulk uploads, add videos later using Edit on each track.');
      return;
    }
    setBusy(true);
    setError('');
    const failures: string[] = [];
    const completed: string[] = [];
    try {
      let videoDuration = 0;
      if (videoFile) {
        const videoInfo = await readCanvasVideoInfo(videoFile);
        validateCanvasVideo(videoInfo);
        videoDuration = videoInfo.duration;
      }
      for (let index = 0; index < audioFiles.length; index += 1) {
        const file = audioFiles[index];
        const title = audioFiles.length === 1 && trackTitle.trim()
          ? trackTitle.trim()
          : file.name.replace(/\.[^.]+$/, '').slice(0, 120);
        setUploadProgress('Uploading ' + (index + 1) + ' of ' + audioFiles.length + ': ' + file.name);
        let audioPath = '';
        let createdTrackId = '';
        let unattachedVideoPath = '';
        let unattachedBannerPath = '';
        try {
          const detectedDuration = await readMediaDuration(file, 'audio').catch(() => 0);
          const duration = audioFiles.length === 1 && Number(trackDuration) > 0
            ? Number(trackDuration)
            : Math.floor(detectedDuration);
          audioPath = await uploadMedia(file, 'audio');
          if (audioFiles.length === 1 && trackBannerFile) {
            setUploadProgress('Uploading soundtrack banner for ' + title);
            unattachedBannerPath = await uploadMedia(trackBannerFile, 'image');
          }
          const created = await adminApi<{ track: { id: string } }>('/api/admin/tracks', {
            method: 'POST',
            body: JSON.stringify({
              albumId: selectedAlbum,
              title,
              artistName: trackArtistName.trim(),
              genre: trackGenre.trim(),
              duration,
              trackNumber: Number(trackNumber) + index,
              audioPath,
              bannerUrl: unattachedBannerPath || undefined,
              publishImmediately,
            }),
          });
          createdTrackId = created.track.id;
          if (videoFile && index === 0) {
            setUploadProgress('Uploading Canvas video for ' + title);
            unattachedVideoPath = await uploadMedia(videoFile, 'video', videoDuration);
            await adminApi('/api/admin/tracks/' + encodeURIComponent(created.track.id), {
              method: 'PATCH',
              body: JSON.stringify({ title, genre: trackGenre.trim(), duration, trackNumber: Number(trackNumber), videoPath: unattachedVideoPath }),
            });
            unattachedVideoPath = '';
          }
          completed.push(title);
        } catch (cause) {
          if (createdTrackId) {
            await adminApi('/api/admin/tracks/' + encodeURIComponent(createdTrackId), { method: 'DELETE' }).catch(() => undefined);
          } else if (audioPath) {
            const mediaId = audioPath.slice('/media/'.length);
            await adminApi('/api/admin/media/' + encodeURIComponent(mediaId), { method: 'DELETE' }).catch(() => undefined);
          }
          if (unattachedVideoPath) {
            const videoId = unattachedVideoPath.slice('/media/'.length);
            await adminApi('/api/admin/media/' + encodeURIComponent(videoId), { method: 'DELETE' }).catch(() => undefined);
          }
          if (unattachedBannerPath && !createdTrackId) {
            const bannerId = unattachedBannerPath.slice('/media/'.length);
            await adminApi('/api/admin/media/' + encodeURIComponent(bannerId), { method: 'DELETE' }).catch(() => undefined);
          }
          failures.push(file.name + ': ' + (cause instanceof Error ? cause.message : 'Upload failed.'));
        }
      }
      setAudioFiles([]);
      setVideoFile(null);
      setTrackBannerFile(null);
      setTrackTitle('');
      setTrackGenre('');
      setTrackNumber(String(Math.max(1, Number(trackNumber) + completed.length)));
      setTrackDuration('0');
      const input = document.getElementById('admin-audio-file') as HTMLInputElement | null;
      if (input) input.value = '';
      const videoInput = document.getElementById('admin-video-file') as HTMLInputElement | null;
      if (videoInput) videoInput.value = '';
      await loadData();
      if (failures.length) {
        setError(completed.length + ' track(s) uploaded. Some files need attention: ' + failures.join(' | '));
      } else {
        onNotice(completed.length + ' track' + (completed.length === 1 ? '' : 's') + ' uploaded successfully.');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not upload the selected tracks.');
    } finally {
      setUploadProgress('');
      setBusy(false);
    }
  };

  const beginEditAlbum = (album: Album) => {
    setEditingAlbum(album);
    setEditAlbumTitle(album.title);
    setEditTrackArtistName(album.artist_name);
    setEditAlbumGenre(album.genre ?? '');
    setEditAlbumDescription(album.description ?? '');
    setEditReleaseDate(album.release_date ?? '');
    setEditCoverFile(null);
    setEditAlbumBannerFile(null);
    setRemoveExistingAlbumBanner(false);
  };

  const saveAlbumEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (previewOnly) return;
    if (!editingAlbum) return;
    setBusy(true);
    setError('');
    try {
      const coverUrl = editCoverFile ? await uploadMedia(editCoverFile, 'image') : (editingAlbum.cover_url ?? '');
      const bannerUrl = editAlbumBannerFile ? await uploadMedia(editAlbumBannerFile, 'image') : removeExistingAlbumBanner ? null : undefined;
      await adminApi('/api/admin/albums/' + encodeURIComponent(editingAlbum.id), {
        method: 'PATCH',
        body: JSON.stringify({
          title: editAlbumTitle.trim(),
          artistName: editArtistName.trim(),
          genre: editAlbumGenre.trim(),
          description: editAlbumDescription.trim(),
          releaseDate: editReleaseDate,
          coverUrl,
          ...(bannerUrl !== undefined ? { bannerUrl } : {}),
        }),
      });
      setEditingAlbum(null);
      setEditAlbumBannerFile(null);
      setRemoveExistingAlbumBanner(false);
      await loadData();
      onNotice('Album details updated.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the album.');
    } finally {
      setBusy(false);
    }
  };

  const toggleAlbumPublish = async (album: Album) => {
    if (previewOnly) return;
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
    if (previewOnly) return;
    if (!window.confirm('Delete "' + track.title + '" and its uploaded audio plus Canvas video files? This cannot be undone.')) return;
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
    setEditTrackArtistName(track.artist_name);
    setEditBannerFile(null);
    setRemoveExistingBanner(false);
    setEditGenre(track.genre ?? '');
    setEditNumber(String(track.track_number ?? 1));
    setEditDuration(String(track.duration_seconds ?? 0));
    setEditVideoFile(null);
    setRemoveExistingVideo(false);
  };

  const saveTrackEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (previewOnly) return;
    if (!editingTrack) return;
    setBusy(true);
    setError('');
    try {
      let videoPath: string | null | undefined;
      let bannerUrl: string | null | undefined;
      if (editBannerFile) bannerUrl = await uploadMedia(editBannerFile, 'image');
      else if (removeExistingBanner) bannerUrl = null;
      if (editVideoFile) {
        const videoInfo = await readCanvasVideoInfo(editVideoFile);
        validateCanvasVideo(videoInfo);
        videoPath = await uploadMedia(editVideoFile, 'video', videoInfo.duration);
      } else if (removeExistingVideo) {
        videoPath = null;
      }
      try {
        await adminApi('/api/admin/tracks/' + encodeURIComponent(editingTrack.id), {
          method: 'PATCH',
          body: JSON.stringify({
            title: editTitle.trim(),
            artistName: editTrackArtistName.trim(),
            genre: editGenre.trim(),
            trackNumber: Number(editNumber),
            duration: Number(editDuration),
            ...(videoPath !== undefined ? { videoPath } : {}),
            ...(bannerUrl !== undefined ? { bannerUrl } : {}),
          }),
        });
      } catch (cause) {
        if (typeof videoPath === 'string') {
          const mediaId = videoPath.slice('/media/'.length);
          await adminApi('/api/admin/media/' + encodeURIComponent(mediaId), { method: 'DELETE' }).catch(() => undefined);
        }
        if (typeof bannerUrl === 'string') {
          const mediaId = bannerUrl.slice('/media/'.length);
          await adminApi('/api/admin/media/' + encodeURIComponent(mediaId), { method: 'DELETE' }).catch(() => undefined);
        }
        throw cause;
      }
      setEditingTrack(null);
      setEditVideoFile(null);
      setRemoveExistingVideo(false);
      setEditBannerFile(null);
      setRemoveExistingBanner(false);
      await loadData();
      onNotice(videoPath === null ? 'Track updated and Canvas video removed.' : editVideoFile ? 'Track and Canvas video updated.' : 'Track details updated.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the track.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={previewOnly ? 'admin-centre is-preview' : 'admin-centre'}>
      <div className="admin-heading">
        <div>
          <p className="admin-eyebrow">DEANMUSIC CONTROL ROOM</p>
          <h1>Admin Centre</h1>
          <p className="admin-subtitle">Manage your albums, tracks, and public music catalog.</p>
        </div>
        <button className="admin-secondary-button" type="button" onClick={onExit}>Back to storefront</button>
      </div>

      {error && <div className="admin-alert" role="alert">{error}</div>}

      {previewOnly && <div className="admin-preview-banner" role="status"><strong>Read-only demo preview</strong><span>Sample data only. Upload, publish, edit, and delete actions are disabled. Production admin access remains protected.</span></div>}

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
          {!previewOnly && <div className="admin-storage-note">
            <div className="admin-storage-heading">
              <div><strong>Music & video storage · {storageUsage?.provider ?? 'Checking…'}</strong><small>{storageUsage?.r2Connected ? 'R2 is connected. New audio, cover, and Canvas video uploads use your R2 bucket.' : 'R2 is not connected yet. The current free KV storage remains active until the R2 bucket is provisioned.'}</small></div>
              <span className={storageUsage?.r2Connected ? 'admin-pill published' : 'admin-pill draft'}>{storageUsage?.r2Connected ? 'R2 connected' : 'KV active'}</span>
            </div>
            <div className="admin-storage-bar"><span style={{ width: (storageUsage?.percentUsed ?? 0) + '%' }} /></div>
            <div className="admin-storage-summary"><span>{formatBytes(storageUsage?.usedBytes ?? 0)} used of {formatBytes(storageUsage?.limitBytes ?? 0)}</span><strong>{(storageUsage?.percentUsed ?? 0).toFixed(1)}%</strong></div>
            {storageUsage && storageUsage.usedBytes >= storageUsage.warningBytes && <p className="admin-storage-warning" role="status">Storage warning: {(storageUsage.warningBytes / (1024 * 1024 * 1024)).toFixed(1)} GB warning threshold reached. New uploads will stop at the configured limit.</p>}

            <p>{storageUsage?.r2Connected ? 'Warning at 80 GB. New uploads are blocked at the 100 GB app storage ceiling.' : 'R2 target: 100 GB app ceiling, 80 GB warning. Current KV fallback is limited to its 1 GB app ceiling. No automatic billing or upgrade is enabled.'}</p>
            {!storageUsage?.r2Connected && <>
              <p>Older KV uploads made before the media inventory was introduced are not counted until they are scanned. This scan only adds inventory records; it does not move, edit, or delete media files.</p>
              <button
                type="button"
                className="admin-secondary-button"
                onClick={() => void reconcileLegacyMedia()}
                disabled={reconcilingLegacyMedia || legacyMediaScanComplete || busy}
              >
                {reconcilingLegacyMedia
                  ? 'Scanning legacy KV files…'
                  : legacyMediaScanComplete
                    ? 'Legacy KV scan complete'
                    : legacyMediaCursor
                      ? 'Continue legacy KV scan'
                      : 'Scan existing KV uploads'}
              </button>
              {legacyMediaScanStatus && <p className="admin-upload-progress" role="status">{legacyMediaScanStatus}</p>}
            </>}
          </div>}
          <div className="admin-rights-note">Only upload music and artwork you own or have permission to distribute and stream.</div>
        </>
      ) : tab === 'albums' ? (
        <div className="admin-workspace">
          <article className="admin-panel admin-create-panel">
            <div className="admin-panel-heading"><div><h2>Create album</h2><p>New albums start as drafts and stay hidden until you publish them.</p></div></div>
            <form onSubmit={submitAlbum} className="admin-form">
              <label>Album title<input disabled={previewOnly || busy} value={albumTitle} onChange={(event) => setAlbumTitle(event.target.value)} maxLength={120} required placeholder="Enter album title" /></label>
              <div className="admin-form-row">
                <label>Artist name<input disabled={previewOnly || busy} value={artistName} onChange={(event) => setArtistName(event.target.value)} maxLength={120} placeholder="Your artist name" /></label>
                <label>Genre<input disabled={previewOnly || busy} value={albumGenre} onChange={(event) => setAlbumGenre(event.target.value)} maxLength={60} placeholder="OPM, Pop, Acoustic…" /></label>
              </div>
              <label>Description<textarea disabled={previewOnly || busy} value={albumDescription} onChange={(event) => setAlbumDescription(event.target.value)} maxLength={1000} rows={3} placeholder="Tell listeners about this album." /></label>
              <label>Release date<input disabled={previewOnly || busy} type="date" value={releaseDate} onChange={(event) => setReleaseDate(event.target.value)} /></label>
              <label>Cover artwork <span className="admin-field-hint">Square artwork · JPG, PNG, or WebP · max 2 MB</span><input disabled={previewOnly || busy} type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setCoverFile(event.target.files?.[0] ?? null)} /></label>
              {coverFile && <p className="admin-file-name">Selected cover: {coverFile.name}</p>}
              <label>Album banner <span className="admin-field-hint">Optional wide image · recommended 1600 × 600 · JPG, PNG, or WebP · max 2 MB</span><input disabled={previewOnly || busy} type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setAlbumBannerFile(event.target.files?.[0] ?? null)} /></label>
              {albumBannerFile && <p className="admin-file-name">Selected banner: {albumBannerFile.name}</p>}
              <button type="submit" className="admin-primary-button" disabled={previewOnly || busy}>{busy ? 'Saving…' : 'Create draft album'}</button>
            </form>
          </article>

          <div className="admin-list-panel">
            {editingAlbum && (
              <form className="admin-edit-track admin-edit-album" onSubmit={saveAlbumEdit}>
                <div><strong>Edit album details</strong><button type="button" className="admin-text-button" onClick={() => setEditingAlbum(null)}>Cancel</button></div>
                <div className="admin-form-row">
                  <label>Album title<input disabled={previewOnly || busy} value={editAlbumTitle} onChange={(event) => setEditAlbumTitle(event.target.value)} maxLength={120} required /></label>
                  <label>Artist name<input disabled={previewOnly || busy} value={editArtistName} onChange={(event) => setEditArtistName(event.target.value)} maxLength={120} required /></label>
                  <label>Genre<input disabled={previewOnly || busy} value={editAlbumGenre} onChange={(event) => setEditAlbumGenre(event.target.value)} maxLength={60} /></label>
                  <label>Release date<input disabled={previewOnly || busy} type="date" value={editReleaseDate} onChange={(event) => setEditReleaseDate(event.target.value)} /></label>
                </div>
                <label className="admin-edit-description">Description<textarea disabled={previewOnly || busy} value={editAlbumDescription} onChange={(event) => setEditAlbumDescription(event.target.value)} maxLength={1000} rows={2} /></label>
                <label className="admin-edit-description">Replace cover artwork <span className="admin-field-hint">Square artwork · JPG, PNG, or WebP · max 2 MB</span><input disabled={previewOnly || busy} type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setEditCoverFile(event.target.files?.[0] ?? null)} /></label>
                <label className="admin-edit-description">{editingAlbum.banner_url ? 'Replace album banner' : 'Add album banner'} <span className="admin-field-hint">Optional wide image · recommended 1600 × 600 · JPG, PNG, or WebP · max 2 MB</span><input disabled={previewOnly || busy} type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setEditAlbumBannerFile(event.target.files?.[0] ?? null)} /></label>
                {editingAlbum.banner_url && <p className="admin-file-name">Current album banner is attached.</p>}
                {editAlbumBannerFile && <p className="admin-file-name">New banner: {editAlbumBannerFile.name}</p>}
                {editingAlbum.banner_url && <label className="admin-check-row"><input type="checkbox" disabled={previewOnly || busy || Boolean(editAlbumBannerFile)} checked={removeExistingAlbumBanner} onChange={(event) => setRemoveExistingAlbumBanner(event.target.checked)} /> Remove current album banner when saving</label>}
                <button type="submit" className="admin-primary-button" disabled={previewOnly || busy}>Save album details</button>
              </form>
            )}
            <div className="admin-panel-heading"><div><h2>Your albums</h2><p>{albums.length} album{albums.length === 1 ? '' : 's'} in your catalog.</p></div></div>
            {albums.length ? albums.map((album) => (
              <article className="admin-album-row" key={album.id}>
                <div className="admin-album-cover">{album.cover_url ? <img src={album.cover_url} alt="" /> : <span>♫</span>}</div>
                <div className="admin-album-copy"><strong>{album.title}</strong><small>{album.artist_name} · {album.track_count} tracks · {album.genre || 'Uncategorized'}</small></div>
                {album.banner_url && <span className="admin-album-banner"><img src={album.banner_url} alt={album.title + ' banner'} /></span>}
                <span className={album.is_published === 1 ? 'admin-pill published' : 'admin-pill draft'}>{album.is_published === 1 ? 'Published' : 'Draft'}</span>
                <button type="button" className="admin-text-button" disabled={previewOnly || busy} onClick={() => beginEditAlbum(album)}>Edit</button>
                <button type="button" className="admin-secondary-button" disabled={previewOnly || busy} onClick={() => void toggleAlbumPublish(album)}>{album.is_published === 1 ? 'Unpublish' : 'Publish'}</button>
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
                <label>Album<select disabled={previewOnly || busy} value={selectedAlbum} onChange={(event) => { const nextAlbum = albums.find((album) => album.id === event.target.value); setSelectedAlbum(event.target.value); setTrackArtistName(nextAlbum?.artist_name ?? ''); }} required>{albums.map((album) => <option key={album.id} value={album.id}>{album.title} — {album.artist_name}</option>)}</select></label>
                <label>Track title <span className="admin-field-hint">Optional for one file. Multiple uploads use each filename as its track title.</span><input disabled={previewOnly || busy || audioFiles.length > 1} value={trackTitle} onChange={(event) => setTrackTitle(event.target.value)} maxLength={120} placeholder="Optional custom title for one track" /></label>
                <label>Artist name <span className="admin-field-hint">Saved on this individual soundtrack. Defaults to the selected album artist.</span><input disabled={previewOnly || busy} value={trackArtistName} onChange={(event) => setTrackArtistName(event.target.value)} maxLength={120} required placeholder="Enter soundtrack artist" /></label>
                <div className="admin-form-row">
                  <label>Starting track number<input disabled={previewOnly || busy} type="number" min="1" step="1" value={trackNumber} onChange={(event) => setTrackNumber(event.target.value)} required /></label>
                  <label>Genre<input disabled={previewOnly || busy} value={trackGenre} onChange={(event) => setTrackGenre(event.target.value)} maxLength={60} placeholder="Leave blank to use album genre" /></label>
                </div>
                <label>Audio files <span className="admin-field-hint">MP3, M4A, AAC, OGG, WAV, or WebM · max 24 MiB each · select multiple songs</span><input disabled={previewOnly || busy} id="admin-audio-file" type="file" multiple accept="audio/mpeg,audio/mp4,audio/aac,audio/ogg,audio/wav,audio/x-wav,audio/webm,.mp3,.m4a,.aac,.ogg,.wav,.webm" onChange={onAudioSelected} required /></label>
                {audioFiles.length > 0 && <div className="admin-selected-files"><strong>{audioFiles.length} audio file{audioFiles.length === 1 ? '' : 's'} selected</strong>{audioFiles.slice(0, 8).map((file) => <small key={file.name + file.size}>{file.name} · {formatBytes(file.size)}</small>)}{audioFiles.length > 8 && <small>+ {audioFiles.length - 8} more files</small>}</div>}
                <label>Soundtrack banner <span className="admin-field-hint">Optional wide image · recommended 1600 × 600 · JPG, PNG, or WebP · max 2 MB. For one song only; add or replace later using Edit.</span><input disabled={previewOnly || busy || audioFiles.length > 1} type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setTrackBannerFile(event.target.files?.[0] ?? null)} /></label>
                {trackBannerFile && <p className="admin-file-name">Selected soundtrack banner: {trackBannerFile.name}</p>}
                <label className="admin-check-row"><input type="checkbox" disabled={previewOnly || busy} checked={publishImmediately} onChange={(event) => setPublishImmediately(event.target.checked)} /> Publish immediately — make this album and all its tracks visible to listeners.</label>
                <label>Canvas music video <span className="admin-field-hint">Optional. Upload audio with or without Canvas; add, replace, or remove it later using Edit on the track. Attach during upload only for one song. MP4/WebM · up to 15 seconds · max 25 MB.</span><input disabled={previewOnly || busy || audioFiles.length > 1} id="admin-video-file" type="file" accept="video/mp4,video/webm,.mp4,.webm" onChange={(event) => setVideoFile(event.target.files?.[0] ?? null)} /></label>
                {videoFile && <p className="admin-file-name">Selected Canvas: {videoFile.name}</p>}
                <label>Duration in seconds <span className="admin-field-hint">Detected automatically for each song; this field is used for a single file only.</span><input disabled={previewOnly || busy || audioFiles.length !== 1} type="number" min="0" max="86400" value={trackDuration} onChange={(event) => setTrackDuration(event.target.value)} /></label>
                {uploadProgress && <p className="admin-upload-progress" role="status">{uploadProgress}</p>}
                <button type="submit" className="admin-primary-button" disabled={previewOnly || busy || !albums.length || !audioFiles.length}>{busy ? 'Uploading…' : 'Upload ' + (audioFiles.length > 1 ? audioFiles.length + ' tracks' : 'track')}</button>
              </form>
            )}
          </article>

          <div className="admin-list-panel">
            <div className="admin-panel-heading admin-track-list-heading"><div><h2>Music library</h2><p>{tracks.length} track{tracks.length === 1 ? '' : 's'} uploaded.</p></div><input aria-label="Search tracks" className="admin-search" value={trackQuery} onChange={(event) => setTrackQuery(event.target.value)} placeholder="Search tracks…" /></div>
            {editingTrack && (
              <form className="admin-edit-track" onSubmit={saveTrackEdit}>
                <div><strong>Edit track details</strong><button type="button" className="admin-text-button" onClick={() => setEditingTrack(null)}>Cancel</button></div>
                <div className="admin-form-row">
                  <label>Title<input disabled={previewOnly || busy} value={editTitle} onChange={(event) => setEditTitle(event.target.value)} required maxLength={120} /></label>
                  <label>Artist name<input disabled={previewOnly || busy} value={editTrackArtistName} onChange={(event) => setEditTrackArtistName(event.target.value)} required maxLength={120} /></label>
                  <label>Genre<input disabled={previewOnly || busy} value={editGenre} onChange={(event) => setEditGenre(event.target.value)} maxLength={60} /></label>
                  <label>Track number<input disabled={previewOnly || busy} type="number" min="1" step="1" value={editNumber} onChange={(event) => setEditNumber(event.target.value)} required /></label>
                  <label>Duration (seconds)<input disabled={previewOnly || busy} type="number" min="0" max="86400" value={editDuration} onChange={(event) => setEditDuration(event.target.value)} required /></label>
                </div>
                <label>{editingTrack.banner_url ? 'Replace soundtrack banner' : 'Add soundtrack banner'} <span className="admin-field-hint">Optional wide image · recommended 1600 × 600 · JPG, PNG, or WebP · max 2 MB.</span><input disabled={previewOnly || busy} type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setEditBannerFile(event.target.files?.[0] ?? null)} /></label>
                {editingTrack.banner_url && <p className="admin-file-name">A soundtrack banner is currently attached.</p>}
                {editBannerFile && <p className="admin-file-name">New soundtrack banner: {editBannerFile.name}</p>}
                {editingTrack.banner_url && <label className="admin-check-row"><input type="checkbox" disabled={previewOnly || busy || Boolean(editBannerFile)} checked={removeExistingBanner} onChange={(event) => setRemoveExistingBanner(event.target.checked)} /> Remove current soundtrack banner when saving</label>}
                <label>{editingTrack.video_path ? 'Replace Canvas video' : 'Add Canvas video'} <span className="admin-field-hint">{editingTrack.video_path ? 'Optional. Leave empty to keep the current video, select a file to replace it, or check below to remove it.' : 'Optional. Leave empty for an audio-only track, or select a file to add Canvas now.'} MP4/WebM · up to 15 seconds · max 25 MB.</span><input disabled={previewOnly || busy} type="file" accept="video/mp4,video/webm,.mp4,.webm" onChange={(event) => setEditVideoFile(event.target.files?.[0] ?? null)} /></label>
                {editingTrack.video_path && <p className="admin-file-name">A Canvas video is currently attached to this track.</p>}
                {editVideoFile && <p className="admin-file-name">New Canvas: {editVideoFile.name}</p>}
                {editingTrack.video_path && <label className="admin-check-row"><input type="checkbox" disabled={previewOnly || busy || Boolean(editVideoFile)} checked={removeExistingVideo} onChange={(event) => setRemoveExistingVideo(event.target.checked)} /> Remove current Canvas video when saving</label>}
                <button type="submit" className="admin-primary-button" disabled={previewOnly || busy}>Save track details</button>
              </form>
            )}
            {visibleTracks.length ? (
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead><tr><th>Track</th><th>Album</th><th>Duration</th><th>Plays</th><th>Status</th><th>Actions</th></tr></thead>
                  <tbody>{visibleTracks.map((track) => (
                    <tr key={track.id}>
                      <td><strong>{track.title}</strong><small>{track.artist_name}{track.video_path ? ' · Canvas video attached' : ''}{track.banner_url ? ' · Banner attached' : ''}</small></td>
                      <td>{track.album_title || 'Single'}</td>
                      <td>{durationLabel(track.duration_seconds)}</td>
                      <td>{Number(track.plays_count || 0).toLocaleString()}</td>
                      <td><span className={track.is_published === 1 ? 'admin-pill published' : 'admin-pill draft'}>{track.is_published === 1 ? 'Public' : 'Draft'}</span></td>
                      <td><div className="admin-row-actions"><button type="button" className="admin-text-button" onClick={() => beginEditTrack(track)}>Edit</button><button type="button" className="admin-danger-button" disabled={previewOnly || busy} onClick={() => void removeTrack(track)}>Delete</button></div></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : <div className="admin-empty">{tracks.length ? 'No tracks match your search.' : 'No tracks uploaded yet.'}</div>}
          </div>
        </div>
      )}

      <div className="admin-footer-actions"><button type="button" className="admin-secondary-button" disabled={previewOnly || busy} onClick={() => void loadData()}>Refresh catalog</button><span>Changes are saved to your DeanMusic catalog.</span></div>
    </section>
  );
}
