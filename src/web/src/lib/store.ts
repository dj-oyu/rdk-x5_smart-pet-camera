import { signal, action, createModel } from "@preact/signals";
import type { RecordingState } from "../hooks/useRecording";

export type MobileTab = 'live' | 'tracking' | 'album';

export const AppStore = createModel(() => {
  const viewerCount = signal("-");
  const mobileTab = signal<MobileTab>("live");
  const recordingsOpen = signal(false);
  const thumbnailPreview = signal<
    | { type: 'image'; url: string; name: string }
    | { type: 'video'; url: string; name: string }
    | null
  >(null);
  const recording = signal<RecordingState>({
    isRecording: false,
    isConverting: false,
    isStopping: false,
    statusText: '',
  });

  const setViewerCount = action((count: number) => {
    viewerCount.value = String(count);
  });

  const openRecordings = action(() => {
    recordingsOpen.value = true;
  });

  const closeRecordings = action(() => {
    recordingsOpen.value = false;
  });

  const openThumbnail = action((url: string, name: string) => {
    thumbnailPreview.value = { type: 'image', url, name };
  });

  const openVideoPlayer = action((url: string, name: string) => {
    thumbnailPreview.value = { type: 'video', url, name };
  });

  const closeThumbnail = action(() => {
    thumbnailPreview.value = null;
  });

  // Escape キー用: サムネイル → 録画モーダルの順で閉じる
  const dismissTopModal = action(() => {
    if (thumbnailPreview.value !== null) {
      thumbnailPreview.value = null;
    } else if (recordingsOpen.value) {
      recordingsOpen.value = false;
    }
  });

  return {
    viewerCount,
    mobileTab,
    recordingsOpen,
    thumbnailPreview,
    recording,
    setViewerCount,
    openRecordings,
    closeRecordings,
    openThumbnail,
    openVideoPlayer,
    closeThumbnail,
    dismissTopModal,
  };
});
