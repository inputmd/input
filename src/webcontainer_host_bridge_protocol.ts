export type HostBridgeControlFrame =
  | HostBridgeReadyFrame
  | HostBridgeFatalFrame
  | HostBridgeRequestStartFrame
  | HostBridgeRequestBodyFrame
  | HostBridgeRequestEndFrame
  | HostBridgeRequestAbortFrame
  | HostBridgeResponseStartFrame
  | HostBridgeResponseBodyFrame
  | HostBridgeResponseEndFrame
  | HostBridgeResponseErrorFrame
  | HostBridgeShutdownFrame;

export interface HostBridgeReadyFrame {
  type: 'ready';
  port: number;
}

export interface HostBridgeFatalFrame {
  type: 'fatal';
  message: string;
}

export interface HostBridgeRequestStartFrame {
  type: 'request-start';
  requestId: string;
  method: string;
  targetHost: string;
  path: string;
  headers: Record<string, string>;
}

export interface HostBridgeRequestBodyFrame {
  type: 'request-body';
  requestId: string;
  chunkBase64: string;
}

export interface HostBridgeRequestEndFrame {
  type: 'request-end';
  requestId: string;
}

export interface HostBridgeRequestAbortFrame {
  type: 'request-abort';
  requestId: string;
}

export interface HostBridgeResponseStartFrame {
  type: 'response-start';
  requestId: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

export interface HostBridgeResponseBodyFrame {
  type: 'response-body';
  requestId: string;
  chunkBase64: string;
}

export interface HostBridgeResponseEndFrame {
  type: 'response-end';
  requestId: string;
}

export interface HostBridgeResponseErrorFrame {
  type: 'response-error';
  requestId: string;
  message: string;
  status?: number;
}

export interface HostBridgeShutdownFrame {
  type: 'shutdown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function encodeHostBridgeFrame(frame: HostBridgeControlFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function parseHostBridgeFrame(line: string): HostBridgeControlFrame | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || typeof parsed.type !== 'string') return null;
    return parsed as unknown as HostBridgeControlFrame;
  } catch {
    return null;
  }
}
