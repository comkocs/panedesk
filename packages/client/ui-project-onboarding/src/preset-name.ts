/** Keep the complete preset label within twenty Unicode characters.
 * @param name - inferred or manually entered name.
 * @returns Trimmed name, with an ellipsis included in the limit when truncated.
 */
export function presetName(name: string): string {
  const characters = Array.from(name.trim())
  return characters.length > 20 ? characters.slice(0, 19).join('') + '…' : characters.join('')
}
