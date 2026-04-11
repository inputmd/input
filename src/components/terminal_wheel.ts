const DEFAULT_TERMINAL_CHAR_HEIGHT = 20;
const PIXEL_WHEEL_SCROLL_MULTIPLIER = 2;

export interface ConsumedTerminalPixelWheelDelta {
  lines: number;
  remainder: number;
}

export function consumeTerminalPixelWheelDelta(
  remainder: number,
  deltaY: number,
  charHeight: number,
): ConsumedTerminalPixelWheelDelta {
  const safeCharHeight = Number.isFinite(charHeight) && charHeight > 0 ? charHeight : DEFAULT_TERMINAL_CHAR_HEIGHT;
  const nextRemainder = remainder + (deltaY / safeCharHeight) * PIXEL_WHEEL_SCROLL_MULTIPLIER;
  const wholeLines = nextRemainder > 0 ? Math.floor(nextRemainder) : Math.ceil(nextRemainder);
  const lines = wholeLines === 0 ? 0 : wholeLines;
  return {
    lines,
    remainder: nextRemainder - lines,
  };
}
