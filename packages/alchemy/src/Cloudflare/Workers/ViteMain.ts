import path from "node:path";

const VIRTUAL_MODULE_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/;

/** Resolve file entries from the Vite root without corrupting plugin-owned virtual ids. */
export const resolveViteMain = (
  rootDir: string,
  main: string | undefined,
): string | undefined => {
  if (main === undefined) return undefined;
  if (
    main.startsWith("\0") ||
    (!path.isAbsolute(main) &&
      !path.win32.isAbsolute(main) &&
      VIRTUAL_MODULE_SCHEME.test(main))
  ) {
    return main;
  }
  return path.resolve(rootDir, main);
};
