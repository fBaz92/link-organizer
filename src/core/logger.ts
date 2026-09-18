/*
 * Flow: logger minimale con prefisso [stash], così i due processi (web e
 * bot) scrivono sulla console in modo riconoscibile. Niente dipendenze.
 */
const PREFIX = "[stash]";

export const logger = {
  info(message: string, ...rest: unknown[]): void {
    console.log(`${PREFIX} ${message}`, ...rest);
  },
  warn(message: string, ...rest: unknown[]): void {
    console.warn(`${PREFIX} ⚠ ${message}`, ...rest);
  },
  error(message: string, ...rest: unknown[]): void {
    console.error(`${PREFIX} ✖ ${message}`, ...rest);
  },
};
