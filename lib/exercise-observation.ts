import { parseExerciseDefinition } from './exercise-definition.ts';
import type { ExerciseDefinition } from './exercise-definition.ts';
import { parseBehaviorAssessment } from './behavior-assessment.ts';

/** Caller must load the immutable definition revision under tenant authorization. */
export function parseExerciseObservations(definition: ExerciseDefinition, form: FormData) {
  const rubric = parseExerciseDefinition(definition);
  const ratings = form.getAll('rating'), evidence = form.getAll('evidence');
  if (ratings.length !== rubric.criteria.length || evidence.length !== rubric.criteria.length) {
    throw new Error('Każde kryterium zadania wymaga osobnej oceny i pola uzasadnienia.');
  }
  const samples = form.getAll('workSample');
  if (samples.length !== 1 || typeof samples[0] !== 'string' || samples[0].length > 20000) {
    throw new Error('Opis lub tekst wykonanej pracy może mieć do 20 000 znaków.');
  }
  const observations = rubric.criteria.map((_, criterionIndex) => {
    const entry = new FormData();
    entry.set('rating', ratings[criterionIndex]); entry.set('evidence', evidence[criterionIndex]);
    return { criterionIndex, ...parseBehaviorAssessment(entry) };
  });
  return { workSample: samples[0].trim(), observations };
}
