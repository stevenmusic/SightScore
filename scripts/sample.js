/**
 * Print a generated test as MusicXML: `npm run sample -- --grade 3 --seed 42`
 * Add --out <file> to write it somewhere instead of stdout.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { generateTest } from '../src/generator/generate.js';
import { toMusicXml } from '../src/generator/musicxml.js';
import { fingerprintOf } from '../src/generator/fingerprint.js';

const args = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
};

const rules = JSON.parse(
  readFileSync(fileURLToPath(new URL('../src/rules/abrsm-piano-grades.json', import.meta.url)), 'utf8'),
);

const grade = Number(valueOf('--grade', '1'));
const seedArg = valueOf('--seed', null);
const score = generateTest(rules, { grade, seed: seedArg === null ? undefined : Number(seedArg) });
const xml = toMusicXml(score);
const out = valueOf('--out', null);

if (out) {
  writeFileSync(out, xml);
  console.error(
    `Grade ${score.grade} · ${score.key.tonic} ${score.key.mode} · ${score.timeSignature.text} · `
    + `${score.barCount} bars · ${score.tempoTerm} · seed ${score.seed} · ${fingerprintOf(score)}`,
  );
  console.error(`written to ${out}`);
} else {
  process.stdout.write(`${xml}\n`);
}
