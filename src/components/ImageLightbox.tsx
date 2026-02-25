import { useEffect } from 'preact/hooks';

interface ImageLightboxProps {
  src: string;
  alt: string;
  onClose: () => void;
}

export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const onBackdropClick = (event: MouseEvent) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div class="image-lightbox" role="dialog" aria-modal="true" aria-label="Image preview" onClick={onBackdropClick}>
      <button type="button" class="image-lightbox-close" onClick={onClose} aria-label="Close image preview">
        Close
      </button>
      <img class="image-lightbox-image" src={src} alt={alt} />
    </div>
  );
}
