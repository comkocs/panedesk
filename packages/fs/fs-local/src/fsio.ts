/** Shared text decoding and legacy direct-call compatibility; provider targets carry their backend. */
export {
  applyLiteralEdit, listDirectory, localDisplayPath, normalizeLineEndings, probe, probeNoFollow,
  readForEdit, readByteWindow, readTextForDiff, readWholeBytes, readWholeText, resolveLocalTarget,
  restoreLineEndings, streamWholeText, writeFileAtomic,
} from './directory-legacy.ts'
export type {
  AuthorizeRead, FsIoInternals, LineEndings, LocalDirEntry, LocalTarget, PathInfo, PathLinkInfo,
} from './directory-legacy.ts'
