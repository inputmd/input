import test from 'ava';
import { CONTENT_SECURITY_POLICY } from '../../server/config.ts';
import { reusableImageSrc } from '../../src/util.ts';

test('reusableImageSrc prefers img.src over currentSrc', (t) => {
  const image = {
    src: 'https://app.test/api/public/repos/o/r/raw?path=docs%2F.assets%2Fcat.png',
    currentSrc: 'https://cdn.example.test/transient/cat.png?token=expired',
    getAttribute(name: string) {
      return name === 'src' ? './.assets/cat.png' : null;
    },
  };

  t.is(reusableImageSrc(image), 'https://app.test/api/public/repos/o/r/raw?path=docs%2F.assets%2Fcat.png');
});

test('reusableImageSrc falls back to currentSrc and src attribute', (t) => {
  const currentOnly = {
    src: '',
    currentSrc: 'https://app.test/api/public/repos/o/r/raw?path=docs%2F.assets%2Fcat.png',
    getAttribute() {
      return null;
    },
  };
  const attributeOnly = {
    src: '',
    currentSrc: '',
    getAttribute(name: string) {
      return name === 'src' ? './.assets/cat.png' : null;
    },
  };

  t.is(reusableImageSrc(currentOnly), 'https://app.test/api/public/repos/o/r/raw?path=docs%2F.assets%2Fcat.png');
  t.is(reusableImageSrc(attributeOnly), './.assets/cat.png');
});

test('content security policy allows external https images and lightbox data urls', (t) => {
  t.true(CONTENT_SECURITY_POLICY.includes("img-src 'self' data: https:"));
});

test('content security policy allows external https fonts', (t) => {
  t.true(CONTENT_SECURITY_POLICY.includes("font-src 'self' data: blob: https:"));
});

test('content security policy allows StackBlitz frames for WebContainer', (t) => {
  t.true(CONTENT_SECURITY_POLICY.includes("frame-src 'self' https://stackblitz.com"));
});

test('content security policy allows WebAssembly execution for the terminal runtime', (t) => {
  t.true(CONTENT_SECURITY_POLICY.includes("script-src 'self'"));
  t.true(CONTENT_SECURITY_POLICY.includes("'wasm-unsafe-eval'"));
});
