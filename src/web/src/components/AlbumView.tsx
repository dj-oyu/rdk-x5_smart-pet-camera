import { useEffect } from 'preact/hooks';
import { useSignal, useSignalEffect } from '@preact/signals';
import { Show } from '@preact/signals/utils';

export function AlbumView() {
  const albumSrc = useSignal('');
  const albumOffline = useSignal(false);
  const lightboxSrc = useSignal<string | null>(null);
  const lightboxMeta = useSignal<{ date?: string; pet?: string; behavior?: string; caption?: string }>({});

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(c => {
        if (c.album_url) {
          albumSrc.value = `${c.album_url.replace(/\/$/, '')}/app?embed=petcamera`;
        } else {
          albumOffline.value = true;
        }
      })
      .catch(() => { albumOffline.value = true; });
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'album-lightbox' && typeof e.data.src === 'string') {
        lightboxSrc.value = e.data.src;
        lightboxMeta.value = e.data.meta || {};
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // lightboxSrc 変更に応じて body class を切替
  useSignalEffect(() => {
    if (lightboxSrc.value) {
      document.body.classList.add('lightbox-active');
    } else {
      document.body.classList.remove('lightbox-active');
    }
    return () => document.body.classList.remove('lightbox-active');
  });

  // キーボードハンドラーは常時登録 (lightbox が開いているときだけ有効)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') lightboxSrc.value = null;
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <>
      <div class="panel album-panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>アルバム</h2>
          {albumSrc.value && <a href={albumSrc.value.split('?')[0]} target="_blank" class="album-link" title="別タブで開く">↗</a>}
        </div>
        {albumOffline.value ? (
          <div class="album-offline">アルバムサービスに接続できません</div>
        ) : (
          <iframe
            src={albumSrc.value}
            class="album-iframe"
            scrolling="auto"
            onError={() => { albumOffline.value = true; }}
          />
        )}
      </div>

      <Show when={lightboxSrc}>
        {(src) => (
          <div class="album-lightbox" onClick={() => { lightboxSrc.value = null; }}>
            <img src={src} alt="Full size" />
            <div class="album-lightbox-meta" onClick={(e) => e.stopPropagation()}>
              {lightboxMeta.value.date && <span class="album-lightbox-date">{lightboxMeta.value.date}</span>}
              {lightboxMeta.value.pet && <span class={`album-lightbox-pet ${lightboxMeta.value.pet}`}>{lightboxMeta.value.pet}</span>}
              {lightboxMeta.value.behavior && <span class="album-lightbox-behavior">{lightboxMeta.value.behavior}</span>}
              {lightboxMeta.value.caption && <p class="album-lightbox-caption">{lightboxMeta.value.caption}</p>}
            </div>
          </div>
        )}
      </Show>
    </>
  );
}
