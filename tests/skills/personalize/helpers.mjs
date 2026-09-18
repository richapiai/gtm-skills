// tests/skills/personalize/helpers.mjs — the /evidence-score helpers, seen from /personalize.
//
// The substrate is defined once, in ../evidence-score/helpers.mjs, and re-exported
// here. Both directories belong to this suite, and the direction of the import mirrors
// the real dependency: /personalize consumes /evidence-score's grades, so its tests
// consume /evidence-score's fixtures. A second copy of the sandbox builder would drift
// from the first the week after somebody edits one of them.

export {
  REPO_ROOT, HERE, skillDir, skillMd, skillSource, skillBody,
  tmpRoot, cleanupTmp, validatorSandbox, runValidator,
  linkClosure, errorsFor,
  PINNED_GATES, gatesWithout, gatesFileWith,
  brief, verified, inferred, FRESH, NOW,
} from '../evidence-score/helpers.mjs';
