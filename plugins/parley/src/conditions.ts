import { canonical } from "./answers.ts"
import type { Question } from "./questions.ts"

/** Only earlier visible, answered questions can satisfy a condition; chains never resurrect hidden answers. */
export function visibleQuestions(questions: readonly Question[], value: (id: string) => unknown): Question[] {
  const visible: Question[] = []
  const ids = new Set<string>()
  for (const question of questions) {
    const condition = question.show_if
    if (condition && (!ids.has(condition.id) || value(condition.id) === undefined || canonical(value(condition.id)) !== canonical(condition.equals))) continue
    visible.push(question)
    ids.add(question.id)
  }
  return visible
}
