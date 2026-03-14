import { useEffect, useRef, useState } from 'preact/hooks';

interface ImageLightboxProps {
  src: string;
  alt: string;
  onClose: () => void;
}

export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [imageLoading, setImageLoading] = useState(true);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!src) {
      setImageLoading(false);
      return;
    }
    const image = imageRef.current;
    setImageLoading(!image?.complete);
  }, [src]);

  const onBackdropClick = (event: MouseEvent) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div class="image-lightbox" role="dialog" aria-modal="true" aria-label="Image preview" onClick={onBackdropClick}>
      <button type="button" class="image-lightbox-close" onClick={onClose} aria-label="Close image preview">
        Close
      </button>
      <img
        ref={imageRef}
        class="image-lightbox-image"
        src={src}
        alt={alt}
        data-image-loading={imageLoading ? 'true' : 'false'}
        onLoad={() => setImageLoading(false)}
        onError={() => setImageLoading(false)}
      />
    </div>
  );
}
