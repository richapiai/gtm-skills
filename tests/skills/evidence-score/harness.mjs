// tests/skills/evidence-score/harness.mjs — re-exports the shipped scorer.
//
// The engine lives in skills/evidence-score/score.mjs so an installed package (which has
// no tests/ directory) can run it. Tests and evals keep importing from here.

export * from '../../../skills/evidence-score/score.mjs';
export { default } from '../../../skills/evidence-score/score.mjs';
