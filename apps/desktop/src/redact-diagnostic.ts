/** Remove authentication inputs before desktop diagnostics leave process memory. */

/**
 * Scrub URLs and named authentication fields from unstructured diagnostics.
 * @param text - Error, console, or child-process diagnostic text.
 * @returns Diagnostic text without URL queries or named authentication values.
 */
export function redactDiagnostic(text: string): string {
  return text
    .replaceAll(/\b(?:https?|wss?):\/\/[^\s'"<>]+/giu, (value) => {
      try {
        const url = new URL(value)
        url.username = ''
        url.password = ''
        url.search = url.search === '' ? '' : '?<redacted>'
        url.hash = ''
        return url.href.replaceAll('%3Credacted%3E', '<redacted>')
      } catch (_error) {
        return '<redacted>'
      }
    })
    .replaceAll(/\b(set-cookie|cookie|authorization)["']?\s*[:=]\s*[^\r\n]+/giu, '$1: <redacted>')
    .replaceAll(/\b(token|api[_-]?key)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/giu, '$1=<redacted>')
}
