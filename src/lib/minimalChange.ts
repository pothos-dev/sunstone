/** Smallest single-range CodeMirror change (common prefix/suffix trimmed) that turns `oldStr` into `newStr`, or `null` if they're equal. */
export function minimalChange(
  oldStr: string,
  newStr: string,
): { from: number; to: number; insert: string } | null {
  if (oldStr === newStr) return null;
  let start = 0;
  const max = Math.min(oldStr.length, newStr.length);
  while (start < max && oldStr[start] === newStr[start]) start++;
  let endOld = oldStr.length;
  let endNew = newStr.length;
  while (endOld > start && endNew > start && oldStr[endOld - 1] === newStr[endNew - 1]) {
    endOld--;
    endNew--;
  }
  return { from: start, to: endOld, insert: newStr.slice(start, endNew) };
}
