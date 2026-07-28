import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const rules = JSON.parse(
  readFileSync(fileURLToPath(new URL('../src/rules/abrsm-piano-grades.json', import.meta.url)), 'utf8'),
);

export const GRADES = Object.keys(rules.grades).map(Number).sort((a, b) => a - b);

/** Duration of a note type in divisions, given divisions-per-quarter. */
const TYPE_DURATION = {
  breve: 8, whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125, '64th': 0.0625,
};

export function expectedDuration(event, divisions) {
  const base = TYPE_DURATION[event.type] * divisions;
  const dotted = base * (2 - 1 / 2 ** (event.dots ?? 0));
  const modification = event.timeModification
    ? event.timeModification.normalNotes / event.timeModification.actualNotes
    : 1;
  return dotted * modification;
}

export function soundingEvents(bar) {
  return bar.events.filter((event) => !event.rest);
}

/**
 * Minimal XML well-formedness check: every tag closes, nesting balanced,
 * nothing after the root. Enough to catch serialiser bugs without a
 * dependency.
 */
export function assertWellFormedXml(xml) {
  const body = xml.replace(/<\?xml[^?]*\?>/g, '').replace(/<!DOCTYPE[^>]*>/g, '');
  const stack = [];
  const tagPattern = /<(\/?)([A-Za-z][\w-]*)([^>]*?)(\/?)>/g;
  let match;

  while ((match = tagPattern.exec(body)) !== null) {
    const [, closing, name, attributes, selfClosing] = match;
    if (selfClosing) continue;
    if (closing) {
      const open = stack.pop();
      if (open !== name) {
        throw new Error(`XML mismatch: </${name}> closes <${open ?? 'nothing'}>`);
      }
    } else {
      stack.push(name);
    }
    if (attributes.includes('<')) throw new Error(`malformed attributes on <${name}>`);
  }

  if (stack.length) throw new Error(`unclosed XML tags: ${stack.join(', ')}`);
}

export function countMatches(text, pattern) {
  return (text.match(pattern) ?? []).length;
}
