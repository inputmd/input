import { ClientError } from '../errors';

export const MAX_ACTIVE_PER_USER = 2;
export const MAX_ACTIVE_GLOBAL = 8;
export const MAX_REPO_SIZE_MB = 300;
export const DEFAULT_COMMAND_TIMEOUT_MS = 45_000;
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export function enforceRepoSize(sizeKb: number): void {
  const sizeMb = sizeKb / 1024;
  if (sizeMb > MAX_REPO_SIZE_MB) {
    throw new ClientError(
      `Repository is too large (${Math.round(sizeMb)} MB). Maximum supported size is ${MAX_REPO_SIZE_MB} MB.`,
      400,
    );
  }
}
