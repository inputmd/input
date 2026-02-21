import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

// --- Types ---

interface DeviceFlowIdle {
  status: 'idle';
}
interface DeviceFlowRequesting {
  status: 'requesting';
}
interface DeviceFlowPending {
  status: 'pending';
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}
interface DeviceFlowSuccess {
  status: 'success';
  token: string;
}
interface DeviceFlowError {
  status: 'error';
  message: string;
}

export type DeviceFlowPhase =
  | DeviceFlowIdle
  | DeviceFlowRequesting
  | DeviceFlowPending
  | DeviceFlowSuccess
  | DeviceFlowError;

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  error?: string;
  error_description?: string;
}

interface TokenPollResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

// --- Hook ---

export function useDeviceFlow() {
  const [phase, setPhase] = useState<DeviceFlowPhase>({ status: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimerRef = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Clean up on unmount
  useEffect(
    () => () => {
      clearTimerRef();
      abortRef.current?.abort();
    },
    [clearTimerRef],
  );

  const pollRef = useRef<(deviceCode: string, intervalMs: number, signal: AbortSignal) => void>();
  pollRef.current = (deviceCode: string, intervalMs: number, signal: AbortSignal) => {
    clearTimerRef();
    timerRef.current = setTimeout(async () => {
      if (signal.aborted) return;
      try {
        const res = await fetch('/api/device-flow/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_code: deviceCode }),
          signal,
        });
        if (signal.aborted) return;

        if (!res.ok) {
          setPhase({ status: 'error', message: `Server error: ${res.status}` });
          return;
        }

        const data: TokenPollResponse = await res.json();

        if (data.access_token) {
          setPhase({ status: 'success', token: data.access_token });
          return;
        }

        switch (data.error) {
          case 'authorization_pending':
            pollRef.current!(deviceCode, intervalMs, signal);
            break;
          case 'slow_down':
            pollRef.current!(deviceCode, intervalMs + 5000, signal);
            break;
          case 'expired_token':
            setPhase({ status: 'error', message: 'Authorization expired. Please try again.' });
            break;
          case 'access_denied':
            setPhase({ status: 'error', message: 'Access was denied.' });
            break;
          default:
            setPhase({ status: 'error', message: data.error_description ?? 'Authorization failed.' });
        }
      } catch (err) {
        if (signal.aborted) return;
        const isNetwork = err instanceof TypeError && /fetch|network/i.test(err.message);
        setPhase({
          status: 'error',
          message: isNetwork
            ? 'Cannot reach the API server — is it running?'
            : err instanceof Error
              ? err.message
              : 'Network error.',
        });
      }
    }, intervalMs);
  };

  const start = useCallback(async () => {
    clearTimerRef();
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPhase({ status: 'requesting' });

    try {
      const res = await fetch('/api/device-flow/code', {
        method: 'POST',
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setPhase({ status: 'error', message: body?.error ?? `Server error: ${res.status}` });
        return;
      }

      const data: DeviceCodeResponse = await res.json();

      if (data.error) {
        setPhase({ status: 'error', message: data.error_description ?? data.error });
        return;
      }

      setPhase({
        status: 'pending',
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        expiresAt: Date.now() + data.expires_in * 1000,
      });

      pollRef.current!(data.device_code, data.interval * 1000, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return;
      const isNetwork = err instanceof TypeError && /fetch|network/i.test(err.message);
      setPhase({
        status: 'error',
        message: isNetwork
          ? 'Cannot reach the API server — is it running?'
          : err instanceof Error
            ? err.message
            : 'Failed to start sign-in.',
      });
    }
  }, [clearTimerRef]);

  const cancel = useCallback(() => {
    clearTimerRef();
    abortRef.current?.abort();
    setPhase({ status: 'idle' });
  }, [clearTimerRef]);

  return { phase, start, cancel };
}
