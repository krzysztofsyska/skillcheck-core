import test from 'node:test';
import assert from 'node:assert/strict';
import { behaviorGuideDefinitions, buildBehaviorGuide } from '../lib/behavior-guide.ts';
import { behaviorAreas, requirementLevels, parsePosition } from '../lib/position-fields.ts';

test('guide covers the eight agreed areas with immutable questions and signals', () => {
  assert.equal(behaviorGuideDefinitions.length, 8);
  assert.deepEqual(behaviorGuideDefinitions.map(({ id, label }) => [id, label]), behaviorAreas);
  assert.ok(Object.isFrozen(behaviorGuideDefinitions));
  for (const area of behaviorGuideDefinitions) {
    assert.ok(Object.isFrozen(area));
    assert.ok(area.definition.trim());
    assert.equal(area.questions.length, 2);
    for (const values of [area.questions, area.positiveSignals, area.verificationSignals]) {
      assert.ok(Object.isFrozen(values));
      assert.ok(values.length >= 2);
      assert.ok(values.every(value => typeof value === 'string' && value.trim()));
    }
  }
  assert.throws(() => behaviorGuideDefinitions[0].questions.push('Zmienione pytanie'), TypeError);
  assert.throws(() => { behaviorGuideDefinitions[0].label = 'Inna etykieta'; }, TypeError);
});

test('position form requirements round trip to their exact guide areas and levels', () => {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    title: 'Specjalista', tasks: 'Obsługa klienta', kpis: 'Czas odpowiedzi', autonomy_level: '3',
  })) form.set(key, value);
  behaviorAreas.forEach(([key], index) => form.set(key, requirementLevels[index % requirementLevels.length]));
  const position = parsePosition(form);
  const guide = buildBehaviorGuide(position.required_behaviors);
  assert.deepEqual(guide.unrecognizedRequirements, []);
  assert.deepEqual(guide.areas.map(area => area.requiredLevel), behaviorAreas.map((_, index) => requirementLevels[index % requirementLevels.length]));
  assert.ok(guide.areas.every(area => area.requirementIssue === null));
});

test('all supported levels accept surrounding whitespace without mutating requirements', () => {
  for (const level of requirementLevels) {
    const entries = Object.freeze(behaviorAreas.map(([, label]) => ` \t${label}  :  ${level}\n`));
    const guide = buildBehaviorGuide(entries);
    assert.ok(guide.areas.every(area => area.requiredLevel === level && area.requirementIssue === null));
    assert.deepEqual(guide.unrecognizedRequirements, []);
    assert.ok(entries[0].startsWith(' \t'));
  }
});

test('missing and malformed requirements remain unresolved instead of using a default', () => {
  const missing = buildBehaviorGuide([]);
  assert.ok(missing.areas.every(area => area.requiredLevel === null && area.requirementIssue));
  for (const value of ['Odpowiedzialność', 'Odpowiedzialność:', 'Odpowiedzialność: Średni', 'Odpowiedzialność: wysoki', 'Odpowiedzialność: Wysoki: Krytyczny']) {
    const guide = buildBehaviorGuide([value]);
    const area = guide.areas.find(area => area.id === 'responsibility');
    assert.equal(area.requiredLevel, null);
    assert.match(area.requirementIssue, /Nieprawidłowy/);
    assert.deepEqual(guide.unrecognizedRequirements, []);
  }
});

test('identical duplicates, conflicting levels and valid-plus-invalid entries are all unresolved', () => {
  for (const duplicate of ['Odpowiedzialność: Wysoki', ' Odpowiedzialność : Wysoki ', 'Odpowiedzialność: Niski', 'Odpowiedzialność: nieznany', 'Odpowiedzialność']) {
    const guide = buildBehaviorGuide(['Odpowiedzialność: Wysoki', duplicate, 'Inicjatywa: Krytyczny']);
    const area = guide.areas.find(area => area.id === 'responsibility');
    assert.equal(area.requiredLevel, null);
    assert.match(area.requirementIssue, /więcej niż raz/);
    assert.equal(guide.areas.find(area => area.id === 'initiative').requiredLevel, 'Krytyczny');
    assert.deepEqual(guide.unrecognizedRequirements, []);
  }
});

test('unknown and similar-prefix requirements stay explicit and cannot match a known area', () => {
  const unknown = ['Odpowiedzialność za zespół: Wysoki', 'Odpowiedzialność Wysoki', 'odpowiedzialność: Wysoki', 'Nowy obszar: Niski', ''];
  const guide = buildBehaviorGuide(unknown);
  assert.deepEqual(guide.unrecognizedRequirements, unknown);
  assert.ok(guide.areas.every(area => area.requiredLevel === null && area.requirementIssue));
  const mixed = buildBehaviorGuide([...unknown, 'Odpowiedzialność: Standardowy']);
  assert.deepEqual(mixed.unrecognizedRequirements, unknown);
  assert.equal(mixed.areas.find(area => area.id === 'responsibility').requiredLevel, 'Standardowy');
});
