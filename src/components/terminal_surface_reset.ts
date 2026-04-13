export interface ResettableTerminalSurface {
  reset(): void;
  write(data: string | Uint8Array): void;
}

const TERMINAL_SURFACE_RESET_SEQUENCE = '\x1b[2J\x1b[H\x1b[?25h';

export function resetTerminalSurface(terminal: ResettableTerminalSurface): void {
  terminal.reset();
  // Ghostty's reset recreates the emulator state but does not draw a fresh
  // frame on its own. Emit a minimal clear/home/show-cursor sequence so the
  // surface is immediately redrawn with a visible cursor.
  terminal.write(TERMINAL_SURFACE_RESET_SEQUENCE);
}
