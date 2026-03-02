import { secureHeaders } from 'hono/secure-headers';

export const securityHeaders = secureHeaders({
  xFrameOptions: 'DENY',
  strictTransportSecurity: 'max-age=63072000; includeSubDomains; preload',
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'sha256-wBdtWdXsHnAU2DdByySW4LlXFAScrBvmBgkXtydwJdg='"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "https://avatars.githubusercontent.com"],
    connectSrc: ["'self'", "https://api.github.com", "https://gist.githubusercontent.com"],
    fontSrc: ["'self'"],
  },
});
