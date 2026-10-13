/**
 * Planner-sized step budgets.
 *
 * A planner can size a task's step budget (`maxSteps` in the task's dispatch
 * data): a lookup needs far fewer steps than a multi-file change that must
 * also run the project's checks. Each agent keeps its own range and clamps
 * the planner's number into it; anything unusable means the agent's default.
 * Progress-based extensions in AgentAbject still apply on top.
 */

import { require as precondition, ensure } from './contracts.js';

export interface StepBudgetRange {
  min: number;
  default: number;
  max: number;
}

/** The step budget for a task, given what its planner asked for. */
export function plannedStepBudget(requested: unknown, range: StepBudgetRange): number {
  precondition(range.min > 0 && range.min <= range.default && range.default <= range.max, 'step budget range is ordered');
  const n = typeof requested === 'number' ? requested : typeof requested === 'string' ? Number(requested) : NaN;
  const budget = Number.isFinite(n) ? Math.min(range.max, Math.max(range.min, Math.round(n))) : range.default;
  ensure(budget >= range.min && budget <= range.max, 'step budget lies in range');
  return budget;
}
