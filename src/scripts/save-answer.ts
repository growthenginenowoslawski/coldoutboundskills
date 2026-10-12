/**
 * Save one onboarding answer.
 * Run: npx tsx src/scripts/save-answer.ts <slug> <question_key> "<answer text>"
 */
import { saveAnswer } from "../db/onboarding";

const [slug, questionKey, ...rest] = process.argv.slice(2);
const answer = rest.join(" ");
if (!slug || !questionKey || !answer) {
  console.error('usage: save-answer.ts <slug> <question_key> "<answer>"');
  process.exit(1);
}
await saveAnswer(slug, questionKey, answer);
console.log(`✓ saved [${questionKey}] for ${slug}`);
