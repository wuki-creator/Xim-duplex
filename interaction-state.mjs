import {interruptionIntent} from './turn-policy.mjs';

// An explicit observation/state baseline, not a trained or latent world model.
// It observes public dialogue events only; it cannot observe emotions or thoughts.
const MAX_INPUT = 2000;
const MAX_QUOTE = 120;
const MAX_PREFIX = 240;
const trim = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function buildInteractionContext(input = {}) {
  const {text, history, interruption} = isRecord(input) ? input : {};
  const userInput = trim(text, MAX_INPUT);
  // Apply the window before filtering so old messages cannot re-enter the context.
  const recentUserQuotes = (Array.isArray(history) ? history.slice(-10) : [])
    .filter(item => isRecord(item) && item.role === 'user' && typeof item.content === 'string')
    .slice(-3)
    .map(item => trim(item.content, MAX_QUOTE))
    .filter(Boolean);
  const phase = isRecord(interruption) && ['playing', 'generating'].includes(interruption.phase)
    ? interruption.phase : 'unknown';
  const interrupted = phase !== 'unknown';
  const heardPrefix = interrupted ? trim(interruption.heardPrefix, MAX_PREFIX) : '';
  const intent = interrupted ? interruptionIntent(userInput, {phase}) : 'unknown';
  const action = ({yield:'yield', backchannel:'acknowledge', correction:'revise', new_input:'respond'})[intent] || 'respond';
  const candidates = action === 'yield' ? ['yield'] : action === 'acknowledge' ? ['acknowledge', 'respond'] : action === 'revise' ? ['revise', 'clarify'] : ['respond', 'clarify'];
  const possibleOutcomes = {yield:'user_can_continue', acknowledge:'acknowledge_without_starting_a_task', revise:'answer_using_latest_correction', respond:'answer_current_input', clarify:'ask_for_missing_information'};

  return {
    recent_user_quotes: recentUserQuotes,
    // An absent acknowledgment never permits substituting a generated draft.
    assistant_heard: {
      state: heardPrefix ? 'observed' : 'unknown',
      prefix: heardPrefix || null,
    },
    interruption: {phase, intent: intent || 'unknown', certainty: interrupted ? 'heuristic' : 'unknown'},
    dialogue_action: {
      preferred: action,
      prediction_basis: 'rule_based_hypothesis',
      candidates: candidates.map(action => ({action, possible_outcome:possibleOutcomes[action]})),
    },
    unknown: ['user_emotion', 'physical_scene', 'task_execution_status'],
  };
}

// Place the resulting string in a user message, never concatenate it into system
// instructions. The fixed schema keeps quotes as data; the LLM must still follow
// the caller's instruction to treat quoted strings as untrusted observations.
export function formatInteractionContext(input) {
  return JSON.stringify(buildInteractionContext(input));
}
